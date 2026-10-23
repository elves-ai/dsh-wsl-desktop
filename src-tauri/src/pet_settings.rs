//! Pure pet preferences; no chat, credentials, binding or window dependency.
//! Native owner serializes saves, owns current visibility/revision in memory,
//! and initializes visibility from startup_visible, never from assistant binding.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const SETTINGS_LIMIT: u64 = 4096;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PetPreferences {
    pub startup_visible: bool,
    pub roaming_enabled: bool,
    #[serde(default = "default_bubble_notifications")]
    pub bubble_notifications: bool,
}

fn default_bubble_notifications() -> bool {
    true
}

impl Default for PetPreferences {
    fn default() -> Self {
        Self {
            startup_visible: false,
            roaming_enabled: true,
            bubble_notifications: true,
        }
    }
}

impl PetPreferences {
    /// Merge only supplied fields; false means no save/revision change is needed.
    pub fn apply_patch(&mut self, patch: &PetSettingsPatch) -> bool {
        let previous = *self;
        if let Some(value) = patch.startup_visible {
            self.startup_visible = value;
        }
        if let Some(value) = patch.roaming_enabled {
            self.roaming_enabled = value;
        }
        if let Some(value) = patch.bubble_notifications {
            self.bubble_notifications = value;
        }
        *self != previous
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PetSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roaming_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bubble_notifications: Option<bool>,
}

/// Native/web snapshot only: never pass this type to the preferences store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PetSettingsSnapshot {
    pub visible: bool,
    /// Current pet-window state only; not part of persisted preferences.
    pub always_on_top: bool,
    pub startup_visible: bool,
    pub roaming_enabled: bool,
    pub bubble_notifications: bool,
    pub revision: u64,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitlebarPetState {
    pub visible: bool,
    pub revision: u64,
}

#[derive(Clone, Debug)]
pub struct PreferencesStore {
    path: PathBuf,
}

impl PreferencesStore {
    /// Takes a complete FILE path, for example settings_dir.join("pet.json").
    /// Does not create directories until save.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Only a genuinely missing file defaults; invalid/unreadable data errors.
    /// Never repairs, resets or writes anything.
    pub fn load(&self) -> Result<PetPreferences, String> {
        Ok(self
            .read_existing()?
            .map(|(settings, _)| settings)
            .unwrap_or_default())
    }

    /// Refuses to overwrite corrupt existing data, even after an ignored load
    /// error. Callers serialize saves and publish in-memory changes on success.
    /// Persists exactly three bools, never current visibility or runtime messages.
    pub fn save(&self, preferences: &PetPreferences) -> Result<(), String> {
        let existing = self.read_existing()?;
        let bytes = serde_json::to_vec_pretty(preferences)
            .map_err(|_| "无法序列化桌宠偏好。".to_string())?;
        if existing.as_ref().is_some_and(|(_, old)| old == &bytes) {
            return Ok(());
        }
        let parent = self.parent();
        fs::create_dir_all(parent).map_err(|_| "无法创建桌宠偏好目录。".to_string())?;
        let (temporary, mut file) = create_temporary(parent)?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "无法写入桌宠偏好；原设置未替换。".to_string())?;
            drop(file);
            atomic_replace(&temporary.path, &self.path)
                .map_err(|_| "无法替换桌宠偏好；原设置未替换。".to_string())?;
            // No fallible operations after the commit: an Err must never mean
            // that the new preferences were already published on disk.
            #[cfg(unix)]
            if let Ok(directory) = File::open(parent) {
                let _ = directory.sync_all();
            }
            Ok(())
        })();
        drop(temporary);
        result
    }

    fn parent(&self) -> &Path {
        self.path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
    }

    fn read_existing(&self) -> Result<Option<(PetPreferences, Vec<u8>)>, String> {
        if self.path.file_name().is_none() {
            return Err("桌宠偏好文件路径无效。".into());
        }
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Windows PATH_NOT_FOUND can mean a parent is a regular file.
                // Defaults require the nearest existing ancestor to be a directory.
                let mut ancestor = Some(self.parent());
                while let Some(path) = ancestor {
                    match fs::metadata(path) {
                        Ok(metadata) if metadata.is_dir() => return Ok(None),
                        Ok(_) => return Err("桌宠偏好目录无效。".into()),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            ancestor = path.parent().filter(|p| !p.as_os_str().is_empty());
                        }
                        Err(_) => return Err("无法读取桌宠偏好目录。".into()),
                    }
                }
                return Ok(None);
            }
            Err(_) => return Err("无法读取桌宠偏好。".into()),
        };
        let mut bytes = Vec::new();
        file.take(SETTINGS_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取桌宠偏好。".to_string())?;
        if bytes.len() as u64 > SETTINGS_LIMIT {
            return Err("桌宠偏好文件过大；原文件未修改。".into());
        }
        // Typed serde structs also accept positional arrays: require an object.
        // Parse bytes directly so duplicate fields are not silently collapsed.
        if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return Err("桌宠偏好损坏；原文件未修改。".into());
        }
        let settings = serde_json::from_slice(&bytes)
            .map_err(|_| "桌宠偏好损坏或包含未知字段；原文件未修改。".to_string())?;
        Ok(Some((settings, bytes)))
    }
}

