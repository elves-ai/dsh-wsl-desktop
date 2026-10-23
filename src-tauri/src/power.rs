//! Power policy and a thread-affine Windows sleep inhibitor.
//!
//! The desktop adapter owns polling, settings error handling and the dedicated
//! worker. Create/use/drop NativeInhibitor there, and pass time from the same
//! monotonic clock (for example, Instant::elapsed) to ActivityLease.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const SETTINGS_LIMIT: u64 = 64 * 1024;
const ACTIVITY_LEASE: Duration = Duration::from_secs(30);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PowerSettings {
    // Mandatory during deserialization: missing fields must not silently
    // pick up the enabled-by-default policy.
    pub enabled: bool,
}

impl Default for PowerSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl PowerSettings {
    /// Only an absent file uses the default. Invalid/unreadable settings are an
    /// error; the adapter must keep power management disabled on that error.
    pub fn load(directory: &Path) -> Result<Self, String> {
        let file = match File::open(directory.join("power.json")) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Windows also reports PATH_NOT_FOUND when a parent component is
                // a regular file. Only genuinely missing directories use defaults.
                let mut ancestor = Some(directory);
                while let Some(path) = ancestor {
                    match fs::metadata(path) {
                        Ok(metadata) if metadata.is_dir() => return Ok(Self::default()),
                        Ok(_) => return Err("电源设置目录无效；防休眠保持关闭。".into()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            ancestor = path.parent();
                        }
                        Err(_) => return Err("无法读取电源设置目录；防休眠保持关闭。".into()),
                    }
                }
                return Ok(Self::default());
            }
            Err(_) => return Err("无法读取电源设置；防休眠保持关闭。".into()),
        };
        let mut bytes = Vec::new();
        file.take(SETTINGS_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取电源设置；防休眠保持关闭。")?;
        if bytes.len() as u64 > SETTINGS_LIMIT {
            return Err("电源设置过大；防休眠保持关闭。".into());
        }
        // Serde structs also accept JSON sequences such as [true]; settings
        // are an object, so reject that shape before typed deserialization.
        // Keep typed parsing (rather than round-tripping through Value) so
        // duplicate enabled keys are still rejected.
        if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return Err("电源设置损坏；防休眠保持关闭。".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "电源设置损坏；防休眠保持关闭。".into())
    }

    /// Callers serialize saves and change their in-memory setting only after
    /// success. Like notifications.rs, sync a uniquely created same-directory
    /// temporary file, then atomically replace the destination; never truncate it.
    pub fn save(&self, directory: &Path) -> Result<(), String> {
        fs::create_dir_all(directory).map_err(|_| "无法创建电源设置目录。")?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "无法序列化电源设置。")?;
        let (temporary, mut file) = create_temporary(directory)?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "无法写入电源设置；原设置未修改。")?;
            drop(file);
            fs::rename(&temporary.path, directory.join("power.json"))
                .map_err(|_| "无法替换电源设置；原设置未修改。")?;
            Ok(())
        })();
        drop(temporary);
        result
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

fn create_temporary(directory: &Path) -> Result<(TemporarySettings, File), String> {
    for _ in 0..16 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(".power-{}-{sequence}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((TemporarySettings { path }, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建电源设置临时文件；原设置未修改。".into()),
        }
    }
    Err("电源设置临时文件冲突；原设置未修改。".into())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PowerSnapshot {
    pub enabled: bool,
    pub active: bool,
    pub phase: String,
    pub message: String,
}

/// Inspect the session/list result, including subagents. Cached sessions do
/// not represent live work and their stale/missing running hint is ignored.
/// Validate every live row, even after finding work, so malformed data becomes
/// an unavailable observation (None), never a successful idle observation.
pub fn running_tasks(list: &Value) -> Result<bool, String> {
    let items = list
        .get("items")
        .and_then(Value::as_array)
        .ok_or("电源会话列表格式无效。")?;
    let mut running = false;
    for item in items {
        let item = item.as_object().ok_or("电源会话列表项目格式无效。")?;
        let available = item
            .get("agentAvailable")
            .and_then(Value::as_bool)
            .ok_or("电源会话可用状态格式无效。")?;
        if !available {
            continue;
        }
        let item_running = item
            .get("running")
            .and_then(Value::as_bool)
            .ok_or("电源会话运行状态格式无效。")?;
        running |= item_running;
    }
    Ok(running)
}

