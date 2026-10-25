use super::*;
use crate::speech_settings::{
    Inspection, ManagedSession, ModelState, ServiceState, ServiceStatus, SpeechAction,
};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
#[test]
fn discovery_protocol_roundtrips_gpu_vendors_and_python_statuses() {
    let vendors = [
        (GpuVendor::Amd, "amd"),
        (GpuVendor::Nvidia, "nvidia"),
        (GpuVendor::Mixed, "mixed"),
        (GpuVendor::Intel, "intel"),
        (GpuVendor::Unknown, "unknown"),
    ];
    let statuses = [
        (PythonStatus::Ready, "ready"),
        (PythonStatus::PythonTooOld, "python_too_old"),
        (PythonStatus::MissingRocmSdk, "missing_rocm_sdk"),
        (PythonStatus::MissingCudaRuntime, "missing_cuda_runtime"),
        (PythonStatus::MissingGpuRuntime, "missing_gpu_runtime"),
        (PythonStatus::UnsupportedBackend, "unsupported_backend"),
        (PythonStatus::GpuUnknown, "gpu_unknown"),
        (PythonStatus::UnsupportedGpu, "unsupported_gpu"),
        (PythonStatus::ProbeFailed, "probe_failed"),
    ];
    for (vendor, vendor_name) in vendors {
        for (status, status_name) in statuses {
            let value = serde_json::json!({
                "gpu": {"vendor": vendor_name, "names": ["fixture GPU"]},
                "python_environments": [{
                    "path": "/usr/bin/python3", "version": "3.12.0",
                    "ready": status == PythonStatus::Ready, "status": status_name
                }],
                "model_dir": "/home/fixture/models", "native_lib": "/opt/libqwen.so"
            });
            let discovery: Discovery = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(discovery.gpu.vendor, vendor);
            assert_eq!(discovery.gpu.names, vec!["fixture GPU"]);
            assert_eq!(discovery.python_environments[0].status, status);
            assert_eq!(
                discovery.python_environments[0].ready,
                status == PythonStatus::Ready
            );
            assert_eq!(serde_json::to_value(discovery).unwrap(), value);
        }
    }
}

#[test]
fn discovery_protocol_rejects_unknown_gpu_vendor_and_python_status() {
    let value = serde_json::json!({
        "gpu": {"vendor": "nvidia", "names": ["fixture GPU"]},
        "python_environments": [{
            "path": "/usr/bin/python3", "version": "3.12.0",
            "ready": false, "status": "unsupported_backend"
        }],
        "model_dir": "/home/fixture/models", "native_lib": "/opt/libqwen.so"
    });
    for vendor in ["cuda", "AMD", "other", ""] {
        let mut invalid = value.clone();
        invalid["gpu"]["vendor"] = serde_json::json!(vendor);
        assert!(serde_json::from_value::<Discovery>(invalid).is_err());
    }
    for status in ["cuda_ready", "Ready", "other", ""] {
        let mut invalid = value.clone();
        invalid["python_environments"][0]["status"] = serde_json::json!(status);
        assert!(serde_json::from_value::<Discovery>(invalid).is_err());
    }
}