struct TemporarySettings {
    path: PathBuf,
}
impl Drop for TemporarySettings {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn create_temporary(parent: &Path) -> Result<(TemporarySettings, File), String> {
    for _ in 0..32 {
        let path = parent.join(format!(
            ".pet-preferences-{}-{}.tmp",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => return Ok((TemporarySettings { path }, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建桌宠偏好临时文件；原设置未替换。".into()),
        }
    }
    Err("桌宠偏好临时文件冲突；原设置未替换。".into())
}

#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let wide = |path: &Path| -> io::Result<Vec<u16>> {
        let mut result: Vec<u16> = path.as_os_str().encode_wide().collect();
        if result.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in settings path",
            ));
        }
        result.push(0);
        Ok(result)
    };
    let from = wide(from)?;
    let to = wide(to)?;
    // REPLACE_EXISTING | WRITE_THROUGH. Never remove/truncate the old file first.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-pet-settings-test-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> PreferencesStore {
            PreferencesStore::new(self.0.join("pet.json"))
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_and_directory_default_without_writing() {
        let directory = TestDirectory::new();
        let store = PreferencesStore::new(directory.0.join("not-created/pet.json"));
        assert_eq!(store.load().unwrap(), PetPreferences::default());
        assert!(!store.path.exists());
        assert!(!directory.0.join("not-created").exists());
        assert_eq!(
            PetPreferences::default(),
            PetPreferences {
                startup_visible: false,
                roaming_enabled: true,
                bubble_notifications: true,
            }
        );
    }

    #[test]
    fn patch_single_fields_do_not_overwrite_other_fields() {
        let mut preferences = PetPreferences::default();
        let startup: PetSettingsPatch =
            serde_json::from_value(json!({"startup_visible": true})).unwrap();
        assert!(preferences.apply_patch(&startup));
        assert!(preferences.startup_visible);
        assert!(preferences.roaming_enabled);
        let roaming: PetSettingsPatch =
            serde_json::from_value(json!({"roaming_enabled": false})).unwrap();
        assert!(preferences.apply_patch(&roaming));
        assert!(preferences.startup_visible);
        assert!(!preferences.roaming_enabled);
        assert!(preferences.apply_patch(&PetSettingsPatch {
            startup_visible: Some(false),
            roaming_enabled: None,
            bubble_notifications: None,
        }));
        assert!(!preferences.startup_visible);
        assert!(!preferences.roaming_enabled);
        assert!(preferences.bubble_notifications);
        let bubble: PetSettingsPatch =
            serde_json::from_value(json!({"bubble_notifications": false})).unwrap();
        assert!(preferences.apply_patch(&bubble));
        assert!(!preferences.startup_visible);
        assert!(!preferences.roaming_enabled);
        assert!(!preferences.bubble_notifications);
        assert_eq!(
            serde_json::to_value(bubble).unwrap(),
            json!({"bubble_notifications": false})
        );
        assert!(preferences.apply_patch(&startup));
        assert!(preferences.startup_visible);
        assert!(!preferences.roaming_enabled);
        assert!(!preferences.bubble_notifications);
        assert!(preferences.apply_patch(&PetSettingsPatch {
            roaming_enabled: Some(true),
            ..PetSettingsPatch::default()
        }));
        assert!(preferences.startup_visible);
        assert!(preferences.roaming_enabled);
        assert!(!preferences.bubble_notifications);
        assert!(!preferences.apply_patch(&bubble));
    }

    #[test]
    fn empty_and_unchanged_patch_are_no_ops() {
        let mut preferences = PetPreferences::default();
        let empty: PetSettingsPatch = serde_json::from_str("{}").unwrap();
        assert!(!preferences.apply_patch(&empty));
        assert_eq!(serde_json::to_value(empty).unwrap(), json!({}));
        assert!(!preferences.apply_patch(&PetSettingsPatch {
            startup_visible: Some(false),
            roaming_enabled: Some(true),
            bubble_notifications: Some(true),
        }));
        assert_eq!(preferences, PetPreferences::default());
    }

    #[test]
    fn patch_rejects_unknown_fields_and_wrong_types() {
        for invalid in [
            r#"{"visible":true}"#,
            r#"{"token":"secret"}"#,
            r#"{"startup_visible":"true"}"#,
            r#"{"roaming_enabled":1}"#,
            r#"{"bubble_notifications":"false"}"#,
            r#"{"bubble_notifications":0}"#,
            r#"{"bubble_notifications":[]}"#,
            r#"{"bubble_notifications":{}}"#,
            r#"{"bubble_notifications":true,"bubble_notifications":false}"#,
            r#"{"startup_visible":true,"startup_visible":false}"#,
        ] {
            assert!(
                serde_json::from_str::<PetSettingsPatch>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn invalid_data_errors_and_is_never_overwritten() {
        let directory = TestDirectory::new();
        let store = directory.store();
        for invalid in [
            "",
            "{",
            "null",
            "[false,true]",
            "[false,true,true]",
            "{}",
            r#"{"startup_visible":true}"#,
            r#"{"roaming_enabled":true}"#,
            r#"{"roaming_enabled":true,"bubble_notifications":true}"#,
            r#"{"startup_visible":false,"bubble_notifications":true}"#,
            r#"{"startup_visible":false,"roaming_enabled":"yes"}"#,
            r#"{"startup_visible":false,"roaming_enabled":true,"credential":"secret"}"#,
            r#"{"startup_visible":false,"startup_visible":true,"roaming_enabled":true}"#,
        ] {
            fs::write(&store.path, invalid).unwrap();
            assert!(store.load().is_err(), "{invalid}");
            let error = store.save(&PetPreferences::default()).unwrap_err();
            assert!(!error.contains("secret"));
            assert_eq!(fs::read(&store.path).unwrap(), invalid.as_bytes());
            assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        }
    }

    #[test]
    fn legacy_two_bool_file_defaults_bubbles_without_writing_back() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let legacy = b"{\n  \"startup_visible\": true,\n  \"roaming_enabled\": false\n}\n";
        fs::write(&store.path, legacy).unwrap();
        let modified = fs::metadata(&store.path).unwrap().modified().unwrap();
        assert_eq!(
            store.load().unwrap(),
            PetPreferences {
                startup_visible: true,
                roaming_enabled: false,
                bubble_notifications: true,
            }
        );
        assert_eq!(fs::read(&store.path).unwrap(), legacy);
        assert_eq!(
            fs::metadata(&store.path).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn first_explicit_legacy_change_saves_three_bool_fields() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let legacy = br#"{"startup_visible":true,"roaming_enabled":false}"#;
        fs::write(&store.path, legacy).unwrap();
        let mut preferences = store.load().unwrap();
        assert!(!preferences.apply_patch(&PetSettingsPatch::default()));
        assert_eq!(fs::read(&store.path).unwrap(), legacy);
        assert!(preferences.apply_patch(&PetSettingsPatch {
            bubble_notifications: Some(false),
            ..PetSettingsPatch::default()
        }));
        store.save(&preferences).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&store.path).unwrap()).unwrap();
        assert_eq!(
            saved,
            json!({"startup_visible": true, "roaming_enabled": false, "bubble_notifications": false})
        );
        assert_eq!(store.load().unwrap(), preferences);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn non_bool_bubble_preferences_are_rejected_and_preserved() {
        let directory = TestDirectory::new();
        let store = directory.store();
        for invalid in [json!(null), json!("true"), json!(1), json!([]), json!({})] {
            let bytes = serde_json::to_vec(&json!({
                "startup_visible": false,
                "roaming_enabled": true,
                "bubble_notifications": invalid,
            }))
            .unwrap();
            fs::write(&store.path, &bytes).unwrap();
            assert!(store.load().is_err(), "{invalid}");
            assert!(store.save(&PetPreferences::default()).is_err(), "{invalid}");
            assert_eq!(fs::read(&store.path).unwrap(), bytes);
            assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        }
    }

    #[test]
    fn oversized_file_is_preserved() {
        let directory = TestDirectory::new();
        let store = directory.store();
        let bytes = vec![b' '; SETTINGS_LIMIT as usize + 1];
        fs::write(&store.path, &bytes).unwrap();
        assert!(store.load().is_err());
        assert!(store.save(&PetPreferences::default()).is_err());
        assert_eq!(fs::read(&store.path).unwrap(), bytes);
    }

    #[test]
    fn save_creates_parent_and_atomically_replaces_existing_settings() {
        let directory = TestDirectory::new();
        let store = PreferencesStore::new(directory.0.join("nested/pet.json"));
        store.save(&PetPreferences::default()).unwrap();
        for index in 0..16 {
            let expected = PetPreferences {
                startup_visible: index % 2 == 0,
                roaming_enabled: index % 2 != 0,
                bubble_notifications: index % 3 == 0,
            };
            store.save(&expected).unwrap();
            assert_eq!(store.load().unwrap(), expected);
            assert_eq!(fs::read_dir(store.parent()).unwrap().count(), 1);
        }
        let previous = fs::read(&store.path).unwrap();
        let modified = fs::metadata(&store.path).unwrap().modified().unwrap();
        store.save(&store.load().unwrap()).unwrap();
        assert_eq!(fs::read(&store.path).unwrap(), previous);
        assert_eq!(
            fs::metadata(&store.path).unwrap().modified().unwrap(),
            modified
        );
    }

    #[test]
    fn concurrent_reader_only_observes_complete_old_or_new_files() {
        use std::sync::{atomic::AtomicBool, Arc, Barrier};
        let directory = TestDirectory::new();
        let store = directory.store();
        let first = PetPreferences {
            startup_visible: true,
            roaming_enabled: true,
            bubble_notifications: true,
        };
        let second = PetPreferences {
            startup_visible: false,
            roaming_enabled: false,
            bubble_notifications: false,
        };
        store.save(&first).unwrap();
        let start = Arc::new(Barrier::new(2));
        let done = Arc::new(AtomicBool::new(false));
        let reader_start = Arc::clone(&start);
        let reader_done = Arc::clone(&done);
        let path = store.path.clone();
        let reader = std::thread::spawn(move || {
            reader_start.wait();
            let mut reads = 0;
            while !reader_done.load(Ordering::Acquire) || reads == 0 {
                // Direct read, not load: a missing intermediate file must not
                // accidentally pass by being interpreted as defaults.
                let bytes = fs::read(&path).unwrap();
                let value: PetPreferences = serde_json::from_slice(&bytes).unwrap();
                assert!(value == first || value == second);
                reads += 1;
            }
            reads
        });
        start.wait();
        let mut result = Ok(());
        for index in 0..32 {
            result = store.save(if index % 2 == 0 { &second } else { &first });
            if result.is_err() {
                break;
            }
        }
        done.store(true, Ordering::Release);
        assert!(reader.join().unwrap() > 0);
        result.unwrap();
    }

    #[test]
    fn failed_atomic_replace_preserves_destination_and_cleans_temporary() {
        let directory = TestDirectory::new();
        let destination = directory.0.join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), b"original").unwrap();
        let (temporary, mut file) = create_temporary(&directory.0).unwrap();
        file.write_all(b"replacement").unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert!(atomic_replace(&temporary.path, &destination).is_err());
        let temp_path = temporary.path.clone();
        drop(temporary);
        assert!(!temp_path.exists());
        assert_eq!(fs::read(destination.join("keep")).unwrap(), b"original");
    }

    #[test]
    fn invalid_target_or_parent_is_not_missing() {
        let directory = TestDirectory::new();
        let as_directory = PreferencesStore::new(directory.0.join("directory"));
        fs::create_dir(&as_directory.path).unwrap();
        assert!(as_directory.load().is_err());
        assert!(as_directory.save(&PetPreferences::default()).is_err());
        let parent_file = directory.0.join("regular-file");
        fs::write(&parent_file, b"original").unwrap();
        let bad_parent = PreferencesStore::new(parent_file.join("nested/pet.json"));
        assert!(bad_parent.load().is_err());
        assert!(bad_parent.save(&PetPreferences::default()).is_err());
        assert_eq!(fs::read(parent_file).unwrap(), b"original");
    }

    #[test]
    fn persisted_shape_is_only_three_bools_not_runtime_state_or_secrets() {
        let directory = TestDirectory::new();
        let store = directory.store();
        store.save(&PetPreferences::default()).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&store.path).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"startup_visible": false, "roaming_enabled": true, "bubble_notifications": true})
        );
        assert_eq!(value.as_object().unwrap().len(), 3);
        let snapshot = PetSettingsSnapshot {
            visible: true,
            always_on_top: false,
            startup_visible: false,
            roaming_enabled: true,
            bubble_notifications: true,
            revision: 7,
            message: "runtime only".into(),
        };
        assert_ne!(snapshot.visible, store.load().unwrap().startup_visible);
        assert_eq!(
            serde_json::to_value(TitlebarPetState {
                visible: true,
                revision: 7
            })
            .unwrap(),
            json!({"visible": true, "revision": 7})
        );
        assert_eq!(store.load().unwrap(), PetPreferences::default());
    }
}