/// A failed observation never extends the last positive observation. A known
/// idle result clears the lease immediately, including after reconnection.
#[derive(Debug, Default)]
pub struct ActivityLease {
    last_running: Option<Duration>,
}

impl ActivityLease {
    /// now must be elapsed time from the same monotonic clock on every call.
    /// A regressing timestamp expires rather than extends an existing lease.
    /// The exact 30-second boundary is already expired.
    pub fn update(&mut self, observation: Option<bool>, now: Duration) -> bool {
        match observation {
            Some(true) => self.last_running = Some(now),
            Some(false) => self.last_running = None,
            None => {
                let valid = self
                    .last_running
                    .and_then(|last| now.checked_sub(last))
                    .is_some_and(|elapsed| elapsed < ACTIVITY_LEASE);
                if !valid {
                    self.last_running = None;
                }
            }
        }
        self.last_running.is_some()
    }
}

pub trait SleepInhibitor {
    fn set_required(&mut self, required: bool) -> Result<(), String>;
}

/// Successful native state, separate from desired policy. A failed transition
/// leaves active unchanged so the worker can retry it on the next update.
pub struct PowerGuard<I: SleepInhibitor> {
    inhibitor: I,
    active: bool,
}

impl<I: SleepInhibitor> PowerGuard<I> {
    pub fn new(inhibitor: I) -> Self {
        Self {
            inhibitor,
            active: false,
        }
    }

    pub fn set_required(&mut self, required: bool) -> Result<(), String> {
        if self.active != required {
            self.inhibitor.set_required(required)?;
            self.active = required;
        }
        Ok(())
    }

    pub fn active(&self) -> bool {
        self.active
    }
}

impl<I: SleepInhibitor> Drop for PowerGuard<I> {
    fn drop(&mut self) {
        if self.active {
            // Best effort: Drop cannot report an error. An orderly worker
            // shutdown may call set_required(false) first to report/retry it.
            let _ = self.inhibitor.set_required(false);
        }
    }
}

/// SetThreadExecutionState belongs to the calling thread. Rc in PhantomData
/// deliberately makes both this inhibitor and its PowerGuard !Send + !Sync.
#[cfg(windows)]
#[derive(Default)]
pub struct NativeInhibitor {
    _thread_affinity: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(windows)]
