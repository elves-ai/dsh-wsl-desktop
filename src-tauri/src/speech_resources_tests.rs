use super::*;
use crate::speech_settings::{
    Inspection, ManagedSession, ModelState, ServiceState, ServiceStatus, SpeechAction,
};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct SpeechRuntime;
impl crate::speech_settings::Runtime for SpeechRuntime {
    fn distribution(&self) -> Option<String> {
        Some("fixture".into())
    }
    fn inspect(
        &self,
        _: &SpeechConfig,
        _: &Cancellation,
        _: &dyn Fn(u8),
    ) -> Result<Inspection, String> {
        Ok(Inspection {
            environment_ok: true,
            models_ok: true,
            gpu_name: None,
            error: None,
        })
    }
    fn status(&self, _: &Cancellation) -> Result<ServiceStatus, String> {
        Ok(ServiceStatus {
            identity_valid: false,
            instance_id: None,
            service_state: ServiceState::Stopped,
            model_state: ModelState::Unloaded,
            gpu_name: None,
        })
    }
    fn start(&self, _: &SpeechConfig, _: &Cancellation) -> Result<ManagedSession, String> {
        Err("fixture start".into())
    }
    fn prepare(&self, _: &ManagedSession, cancel: &Cancellation) -> Result<ServiceStatus, String> {
        self.status(cancel)
    }
    fn stop(&self, _: &ManagedSession) -> Result<(), String> {
        Ok(())
    }
}
fn speech() -> SpeechManager {
    let path = std::env::temp_dir().join(format!(
        "dsh-resource-fixture-{}-{}-missing.json",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    SpeechManager::new(path, Arc::new(SpeechRuntime), None).unwrap()
}
#[derive(Default)]
struct Fixture {
    gate: Mutex<bool>,
    changed: Condvar,
    fail: bool,
}
impl Fixture {
    fn release(&self) {
        *self.gate.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
impl Runtime for Fixture {
    fn discover(&self, config: &SpeechConfig) -> Result<Discovery, String> {
        Ok(Discovery {
            python_environments: vec![],
            model_dir: config.model_dir.clone(),
            native_lib: config.native_lib.clone(),
        })
    }
    fn browse(&self, path: Option<String>, _: PathKind) -> Result<Directory, String> {
        Ok(Directory {
            path: path.unwrap_or("/home/fixture".into()),
            parent: None,
            entries: vec![],
            truncated: false,
        })
    }
    fn download(
        &self,
        _: &str,
        cancel: &Cancellation,
        progress: &dyn Fn(Progress),
    ) -> Result<(), String> {
        progress(Progress {
            file: Some("qwen-talker-1.7b-base-Q8_0.gguf".into()),
            downloaded_bytes: 2,
            total_bytes: None,
        });
        let mut gate = self.gate.lock().unwrap();
        while !*gate && !cancel.is_cancelled() {
            gate = self
                .changed
                .wait_timeout(gate, Duration::from_millis(10))
                .unwrap()
                .0;
        }
        cancel.check()?;
        if self.fail {
            return Err("下载失败，可重试。".into());
        }
        progress(Progress {
            file: None,
            downloaded_bytes: 3,
            total_bytes: Some(3),
        });
        Ok(())
    }
}
fn manager(fixture: Arc<Fixture>) -> Manager {
    Manager::new(fixture, Arc::new(|_| {}))
}
fn terminal(manager: &Manager) -> DownloadStatus {
    let mut state = manager.shared.state.lock().unwrap();
    while state.status.status == DownloadState::Downloading {
        let (next, timeout) = manager
            .shared
            .changed
            .wait_timeout(state, Duration::from_secs(3))
            .unwrap();
        assert!(!timeout.timed_out(), "fixture worker must finish");
        state = next;
    }
    state.status.clone()
}
#[test]
fn paths_are_data_and_schema_is_closed() {
    assert!(validate_path("/home/user/a ; $(not-a-shell)", false).is_ok());
    for value in [
        "relative",
        "//home",
        "/home/../root",
        "/home/",
        "/home/./x",
        "/mnt/c:x",
        "/home/a\nb",
    ] {
        assert!(validate_path(value, false).is_err());
    }
    assert!(validate_path("/", true).is_ok());
    assert!(validate_path("/", false).is_err());
    assert!(serde_json::from_str::<PathKind>(r#""model_dir""#).is_ok());
    assert!(serde_json::from_str::<PathKind>(r#""shell""#).is_err());
    assert!(serde_json::from_value::<Progress>(
        serde_json::json!({"file":null,"downloaded_bytes":1,"total_bytes":null,"shell":"bad"})
    )
    .is_err());
}
#[test]
fn download_success_is_separate_and_does_not_replace_config() {
    let speech = speech();
    let before = speech.get_snapshot();
    let fixture = Arc::new(Fixture::default());
    fixture.release();
    let manager = manager(fixture);
    assert_eq!(manager.snapshot().status, DownloadState::Idle);
    assert_eq!(
        manager
            .start("/home/fixture/models".into(), &speech)
            .unwrap()
            .id,
        1
    );
    let status = terminal(&manager);
    assert_eq!(status.status, DownloadState::Completed);
    assert_eq!(status.total_bytes, Some(3));
    assert_eq!(speech.get_snapshot(), before);
    assert!(speech.begin_resource_download().is_ok());
}
#[test]
fn download_excludes_save_check_explicit_and_automatic_start() {
    let speech = speech();
    let manager = manager(Arc::new(Fixture::default()));
    manager
        .start("/home/fixture/models".into(), &speech)
        .unwrap();
    let paths = SpeechConfig {
        python_path: "/usr/bin/python3".into(),
        model_dir: "/home/models".into(),
        native_lib: "/home/libqwen.so".into(),
    };
    assert!(speech.save_config(paths).unwrap_err().contains("下载"));
    assert!(speech
        .action(SpeechAction::Check)
        .unwrap_err()
        .contains("下载"));
    assert!(speech
        .action(SpeechAction::Start)
        .unwrap_err()
        .contains("下载"));
    assert!(speech
        .ensure_ready("fixture-request")
        .unwrap_err()
        .contains("下载"));
    assert!(speech.action(SpeechAction::CancelCheck).is_ok());
    assert!(manager.start("/home/other".into(), &speech).is_err());
    assert!(speech.action(SpeechAction::Stop).is_ok());
    manager.cancel();
    assert_eq!(terminal(&manager).status, DownloadState::Cancelled);
}
#[test]
fn cancellation_is_idempotent_releases_lease_and_allows_retry() {
    let speech = speech();
    let fixture = Arc::new(Fixture::default());
    let manager = manager(fixture.clone());
    manager
        .start("/home/fixture/models".into(), &speech)
        .unwrap();
    assert_eq!(manager.cancel().id, 1);
    manager.cancel();
    let cancelled = terminal(&manager);
    assert_eq!(cancelled.status, DownloadState::Cancelled);
    assert!(cancelled.error.is_none());
    fixture.release();
    let next = manager
        .start("/home/fixture/models".into(), &speech)
        .unwrap();
    assert_eq!(next.id, 2);
    assert_eq!(terminal(&manager).status, DownloadState::Completed);
}
#[test]
fn failed_download_releases_admission_and_does_not_persist() {
    let speech = speech();
    let manager = manager(Arc::new(Fixture {
        gate: Mutex::new(true),
        changed: Condvar::new(),
        fail: true,
    }));
    manager
        .start("/home/fixture/models".into(), &speech)
        .unwrap();
    assert_eq!(terminal(&manager).status, DownloadState::Error);
    assert!(speech.begin_resource_download().is_ok());
    assert!(!speech.get_snapshot().configured);
}
#[test]
fn shutdown_cancels_drains_and_refuses_late_retry() {
    let speech = speech();
    let manager = manager(Arc::new(Fixture::default()));
    manager
        .start("/home/fixture/models".into(), &speech)
        .unwrap();
    manager.shutdown();
    assert_eq!(manager.snapshot().status, DownloadState::Cancelled);
    assert!(speech.begin_resource_download().is_ok());
    assert!(manager
        .start("/home/fixture/models".into(), &speech)
        .is_err());
}
#[test]
fn lease_rejects_another_download_and_checks_until_dropped() {
    let speech = speech();
    let lease = speech.begin_resource_download().unwrap();
    assert!(speech.begin_resource_download().is_err());
    assert!(speech.action(SpeechAction::Start).is_err());
    drop(lease);
    assert!(speech.begin_resource_download().is_ok());
}
#[test]
fn resource_discovery_never_mutates_speech_config() {
    let manager = manager(Arc::new(Fixture::default()));
    let config = SpeechConfig {
        model_dir: "/home/existing".into(),
        native_lib: "/opt/libqwen.so".into(),
        python_path: "/usr/bin/python3".into(),
    };
    let found = manager.discover(&config).unwrap();
    assert_eq!(found.model_dir, config.model_dir);
    assert_eq!(found.native_lib, config.native_lib);
    assert!(manager
        .browse(Some("../../etc".into()), PathKind::ModelDir)
        .is_err());
    assert_eq!(
        manager.browse(None, PathKind::ModelDir).unwrap().path,
        "/home/fixture"
    );
}