#[test]
fn discovery_protocol_requires_gpu_and_python_status() {
    let value = serde_json::json!({
        "gpu": {"vendor": "unknown", "names": []},
        "python_environments": [{
            "path": "/usr/bin/python3", "version": "3.12.0",
            "ready": false, "status": "gpu_unknown"
        }],
        "model_dir": "/home/fixture/models", "native_lib": "/opt/libqwen.so"
    });
    let mut missing_gpu = value.clone();
    missing_gpu.as_object_mut().unwrap().remove("gpu");
    assert!(serde_json::from_value::<Discovery>(missing_gpu).is_err());
    for field in ["vendor", "names"] {
        let mut invalid = value.clone();
        invalid["gpu"].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Discovery>(invalid).is_err());
    }
    for field in ["ready", "status"] {
        let mut invalid = value.clone();
        invalid["python_environments"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(serde_json::from_value::<Discovery>(invalid).is_err());
    }
}

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
    invalid_initialization: bool,
}
impl Fixture {
    fn release(&self) {
        *self.gate.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
impl Runtime for Fixture {
    fn initialize(
        &self,
        config: &SpeechConfig,
        cancel: &Cancellation,
    ) -> Result<Initialization, String> {
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
            return Err("初始化失败，可重试。".into());
        }
        Ok(Initialization {
            config: SpeechConfig {
                python_path: if self.invalid_initialization {
                    "relative".into()
                } else if config.python_path.is_empty() {
                    "/home/fixture/venv/bin/python".into()
                } else {
                    config.python_path.clone()
                },
                model_dir: if config.model_dir.is_empty() {
                    "/home/fixture/models".into()
                } else {
                    config.model_dir.clone()
                },
                native_lib: config.native_lib.clone(),
            },
            config_path: "/home/fixture/.dsh-wsl-desktop/speech/config.json".into(),
            reused_python: true,
            created_venv: false,
        })
    }
    fn discover(&self, config: &SpeechConfig) -> Result<Discovery, String> {
        Ok(Discovery {
            gpu: GpuDiscovery {
                vendor: GpuVendor::Unknown,
                names: vec![],
            },
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
    assert!(!manager.is_busy());
    assert_eq!(
        manager
            .start("/home/fixture/models".into(), &speech)
            .unwrap()
            .id,
        1
    );
    let status = terminal(&manager);
    assert_eq!(status.status, DownloadState::Completed);
    assert!(!manager.is_busy());
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
    assert!(manager.is_busy());
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
fn initialization_is_separate_from_active_settings_and_model_readiness() {
    let speech = speech();
    let before = speech.get_snapshot();
    let fixture = Arc::new(Fixture::default());
    fixture.release();
    let manager = manager(fixture);
    let result = manager
        .initialize(SpeechConfig::default(), &speech)
        .unwrap();
    assert!(result.reused_python);
    assert!(!result.created_venv);
    assert!(result.config.native_lib.is_empty());
    assert_eq!(speech.get_snapshot(), before);
    assert_eq!(manager.snapshot().status, DownloadState::Idle);
    assert!(!manager.is_busy());
    assert!(speech.begin_resource_download().is_ok());
}
fn wait_initializing(manager: &Manager) {
    let mut state = manager.shared.state.lock().unwrap();
    while !state.initializing {
        let (next, timeout) = manager
            .shared
            .changed
            .wait_timeout(state, Duration::from_secs(3))
            .unwrap();
        assert!(!timeout.timed_out(), "initialization worker must start");
        state = next;
    }
}
#[test]
fn initialization_excludes_resource_and_speech_writes_and_can_cancel_retry() {
    let speech = Arc::new(speech());
    let fixture = Arc::new(Fixture::default());
    let manager = Arc::new(manager(fixture.clone()));
    let worker = {
        let manager = manager.clone();
        let speech = speech.clone();
        std::thread::spawn(move || manager.initialize(SpeechConfig::default(), &speech))
    };
    wait_initializing(&manager);
    assert!(manager.is_busy());
    assert!(manager
        .initialize(SpeechConfig::default(), &speech)
        .is_err());
    assert!(manager
        .start("/home/fixture/models".into(), &speech)
        .is_err());
    assert!(speech.begin_resource_download().is_err());
    assert!(speech.action(SpeechAction::Start).is_err());
    assert!(speech.action(SpeechAction::Check).is_err());
    manager.cancel_initialization();
    assert!(!manager.shared.state.lock().unwrap().initializing);
    assert!(!manager.is_busy());
    assert!(worker.join().unwrap().is_err());
    assert!(speech.begin_resource_download().is_ok());
    fixture.release();
    assert!(manager.initialize(SpeechConfig::default(), &speech).is_ok());
    assert!(!speech.get_snapshot().configured);
}
#[test]
fn initialization_shutdown_cancels_drains_and_refuses_new_writes() {
    let speech = Arc::new(speech());
    let manager = Arc::new(manager(Arc::new(Fixture::default())));
    let worker = {
        let manager = manager.clone();
        let speech = speech.clone();
        std::thread::spawn(move || manager.initialize(SpeechConfig::default(), &speech))
    };
    wait_initializing(&manager);
    assert!(manager.is_busy());
    manager.shutdown();
    assert!(worker.join().unwrap().is_err());
    assert!(speech.begin_resource_download().is_ok());
    assert!(manager
        .initialize(SpeechConfig::default(), &speech)
        .is_err());
}
#[test]
fn invalid_initialization_inputs_and_results_release_admission() {
    let speech = speech();
    let fixture = Arc::new(Fixture {
        invalid_initialization: true,
        ..Fixture::default()
    });
    fixture.release();
    let manager = manager(fixture);
    assert!(manager
        .initialize(SpeechConfig::default(), &speech)
        .is_err());
    assert!(speech.begin_resource_download().is_ok());
    assert!(manager
        .initialize(
            SpeechConfig {
                python_path: "relative".into(),
                ..SpeechConfig::default()
            },
            &speech
        )
        .is_err());
    assert!(!speech.get_snapshot().configured);
}
#[test]
fn initialization_result_protocol_is_closed_and_checks_paths_and_flags() {
    let value = serde_json::json!({"config":{"python_path":"/home/f/venv/bin/python", "model_dir":"/home/f/models", "native_lib":""}, "config_path":"/home/f/.dsh-wsl-desktop/speech/config.json", "reused_python":false,"created_venv":true});
    let result: Initialization = serde_json::from_value(value.clone()).unwrap();
    result.validate().unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), value);
    for (field, replacement) in [
        ("created_venv", serde_json::json!(false)),
        ("reused_python", serde_json::json!(true)),
        ("config_path", serde_json::json!("/tmp/config.json")),
    ] {
        let mut invalid = value.clone();
        invalid[field] = replacement;
        assert!(serde_json::from_value::<Initialization>(invalid)
            .unwrap()
            .validate()
            .is_err());
    }
    let mut invalid = value;
    invalid["shell"] = serde_json::json!("bad");
    assert!(serde_json::from_value::<Initialization>(invalid).is_err());
}

#[test]
fn failed_download_releases_admission_and_does_not_persist() {
    let speech = speech();
    let manager = manager(Arc::new(Fixture {
        gate: Mutex::new(true),
        changed: Condvar::new(),
        fail: true,
        invalid_initialization: false,
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