impl SleepInhibitor for NativeInhibitor {
    fn set_required(&mut self, required: bool) -> Result<(), String> {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        };
        let flags = if required {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        // SAFETY: no pointers are passed. The !Send/!Sync marker keeps the
        // guard on its owning worker. No display/away-mode flags are requested.
        let previous = unsafe { SetThreadExecutionState(flags) };
        if previous == 0 {
            Err(if required {
                "无法启用系统防休眠。".into()
            } else {
                "无法释放系统防休眠。".into()
            })
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{cell::RefCell, collections::VecDeque, rc::Rc};

    fn list(items: Vec<Value>) -> Value {
        json!({"items": items})
    }

    fn row(available: bool, running: bool) -> Value {
        json!({"agentAvailable": available, "running": running})
    }

    #[test]
    fn empty_or_idle_live_sessions_are_idle() {
        assert_eq!(running_tasks(&list(vec![])), Ok(false));
        assert_eq!(running_tasks(&list(vec![row(true, false)])), Ok(false));
        assert_eq!(
            running_tasks(&list(vec![row(true, false), row(true, false)])),
            Ok(false)
        );
    }

    #[test]
    fn any_running_session_including_subagents_counts() {
        let subagent = json!({"sessionId":"child", "origin":"subagent",
            "agentAvailable":true, "running":true});
        assert_eq!(
            running_tasks(&list(vec![row(true, false), row(true, true)])),
            Ok(true)
        );
        assert_eq!(
            running_tasks(&list(vec![row(true, false), subagent])),
            Ok(true)
        );
    }

    #[test]
    fn cached_sessions_are_ignored_even_with_stale_or_missing_running() {
        for cached in [
            row(false, true),
            json!({"agentAvailable":false}),
            json!({"agentAvailable":false,"running":"stale"}),
        ] {
            assert_eq!(running_tasks(&list(vec![cached.clone()])), Ok(false));
            assert_eq!(
                running_tasks(&list(vec![cached, row(true, true)])),
                Ok(true)
            );
        }
    }

    #[test]
    fn malformed_list_or_live_row_is_an_error_not_idle() {
        for invalid in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"items":null}),
            json!({"items":{}}),
            list(vec![Value::Null]),
            list(vec![json!([])]),
            list(vec![json!({})]),
            list(vec![json!({"agentAvailable":null,"running":false})]),
            list(vec![json!({"agentAvailable":"true","running":true})]),
            list(vec![json!({"agentAvailable":1,"running":false})]),
            list(vec![json!({"agentAvailable":true})]),
            list(vec![json!({"agentAvailable":true,"running":null})]),
            list(vec![json!({"agentAvailable":true,"running":"false"})]),
            list(vec![json!({"agentAvailable":true,"running":0})]),
        ] {
            assert!(running_tasks(&invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn validates_rows_after_running_match_too() {
        assert!(running_tasks(&list(vec![row(true, true), json!({})])).is_err());
        assert!(running_tasks(&list(vec![json!({}), row(true, true)])).is_err());
    }

    fn seconds(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn errors_without_a_positive_observation_never_start_a_lease() {
        let mut lease = ActivityLease::default();
        assert!(!lease.update(None, Duration::ZERO));
        assert!(!lease.update(None, seconds(100)));
        assert!(!lease.update(Some(false), seconds(101)));
        assert!(!lease.update(None, seconds(102)));
    }

    #[test]
    fn errors_keep_existing_lease_but_never_refresh_it() {
        let mut lease = ActivityLease::default();
        assert!(lease.update(Some(true), seconds(10)));
        assert!(lease.update(None, seconds(20)));
        assert!(lease.update(None, seconds(39)));
        assert!(lease.update(None, seconds(40) - Duration::from_nanos(1)));
        assert!(!lease.update(None, seconds(40)));
        assert!(!lease.update(None, seconds(41)));
        assert!(!lease.update(None, seconds(500)));
    }

    #[test]
    fn reconnect_running_refreshes_and_can_reacquire_expired_lease() {
        let mut lease = ActivityLease::default();
        assert!(lease.update(Some(true), Duration::ZERO));
        assert!(lease.update(None, seconds(29)));
        assert!(lease.update(Some(true), seconds(29)));
        assert!(lease.update(None, seconds(58)));
        assert!(!lease.update(None, seconds(59)));
        assert!(lease.update(Some(true), seconds(60)));
        assert!(lease.update(None, seconds(89)));
        assert!(!lease.update(None, seconds(90)));
    }

    #[test]
    fn successful_idle_observation_clears_immediately_even_after_reconnect() {
        let mut lease = ActivityLease::default();
        assert!(lease.update(Some(true), seconds(10)));
        assert!(!lease.update(Some(false), seconds(10)));
        assert!(!lease.update(None, seconds(11)));
        assert!(lease.update(Some(true), seconds(12)));
        assert!(lease.update(None, seconds(13)));
        assert!(!lease.update(Some(false), seconds(14)));
        assert!(!lease.update(None, seconds(15)));
    }

    #[test]
    fn clock_regression_and_very_large_elapsed_time_expire_safely() {
        let mut lease = ActivityLease::default();
        assert!(lease.update(Some(true), seconds(10)));
        assert!(!lease.update(None, seconds(9)));
        assert!(!lease.update(None, seconds(11)));
        assert!(lease.update(Some(true), Duration::ZERO));
        assert!(!lease.update(None, Duration::MAX));
        assert!(lease.update(Some(true), Duration::MAX));
        assert!(lease.update(None, Duration::MAX));
    }

    #[derive(Default)]
    struct MockState {
        calls: Vec<bool>,
        failures: VecDeque<bool>,
    }

    struct MockInhibitor(Rc<RefCell<MockState>>);

    impl SleepInhibitor for MockInhibitor {
        fn set_required(&mut self, required: bool) -> Result<(), String> {
            let mut state = self.0.borrow_mut();
            state.calls.push(required);
            if state.failures.pop_front().unwrap_or(false) {
                Err("模拟电源调用失败。".into())
            } else {
                Ok(())
            }
        }
    }

    fn mock(failures: &[bool]) -> (PowerGuard<MockInhibitor>, Rc<RefCell<MockState>>) {
        let state = Rc::new(RefCell::new(MockState {
            failures: failures.iter().copied().collect(),
            ..MockState::default()
        }));
        (PowerGuard::new(MockInhibitor(state.clone())), state)
    }

    #[test]
    fn guard_is_initially_inactive_and_only_calls_on_transitions() {
        let (mut guard, state) = mock(&[]);
        assert!(!guard.active());
        guard.set_required(false).unwrap();
        assert!(state.borrow().calls.is_empty());
        guard.set_required(true).unwrap();
        assert!(guard.active());
        guard.set_required(true).unwrap();
        guard.set_required(false).unwrap();
        assert!(!guard.active());
        guard.set_required(false).unwrap();
        drop(guard);
        assert_eq!(state.borrow().calls, vec![true, false]);
    }

    #[test]
    fn failed_acquire_does_not_mark_active_and_can_retry() {
        let (mut guard, state) = mock(&[true, false]);
        assert!(guard.set_required(true).is_err());
        assert!(!guard.active());
        guard.set_required(true).unwrap();
        assert!(guard.active());
        drop(guard);
        assert_eq!(state.borrow().calls, vec![true, true, false]);
    }

    #[test]
    fn failed_release_stays_active_and_can_retry() {
        let (mut guard, state) = mock(&[false, true, false]);
        guard.set_required(true).unwrap();
        assert!(guard.set_required(false).is_err());
        assert!(guard.active());
        guard.set_required(false).unwrap();
        assert!(!guard.active());
        drop(guard);
        assert_eq!(state.borrow().calls, vec![true, false, false]);
    }

    #[test]
    fn drop_releases_only_an_active_guard() {
        let (guard, inactive) = mock(&[]);
        drop(guard);
        assert!(inactive.borrow().calls.is_empty());
        let (mut guard, active) = mock(&[]);
        guard.set_required(true).unwrap();
        drop(guard);
        assert_eq!(active.borrow().calls, vec![true, false]);
        let (mut guard, failed_acquire) = mock(&[true]);
        assert!(guard.set_required(true).is_err());
        drop(guard);
        assert_eq!(failed_acquire.borrow().calls, vec![true]);
    }

    #[test]
    fn drop_retries_failed_release_without_panicking_if_cleanup_also_fails() {
        let (mut guard, state) = mock(&[false, true, true]);
        guard.set_required(true).unwrap();
        assert!(guard.set_required(false).is_err());
        drop(guard);
        assert_eq!(state.borrow().calls, vec![true, false, false]);
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..16 {
                let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir()
                    .join(format!("dsh-power-test-{}-{sequence}", std::process::id()));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("无法创建测试目录：{error}"),
                }
            }
            panic!("测试目录冲突");
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn settings_default_and_missing_file_are_enabled_without_writing() {
        let directory = TestDirectory::new();
        assert!(PowerSettings::default().enabled);
        assert_eq!(
            PowerSettings::load(&directory.0).unwrap(),
            PowerSettings { enabled: true }
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
        assert!(
            PowerSettings::load(&directory.0.join("missing"))
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn settings_round_trip_replace_and_remain_independent_of_notifications() {
        let directory = TestDirectory::new();
        let notifications = directory.0.join("notifications.json");
        fs::write(&notifications, b"notification sentinel").unwrap();
        for enabled in [false, true, false] {
            let settings = PowerSettings { enabled };
            settings.save(&directory.0).unwrap();
            assert_eq!(PowerSettings::load(&directory.0).unwrap(), settings);
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(directory.0.join("power.json")).unwrap())
                    .unwrap(),
                json!({"enabled":enabled})
            );
            assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
        }
        assert_eq!(fs::read(notifications).unwrap(), b"notification sentinel");
    }

    #[test]
    fn save_creates_missing_directory() {
        let directory = TestDirectory::new();
        let nested = directory.0.join("a").join("b");
        PowerSettings { enabled: false }.save(&nested).unwrap();
        assert!(!PowerSettings::load(&nested).unwrap().enabled);
    }

    #[test]
    fn corrupt_settings_never_silently_enable() {
        let directory = TestDirectory::new();
        for invalid in [
            "",
            "{",
            "null",
            "[]",
            "[true]",
            "[false]",
            "{}",
            "{\"enabled\":null}",
            "{\"enabled\":\"false\"}",
            "{\"enabled\":1}",
            "{\"enabled\":false,\"enabled\":true}",
            "{\"enabled\":false,\"unknown\":true}",
            "{\"enabled\":false} trailing",
        ] {
            fs::write(directory.0.join("power.json"), invalid).unwrap();
            let error = PowerSettings::load(&directory.0).unwrap_err();
            assert!(error.contains("损坏"), "accepted {invalid}: {error}");
        }
        fs::write(directory.0.join("power.json"), [0xff, 0xfe]).unwrap();
        assert!(PowerSettings::load(&directory.0).is_err());
    }

    #[test]
    fn settings_limit_is_bounded_and_inclusive() {
        let directory = TestDirectory::new();
        let mut bytes = b"{\"enabled\":false}".to_vec();
        bytes.resize(SETTINGS_LIMIT as usize, b' ');
        fs::write(directory.0.join("power.json"), &bytes).unwrap();
        assert!(!PowerSettings::load(&directory.0).unwrap().enabled);
        bytes.push(b' ');
        fs::write(directory.0.join("power.json"), &bytes).unwrap();
        assert!(PowerSettings::load(&directory.0)
            .unwrap_err()
            .contains("过大"));
    }

    #[test]
    fn replacement_failure_keeps_original_and_cleans_temporary_file() {
        let directory = TestDirectory::new();
        // A directory cannot be replaced by the temporary regular file.
        let destination = directory.0.join("power.json");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("sentinel"), b"untouched").unwrap();
        assert!(PowerSettings::default().save(&directory.0).is_err());
        assert_eq!(
            fs::read(destination.join("sentinel")).unwrap(),
            b"untouched"
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        assert!(PowerSettings::load(&directory.0).is_err());
    }

    #[test]
    fn invalid_settings_directory_returns_error_without_modification() {
        let directory = TestDirectory::new();
        let file = directory.0.join("not-a-directory");
        fs::write(&file, b"untouched").unwrap();
        assert!(PowerSettings::default().save(&file).is_err());
        assert!(PowerSettings::load(&file).is_err());
        assert!(PowerSettings::load(&file.join("missing-child")).is_err());
        let missing_directory = directory.0.join("missing-directory").join("child");
        assert!(PowerSettings::load(&missing_directory).unwrap().enabled);
        assert!(!missing_directory.exists());
        assert_eq!(fs::read(file).unwrap(), b"untouched");
    }

    #[test]
    fn snapshot_contract_serializes_and_compares_all_fields() {
        let snapshot = PowerSnapshot {
            enabled: true,
            active: false,
            phase: "idle".into(),
            message: "当前没有运行中的任务。".into(),
        };
        assert_eq!(snapshot.clone(), snapshot);
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            json!({"enabled":true,"active":false,"phase":"idle",
                "message":"当前没有运行中的任务。"})
        );
        let mut changed = snapshot.clone();
        changed.active = true;
        assert_ne!(changed, snapshot);
    }
}
