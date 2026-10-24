use super::*;
use std::{
    sync::atomic::AtomicUsize,
    time::{Duration, Instant},
};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "dsh-speech-test-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self) -> PathBuf {
        self.0.join("speech.json")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct Gate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}
impl Gate {
    fn block(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            let (next, timeout) = self
                .changed
                .wait_timeout(state, Duration::from_secs(5))
                .unwrap();
            state = next;
            assert!(!timeout.timed_out(), "test gate timed out");
        }
    }
    fn entered(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.0 {
            let (next, timeout) = self
                .changed
                .wait_timeout(state, Duration::from_secs(5))
                .unwrap();
            state = next;
            assert!(!timeout.timed_out(), "worker did not enter test gate");
        }
    }
    fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}
struct FakeRuntime {
    distribution: Mutex<Option<String>>,
    inspection_override: Mutex<Option<Result<Inspection, String>>>,
    status: Mutex<ServiceStatus>,
    inspections: AtomicUsize,
    starts: AtomicUsize,
    prepares: AtomicUsize,
    stops: Mutex<Vec<(String, String)>>,
    cancelled: Mutex<Vec<String>>,
    inspect_gate: Mutex<Option<Arc<Gate>>>,
    status_gate: Mutex<Option<Arc<Gate>>>,
    status_cancel: Mutex<Option<Cancellation>>,
    status_failure: AtomicBool,
    start_gate: Mutex<Option<Arc<Gate>>>,
    prepare_gate: Mutex<Option<Arc<Gate>>>,
    stop_gate: Mutex<Option<Arc<Gate>>>,
    stop_failure: AtomicBool,
    prepare_failure: AtomicBool,
}
impl Default for FakeRuntime {
    fn default() -> Self {
        Self {
            distribution: Mutex::new(Some("Ubuntu-test".into())),
            inspection_override: Mutex::new(None),
            status: Mutex::new(stopped()),
            inspections: AtomicUsize::new(0),
            starts: AtomicUsize::new(0),
            prepares: AtomicUsize::new(0),
            stops: Mutex::new(Vec::new()),
            cancelled: Mutex::new(Vec::new()),
            inspect_gate: Mutex::new(None),
            status_gate: Mutex::new(None),
            status_cancel: Mutex::new(None),
            status_failure: AtomicBool::new(false),
            start_gate: Mutex::new(None),
            prepare_gate: Mutex::new(None),
            stop_gate: Mutex::new(None),
            stop_failure: AtomicBool::new(false),
            prepare_failure: AtomicBool::new(false),
        }
    }
}
fn stopped() -> ServiceStatus {
    ServiceStatus {
        identity_valid: false,
        instance_id: None,
        service_state: ServiceState::Stopped,
        model_state: ModelState::Unknown,
        gpu_name: None,
    }
}
impl Runtime for FakeRuntime {
    fn distribution(&self) -> Option<String> {
        self.distribution.lock().unwrap().clone()
    }
    fn inspect(
        &self,
        config: &SpeechConfig,
        _cancel: &Cancellation,
        progress: &dyn Fn(u8),
    ) -> Result<Inspection, String> {
        self.inspections.fetch_add(1, Ordering::Relaxed);
        if let Some(result) = self.inspection_override.lock().unwrap().clone() {
            return result;
        }
        progress(17);
        let gate = self.inspect_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.block();
        }
        progress(83);
        Ok(Inspection {
            environment_ok: true,
            models_ok: !config.model_dir.ends_with("bad"),
            gpu_name: Some("Fake GPU".into()),
            error: if config.model_dir.ends_with("bad") {
                Some("模型文件哈希不匹配，请检查本地模型。".into())
            } else {
                None
            },
        })
    }
    fn status(&self, cancel: &Cancellation) -> Result<ServiceStatus, String> {
        let status = self.status.lock().unwrap().clone();
        let failure = self.status_failure.load(Ordering::Relaxed);
        let gate = self.status_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            *self.status_cancel.lock().unwrap() = Some(cancel.clone());
            gate.block();
        }
        // Deliberately ignore cancellation here to exercise controller fencing.
        if failure {
            Err("RAW SECRET delayed status error".into())
        } else {
            Ok(status)
        }
    }
    fn start(
        &self,
        _config: &SpeechConfig,
        _cancel: &Cancellation,
    ) -> Result<ManagedSession, String> {
        let n = self.starts.fetch_add(1, Ordering::Relaxed);
        let gate = self.start_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.block();
        }
        let session =
            ManagedSession::new(format!("fake-session-{n:016}"), "ab".repeat(32)).unwrap();
        *self.status.lock().unwrap() = ServiceStatus {
            identity_valid: true,
            instance_id: Some(session.instance_id().into()),
            service_state: ServiceState::Running,
            model_state: ModelState::Unloaded,
            gpu_name: None,
        };
        Ok(session)
    }
    fn prepare(
        &self,
        session: &ManagedSession,
        cancel: &Cancellation,
    ) -> Result<ServiceStatus, String> {
        self.prepares.fetch_add(1, Ordering::Relaxed);
        let gate = self.prepare_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.block();
        }
        cancel.check()?;
        if self.prepare_failure.load(Ordering::Relaxed) {
            return Err("RAW SECRET process output".into());
        }
        let mut status = self.status.lock().unwrap();
        assert_eq!(status.instance_id.as_deref(), Some(session.instance_id()));
        status.model_state = ModelState::Ready;
        Ok(status.clone())
    }
    fn stop(&self, session: &ManagedSession) -> Result<(), String> {
        let gate = self.stop_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.block();
        }
        self.stops
            .lock()
            .unwrap()
            .push((session.instance_id().into(), session.control_token().into()));
        if self.stop_failure.load(Ordering::Relaxed) {
            return Err("RAW SECRET".into());
        }
        let mut status = self.status.lock().unwrap();
        if status.instance_id.as_deref() == Some(session.instance_id()) {
            *status = stopped();
        }
        drop(status);
        let gate = self.prepare_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.release();
        }
        Ok(())
    }
    fn cancel_requests(&self, id: &str) -> Result<(), String> {
        self.cancelled.lock().unwrap().push(id.into());
        Ok(())
    }
}
fn config(name: &str) -> SpeechConfig {
    SpeechConfig {
        python_path: "/home/test/venv/bin/python".into(),
        model_dir: format!("/models/{name}"),
        native_lib: "/home/test/lib/libqwen.so".into(),
    }
}
fn setup() -> (Directory, Arc<FakeRuntime>, Manager) {
    let dir = Directory::new();
    let runtime = Arc::new(FakeRuntime::default());
    let manager = Manager::new(dir.file(), runtime.clone(), None).unwrap();
    (dir, runtime, manager)
}
fn idle(manager: &Manager) -> SpeechSnapshot {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut state = manager.shared.state.lock().unwrap();
    while state.snapshot.busy {
        let (next, result) = manager
            .shared
            .changed
            .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        state = next;
        assert!(
            !result.timed_out(),
            "speech operation did not finish: {:?}",
            state.snapshot
        );
    }
    state.snapshot.clone()
}
fn saved(manager: &Manager) {
    manager.save_config(config("good")).unwrap();
    assert!(idle(manager).configured);
}

#[test]
fn strict_dtos_and_canonical_unix_paths() {
    assert!(serde_json::from_str::<SpeechConfig>(
        r#"{"python_path":"/p","model_dir":"/m","native_lib":"/n","command":"evil"}"#
    )
    .is_err());
    assert!(
        serde_json::from_str::<PreferencesPatch>(r#"{"auto_read":true,"url":"secret"}"#).is_err()
    );
    assert!(serde_json::from_str::<PreferencesPatch>(r#"{"volume":2.5}"#).is_err());
    assert!(serde_json::from_str::<PreferencesPatch>(r#"{"volume":-1}"#).is_err());
    for path in [
        "",
        "C:/python",
        "//host/python",
        "/a/../p",
        "/a/./p",
        "/a//p",
        "/a/",
        "/",
        "/a\\p",
        "/C:/p",
        "/a\0p",
        "/a
p",
        "/a\u{7f}p",
    ] {
        let mut value = config("good");
        value.python_path = path.into();
        assert!(value.validate().is_err(), "accepted {path:?}");
    }
    let mut good = config("good");
    good.model_dir = "/home/测试 user/Q8".into();
    assert!(good.validate().is_ok());
}
#[test]
fn defaults_and_preferences_work_without_config_or_runtime_jobs() {
    let (dir, runtime, manager) = setup();
    assert_eq!(manager.get_preferences(), SpeechPreferences::default());
    assert!(!dir.file().exists());
    let result = manager
        .set_preferences(PreferencesPatch {
            volume: Some(42),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(result.volume, 42);
    assert!(result.initialized);
    assert!(!result.auto_read);
    assert!(!manager.get_snapshot().configured);
    assert_eq!(runtime.inspections.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.starts.load(Ordering::Relaxed), 0);
    assert_eq!(
        Manager::new(dir.file(), runtime, None)
            .unwrap()
            .get_preferences(),
        result
    );
}
#[test]
fn migration_is_once_and_cannot_overwrite_explicit_newer_choice() {
    let (_dir, _runtime, manager) = setup();
    let migrated = manager
        .set_preferences(PreferencesPatch {
            auto_read: Some(true),
            migrate: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert!(migrated.auto_read);
    assert_eq!(migrated.volume, 100);
    let explicit = manager
        .set_preferences(PreferencesPatch {
            auto_read: Some(false),
            ..Default::default()
        })
        .unwrap();
    let delayed = manager
        .set_preferences(PreferencesPatch {
            auto_read: Some(true),
            volume: Some(1),
            migrate: Some(true),
        })
        .unwrap();
    assert_eq!(delayed, explicit);
    assert!(!delayed.auto_read);
    assert_eq!(delayed.volume, 100);
}
#[test]
fn explicit_default_initializes_and_blocks_legacy_migration() {
    let (_dir, _runtime, manager) = setup();
    manager
        .set_preferences(PreferencesPatch {
            auto_read: Some(false),
            ..Default::default()
        })
        .unwrap();
    assert!(
        !manager
            .set_preferences(PreferencesPatch {
                auto_read: Some(true),
                migrate: Some(true),
                ..Default::default()
            })
            .unwrap()
            .auto_read
    );
    let before = manager.get_preferences();
    assert!(manager
        .set_preferences(PreferencesPatch {
            volume: Some(101),
            ..Default::default()
        })
        .is_err());
    assert_eq!(manager.get_preferences(), before);
}
#[test]
fn concurrent_partial_preferences_do_not_lose_updates() {
    let (dir, runtime, manager) = setup();
    let manager = Arc::new(manager);
    let a = manager.clone();
    let b = manager.clone();
    let first = thread::spawn(move || {
        a.set_preferences(PreferencesPatch {
            auto_read: Some(true),
            ..Default::default()
        })
        .unwrap()
    });
    let second = thread::spawn(move || {
        b.set_preferences(PreferencesPatch {
            volume: Some(23),
            ..Default::default()
        })
        .unwrap()
    });
    first.join().unwrap();
    second.join().unwrap();
    let actual = manager.get_preferences();
    assert!(actual.auto_read);
    assert_eq!(actual.volume, 23);
    assert_eq!(actual.revision, 2);
    assert_eq!(
        Manager::new(dir.file(), runtime, None)
            .unwrap()
            .get_preferences(),
        actual
    );
}
#[test]
fn corrupt_oversized_and_unknown_persistence_never_gets_repaired() {
    let dir = Directory::new();
    let runtime = Arc::new(FakeRuntime::default());
    for content in [b"not json".to_vec(), vec![b'x'; FILE_LIMIT as usize + 1], br#"{"config":null,"preferences":{"revision":0,"initialized":false,"auto_read":false,"volume":100},"token":"secret"}"#.to_vec(), b"[]".to_vec()] {
        fs::write(dir.file(), &content).unwrap();
        assert!(Manager::new(dir.file(), runtime.clone(), None).is_err());
        assert_eq!(fs::read(dir.file()).unwrap(), content);
    }
}
#[test]
fn failed_replace_preserves_in_memory_settings() {
    let (dir, _runtime, manager) = setup();
    fs::create_dir(dir.file()).unwrap();
    assert!(manager
        .set_preferences(PreferencesPatch {
            auto_read: Some(true),
            ..Default::default()
        })
        .is_err());
    assert_eq!(manager.get_preferences(), SpeechPreferences::default());
    assert!(dir.file().is_dir());
}
#[test]
fn candidate_commits_only_after_pass_and_failure_preserves_valid_config() {
    let (dir, runtime, manager) = setup();
    saved(&manager);
    let bytes = fs::read(dir.file()).unwrap();
    manager.save_config(config("bad")).unwrap();
    let snapshot = idle(&manager);
    assert!(snapshot.error.is_some());
    assert_eq!(snapshot.models_state, CheckState::Error);
    assert_eq!(snapshot.config, config("good"));
    assert_eq!(fs::read(dir.file()).unwrap(), bytes);
    assert_eq!(
        Manager::new(dir.file(), runtime, None)
            .unwrap()
            .get_snapshot()
            .config,
        config("good")
    );
}
#[test]
fn cancellation_discards_late_success_and_hash_progress() {
    let (dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    *runtime.inspect_gate.lock().unwrap() = Some(gate.clone());
    manager.save_config(config("candidate")).unwrap();
    gate.entered();
    assert_eq!(manager.get_snapshot().model_progress, Some(17));
    let cancelled = manager.action(SpeechAction::CancelCheck).unwrap();
    assert!(!cancelled.busy);
    assert_eq!(cancelled.model_progress, None);
    gate.release();
    drop(manager.shared.worker.lock().unwrap());
    assert_eq!(manager.get_snapshot(), cancelled);
    assert_eq!(
        Store { path: dir.file() }.load().unwrap().config,
        Some(config("good"))
    );
}
#[test]
fn newer_candidate_and_preference_change_survive_old_late_result() {
    let (dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    *runtime.inspect_gate.lock().unwrap() = Some(gate.clone());
    manager.save_config(config("older")).unwrap();
    gate.entered();
    manager
        .set_preferences(PreferencesPatch {
            volume: Some(64),
            ..Default::default()
        })
        .unwrap();
    manager.save_config(config("newer")).unwrap();
    gate.release();
    let final_snapshot = idle(&manager);
    assert_eq!(final_snapshot.config, config("newer"));
    let data = Store { path: dir.file() }.load().unwrap();
    assert_eq!(data.config, Some(config("newer")));
    assert_eq!(data.preferences.volume, 64);
}
// Keep test cleanup safe even if an admission assertion fails while status is blocked.
struct ReleaseGateOnDrop(Arc<Gate>);
impl Drop for ReleaseGateOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[test]
fn user_operations_preempt_refresh_without_waiting_or_accepting_its_late_result() {
    for kind in ["save", "check", "start"] {
        let (dir, runtime, manager) = setup();
        saved(&manager);
        let gate = Arc::new(Gate::default());
        let _release = ReleaseGateOnDrop(gate.clone());
        *runtime.status_gate.lock().unwrap() = Some(gate.clone());
        let poll = manager.action(SpeechAction::Refresh).unwrap();
        gate.entered();
        let result = match kind {
            "save" => manager.save_config(config("newer")),
            "check" => manager.action(SpeechAction::Check),
            _ => manager.action(SpeechAction::Start),
        }
        .unwrap();
        assert_eq!(result.operation.as_deref(), Some(kind));
        assert!(result.revision > poll.revision);
        assert!(runtime
            .status_cancel
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_cancelled());
        // A blocked read must not retain the model worker after admission succeeds.
        let final_state = idle(&manager);
        assert!(final_state.error.is_none());
        if kind == "start" {
            assert_eq!(final_state.model_state, ModelState::Ready);
        }
        if kind == "save" {
            assert_eq!(
                Store { path: dir.file() }.load().unwrap().config,
                Some(config("newer"))
            );
        }
        gate.release();
        drop(manager.shared.refreshing.lock().unwrap());
        assert_eq!(
            manager.get_snapshot(),
            final_state,
            "late poll overwrote {kind}"
        );
    }
}

#[test]
fn model_download_preempts_refresh_and_ignores_late_success_or_error() {
    for fail in [false, true] {
        let (_dir, runtime, manager) = setup();
        saved(&manager);
        runtime.status_failure.store(fail, Ordering::Relaxed);
        let gate = Arc::new(Gate::default());
        let _release = ReleaseGateOnDrop(gate.clone());
        *runtime.status_gate.lock().unwrap() = Some(gate.clone());
        let poll = manager.action(SpeechAction::Refresh).unwrap();
        gate.entered();
        let lease = manager.begin_resource_download().unwrap();
        let downloading = manager.get_snapshot();
        assert!(!downloading.busy);
        assert!(downloading.operation.is_none());
        assert!(downloading.revision > poll.revision);
        assert!(runtime
            .status_cancel
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_cancelled());
        assert!(manager.save_config(config("other")).is_err());
        assert!(manager.action(SpeechAction::Check).is_err());
        assert!(manager.action(SpeechAction::Start).is_err());
        assert!(manager.begin_resource_download().is_err());
        gate.release();
        drop(manager.shared.refreshing.lock().unwrap());
        assert_eq!(manager.get_snapshot(), downloading);
        drop(lease);
        runtime.status_failure.store(false, Ordering::Relaxed);
        manager.action(SpeechAction::Check).unwrap();
        assert!(idle(&manager).error.is_none());
    }
}

#[test]
fn background_refresh_cannot_preempt_a_real_check_or_relax_download_worker_protection() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    let _release = ReleaseGateOnDrop(gate.clone());
    *runtime.inspect_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Check).unwrap();
    gate.entered();
    let checking = manager.get_snapshot();
    assert_eq!(manager.action(SpeechAction::Refresh).unwrap(), checking);
    assert!(manager.begin_resource_download().is_err());
    assert!(manager.action(SpeechAction::Start).is_err());
    manager.action(SpeechAction::CancelCheck).unwrap();
    // Even if a new refresh is admitted while the cancelled inspector drains,
    // downloads must still honor the real worker lock.
    manager.action(SpeechAction::Refresh).unwrap();
    idle(&manager);
    assert!(manager.begin_resource_download().is_err());
    gate.release();
    drop(manager.shared.worker.lock().unwrap());
    assert!(manager.begin_resource_download().is_ok());
}

#[test]
fn shutdown_cancels_and_drains_an_inflight_readonly_refresh() {
    let (_dir, runtime, manager) = setup();
    let manager = Arc::new(manager);
    let gate = Arc::new(Gate::default());
    let _release = ReleaseGateOnDrop(gate.clone());
    *runtime.status_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Refresh).unwrap();
    gate.entered();
    let shutting_down = manager.clone();
    let (finished, completion) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        shutting_down.shutdown();
        finished.send(()).unwrap();
    });
    let mut state = manager.shared.state.lock().unwrap();
    while !state.closed {
        let (next, timeout) = manager
            .shared
            .changed
            .wait_timeout(state, Duration::from_secs(5))
            .unwrap();
        state = next;
        assert!(!timeout.timed_out(), "shutdown did not cancel status");
    }
    drop(state);
    assert!(runtime
        .status_cancel
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .is_cancelled());
    assert!(
        completion.try_recv().is_err(),
        "shutdown did not drain status reader"
    );
    gate.release();
    completion.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.join().unwrap();
    assert!(!manager.get_snapshot().busy);
    assert!(manager.get_snapshot().error.is_none());
}

#[test]
fn download_still_rejects_owned_external_and_stopping_services() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    {
        let _stopping = manager.shared.stopping.lock().unwrap();
        assert!(manager.begin_resource_download().is_err());
    }
    *runtime.status.lock().unwrap() = ServiceStatus {
        identity_valid: true,
        instance_id: Some("external-session-0001".into()),
        service_state: ServiceState::Running,
        model_state: ModelState::Ready,
        gpu_name: None,
    };
    manager.action(SpeechAction::Refresh).unwrap();
    assert_eq!(idle(&manager).ownership, Ownership::External);
    assert!(manager.begin_resource_download().is_err());
    *runtime.status.lock().unwrap() = stopped();
    manager.action(SpeechAction::Start).unwrap();
    assert_eq!(idle(&manager).ownership, Ownership::Managed);
    assert!(manager.begin_resource_download().is_err());
}

#[test]
fn refresh_is_lightweight_and_manual_external_model_status_is_honest() {
    let (_dir, runtime, manager) = setup();
    *runtime.status.lock().unwrap() = ServiceStatus {
        identity_valid: false,
        instance_id: None,
        service_state: ServiceState::Running,
        model_state: ModelState::Ready,
        gpu_name: None,
    };
    manager.action(SpeechAction::Refresh).unwrap();
    let old = idle(&manager);
    assert_eq!(old.ownership, Ownership::Unknown);
    assert_eq!(old.model_state, ModelState::Unknown);
    {
        let mut status = runtime.status.lock().unwrap();
        status.identity_valid = true;
        status.instance_id = None;
    }
    manager.action(SpeechAction::Refresh).unwrap();
    let external = idle(&manager);
    assert_eq!(external.ownership, Ownership::External);
    assert_eq!(external.model_state, ModelState::Ready);
    assert!(manager.ensure_ready("external-request").is_ok());
    manager.action(SpeechAction::Stop).unwrap();
    assert_eq!(idle(&manager).ownership, Ownership::External);
    assert_eq!(runtime.inspections.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.starts.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.prepares.load(Ordering::Relaxed), 0);
    assert!(runtime.stops.lock().unwrap().is_empty());
}
#[test]
fn unknown_or_unloaded_external_service_is_never_taken_over() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    *runtime.status.lock().unwrap() = ServiceStatus {
        identity_valid: true,
        instance_id: None,
        service_state: ServiceState::Running,
        model_state: ModelState::Unloaded,
        gpu_name: None,
    };
    manager.action(SpeechAction::Start).unwrap();
    let result = idle(&manager);
    assert!(result.error.is_some());
    assert_eq!(result.ownership, Ownership::External);
    assert_eq!(runtime.starts.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.prepares.load(Ordering::Relaxed), 0);
    assert!(runtime.stops.lock().unwrap().is_empty());
}
#[test]
fn start_prepares_model_and_secrets_never_reach_snapshot_or_file() {
    let (dir, runtime, manager) = setup();
    saved(&manager);
    let ready = manager.ensure_ready("test-ready").unwrap();
    assert_eq!(ready.model_state, ModelState::Ready);
    assert_eq!(ready.ownership, Ownership::Managed);
    assert_eq!(runtime.starts.load(Ordering::Relaxed), 1);
    assert_eq!(runtime.prepares.load(Ordering::Relaxed), 1);
    let json = serde_json::to_string(&ready).unwrap();
    assert!(!json.contains(&"ab".repeat(32)));
    assert!(!json.contains("fake-session"));
    assert!(!json.contains("token"));
    assert!(!String::from_utf8(fs::read(dir.file()).unwrap())
        .unwrap()
        .contains("token"));
    manager.action(SpeechAction::Stop).unwrap();
    let stopped = idle(&manager);
    assert_eq!(stopped.service_state, ServiceState::Stopped);
    assert_eq!(stopped.model_state, ModelState::Unloaded);
    assert_eq!(stopped.ownership, Ownership::None);
    assert_eq!(runtime.stops.lock().unwrap().len(), 1);
}
#[test]
fn stop_supersedes_busy_prepare_and_prevents_late_ready() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    *runtime.prepare_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Start).unwrap();
    gate.entered();
    let stopping = manager.action(SpeechAction::Stop).unwrap();
    let done = idle(&manager);
    assert!(done.revision > stopping.revision);
    assert_eq!(done.service_state, ServiceState::Stopped);
    assert_ne!(done.model_state, ModelState::Ready);
    assert_eq!(runtime.stops.lock().unwrap().len(), 1);
}
#[test]
fn cancelled_late_start_is_released_without_preparing_model() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    *runtime.start_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Start).unwrap();
    gate.entered();
    manager.action(SpeechAction::Stop).unwrap();
    gate.release();
    assert_eq!(idle(&manager).service_state, ServiceState::Stopped);
    assert_eq!(runtime.prepares.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.stops.lock().unwrap().len(), 1);
}
#[test]
fn request_cancel_stops_its_auto_start_but_not_newer_manual_start() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    let manager = Arc::new(manager);
    let gate = Arc::new(Gate::default());
    *runtime.prepare_gate.lock().unwrap() = Some(gate.clone());
    let caller = manager.clone();
    let waiter = thread::spawn(move || caller.ensure_ready("old-request"));
    gate.entered();
    manager.cancel_request("old-request").unwrap();
    assert!(waiter.join().unwrap().is_err());
    idle(&manager);
    *runtime.prepare_gate.lock().unwrap() = None;
    manager.action(SpeechAction::Start).unwrap();
    assert_eq!(idle(&manager).model_state, ModelState::Ready);
    let stops = runtime.stops.lock().unwrap().len();
    manager.cancel_request("old-request").unwrap();
    assert_eq!(runtime.stops.lock().unwrap().len(), stops);
    assert_eq!(manager.get_snapshot().model_state, ModelState::Ready);
}
#[test]
fn prepare_error_is_sanitized_and_releases_only_owned_session() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    runtime.prepare_failure.store(true, Ordering::Relaxed);
    assert!(manager.ensure_ready("failure").is_err());
    let result = manager.get_snapshot();
    assert_eq!(result.model_state, ModelState::Error);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("RAW SECRET"));
    assert_eq!(runtime.stops.lock().unwrap().len(), 1);
}
#[test]
fn failed_stop_keeps_identity_for_retry_and_drop_releases_owned_only() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    manager.ensure_ready("owned").unwrap();
    runtime.stop_failure.store(true, Ordering::Relaxed);
    manager.action(SpeechAction::Stop).unwrap();
    assert!(idle(&manager).error.is_some());
    runtime.stop_failure.store(false, Ordering::Relaxed);
    drop(manager);
    assert_eq!(
        runtime.status.lock().unwrap().service_state,
        ServiceState::Stopped
    );
    let (_dir2, external, manager2) = setup();
    *external.status.lock().unwrap() = ServiceStatus {
        identity_valid: true,
        instance_id: None,
        service_state: ServiceState::Running,
        model_state: ModelState::Ready,
        gpu_name: None,
    };
    manager2.ensure_ready("manual").unwrap();
    drop(manager2);
    assert!(external.stops.lock().unwrap().is_empty());
}
#[test]
fn drop_cancels_and_cleans_up_even_a_late_start() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    *runtime.start_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Start).unwrap();
    gate.entered();
    let shared = manager.shared.clone();
    let dropping = thread::spawn(move || drop(manager));
    let mut state = shared.state.lock().unwrap();
    while !state.closed {
        state = shared.changed.wait(state).unwrap();
    }
    drop(state);
    gate.release();
    dropping.join().unwrap();
    assert_eq!(runtime.stops.lock().unwrap().len(), 1);
    assert_eq!(runtime.prepares.load(Ordering::Relaxed), 0);
}
#[test]
fn superseded_stop_waits_for_previous_authenticated_release() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    manager.ensure_ready("stop-serialization").unwrap();
    let gate = Arc::new(Gate::default());
    *runtime.stop_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Stop).unwrap();
    gate.entered();
    // The owned slot is temporarily held by the release call, but its model
    // must finish shutting down before any changed paths may be persisted.
    assert_eq!(
        manager.save_config(config("during-stop")).unwrap_err(),
        "请先停止语音服务后再修改路径"
    );
    let newer = manager.action(SpeechAction::Stop).unwrap();
    assert!(newer.busy);
    gate.release();
    let final_snapshot = idle(&manager);
    assert_eq!(final_snapshot.service_state, ServiceState::Stopped);
    assert!(final_snapshot.revision > newer.revision);
    assert_eq!(runtime.stops.lock().unwrap().len(), 1);
}
#[test]
fn stop_cancels_inspection_without_stuck_checking_state() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    let gate = Arc::new(Gate::default());
    *runtime.inspect_gate.lock().unwrap() = Some(gate.clone());
    manager.action(SpeechAction::Check).unwrap();
    gate.entered();
    manager.action(SpeechAction::Stop).unwrap();
    gate.release();
    let snapshot = idle(&manager);
    assert_eq!(snapshot.environment_state, CheckState::Unknown);
    assert_eq!(snapshot.models_state, CheckState::Unknown);
    assert_eq!(snapshot.model_progress, None);
    assert_eq!(snapshot.config, config("good"));
}
#[test]
fn cancel_before_readiness_is_remembered_without_starting_any_service() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    manager.cancel_request("already-cancelled").unwrap();
    assert!(manager.ensure_ready("already-cancelled").is_err());
    assert_eq!(runtime.starts.load(Ordering::Relaxed), 0);
    assert_eq!(runtime.prepares.load(Ordering::Relaxed), 0);
}
#[test]
fn public_instance_never_replaces_private_owned_session() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    manager.ensure_ready("private-session").unwrap();
    let old_instance = runtime.status.lock().unwrap().instance_id.clone().unwrap();
    *runtime.status.lock().unwrap() = ServiceStatus {
        identity_valid: true,
        instance_id: Some("external-instance-00000000".into()),
        service_state: ServiceState::Running,
        model_state: ModelState::Ready,
        gpu_name: None,
    };
    manager.action(SpeechAction::Refresh).unwrap();
    assert_eq!(idle(&manager).ownership, Ownership::External);
    manager.action(SpeechAction::Stop).unwrap();
    let snapshot = idle(&manager);
    assert_eq!(snapshot.ownership, Ownership::External);
    assert_eq!(snapshot.model_state, ModelState::Ready);
    let stops = runtime.stops.lock().unwrap();
    assert_eq!(stops.len(), 1);
    assert_eq!(stops[0].0, old_instance);
    assert_eq!(stops[0].1, "ab".repeat(32));
}
#[test]
fn inspection_error_explains_individual_failure_but_logs_are_static() {
    let (_dir, _runtime, manager) = setup();
    saved(&manager);
    manager.save_config(config("bad")).unwrap();
    let snapshot = idle(&manager);
    assert_eq!(snapshot.environment_state, CheckState::Passed);
    assert_eq!(snapshot.models_state, CheckState::Error);
    assert_eq!(
        snapshot.error.as_deref(),
        Some("模型文件哈希不匹配，请检查本地模型。")
    );
    assert!(!snapshot.logs.iter().any(|log| log.contains("哈希不匹配")));
    assert_eq!(snapshot.config, config("good"));
}
#[test]
fn live_managed_paths_cannot_change_but_preferences_and_same_config_are_allowed() {
    let (dir, runtime, manager) = setup();
    saved(&manager);
    manager.ensure_ready("live-path-guard").unwrap();
    let before = manager.get_snapshot();
    let bytes = fs::read(dir.file()).unwrap();
    let inspections = runtime.inspections.load(Ordering::Relaxed);
    assert_eq!(
        manager.save_config(config("different")).unwrap_err(),
        "请先停止语音服务后再修改路径"
    );
    assert_eq!(manager.get_snapshot(), before);
    assert_eq!(fs::read(dir.file()).unwrap(), bytes);
    assert_eq!(runtime.inspections.load(Ordering::Relaxed), inspections);
    manager
        .set_preferences(PreferencesPatch {
            volume: Some(51),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(manager.get_preferences().volume, 51);
    manager.save_config(config("good")).unwrap();
    assert_eq!(idle(&manager).config, config("good"));
    assert!(runtime.stops.lock().unwrap().is_empty());
    manager.action(SpeechAction::Stop).unwrap();
    idle(&manager);
    manager.save_config(config("different")).unwrap();
    assert_eq!(idle(&manager).config, config("different"));
    assert_eq!(
        Store { path: dir.file() }.load().unwrap().config,
        Some(config("different"))
    );
}
#[test]
fn known_external_running_paths_cannot_change_even_without_local_configuration() {
    let (dir, runtime, manager) = setup();
    *runtime.status.lock().unwrap() = ServiceStatus {
        identity_valid: true,
        instance_id: None,
        service_state: ServiceState::Running,
        model_state: ModelState::Ready,
        gpu_name: None,
    };
    manager.action(SpeechAction::Refresh).unwrap();
    idle(&manager);
    assert_eq!(
        manager.save_config(config("first")).unwrap_err(),
        "请先停止语音服务后再修改路径"
    );
    assert!(!dir.file().exists());
    assert!(manager.ensure_ready("external-still-usable").is_ok());
    assert_eq!(runtime.inspections.load(Ordering::Relaxed), 0);
    assert!(runtime.stops.lock().unwrap().is_empty());
}
#[test]
fn private_ownership_blocks_path_changes_even_when_public_status_says_stopped() {
    let (dir, runtime, manager) = setup();
    saved(&manager);
    manager.ensure_ready("retained-private-owner").unwrap();
    *runtime.status.lock().unwrap() = stopped();
    manager.action(SpeechAction::Refresh).unwrap();
    assert_eq!(idle(&manager).service_state, ServiceState::Stopped);
    assert_eq!(
        manager.save_config(config("different")).unwrap_err(),
        "请先停止语音服务后再修改路径"
    );
    assert_eq!(
        Store { path: dir.file() }.load().unwrap().config,
        Some(config("good"))
    );
}
#[test]
fn environment_failure_does_not_claim_skipped_model_files_are_invalid() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    *runtime.inspection_override.lock().unwrap() = Some(Ok(Inspection {
        environment_ok: false,
        models_ok: false,
        gpu_name: None,
        error: Some("原生库 ABI 检查未通过，尚未检查模型文件。".into()),
    }));
    manager.save_config(config("candidate")).unwrap();
    let snapshot = idle(&manager);
    assert_eq!(snapshot.environment_state, CheckState::Error);
    assert_eq!(snapshot.models_state, CheckState::Unknown);
    assert_eq!(snapshot.model_progress, None);
    assert_eq!(snapshot.config, config("good"));
    assert_eq!(
        snapshot.error.as_deref(),
        Some("原生库 ABI 检查未通过，尚未检查模型文件。")
    );
}
#[test]
fn inspection_transport_failure_leaves_model_validation_unknown() {
    let (_dir, runtime, manager) = setup();
    saved(&manager);
    *runtime.inspection_override.lock().unwrap() = Some(Err("RAW SECRET helper failure".into()));
    manager.action(SpeechAction::Check).unwrap();
    let snapshot = idle(&manager);
    assert_eq!(snapshot.environment_state, CheckState::Error);
    assert_eq!(snapshot.models_state, CheckState::Unknown);
    assert_eq!(snapshot.model_progress, None);
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("RAW SECRET"));
}
#[test]
fn operations_refresh_configured_distribution_but_preserve_owned_original() {
    let dir = Directory::new();
    let runtime = Arc::new(FakeRuntime::default());
    *runtime.distribution.lock().unwrap() = None;
    let manager = Manager::new(dir.file(), runtime.clone(), None).unwrap();
    assert_eq!(manager.get_snapshot().distribution, None);
    *runtime.distribution.lock().unwrap() = Some("Ubuntu-after-setup".into());
    saved(&manager);
    assert_eq!(
        manager.get_snapshot().distribution.as_deref(),
        Some("Ubuntu-after-setup")
    );
    *runtime.distribution.lock().unwrap() = Some("Ubuntu-check".into());
    manager.action(SpeechAction::Check).unwrap();
    assert_eq!(idle(&manager).distribution.as_deref(), Some("Ubuntu-check"));
    *runtime.distribution.lock().unwrap() = Some("Ubuntu-start".into());
    manager.ensure_ready("distribution-owner").unwrap();
    assert_eq!(
        manager.get_snapshot().distribution.as_deref(),
        Some("Ubuntu-start")
    );
    *runtime.distribution.lock().unwrap() = Some("Ubuntu-new-launcher-config".into());
    manager.action(SpeechAction::Refresh).unwrap();
    assert_eq!(idle(&manager).distribution.as_deref(), Some("Ubuntu-start"));
    manager.action(SpeechAction::Check).unwrap();
    assert_eq!(idle(&manager).distribution.as_deref(), Some("Ubuntu-start"));
    manager.action(SpeechAction::Stop).unwrap();
    idle(&manager);
    manager.action(SpeechAction::Refresh).unwrap();
    assert_eq!(
        idle(&manager).distribution.as_deref(),
        Some("Ubuntu-new-launcher-config")
    );
}
#[test]
fn managed_identity_requires_secret_and_nonce_and_logs_stay_bounded() {
    assert!(ManagedSession::new("pid-1".into(), "ab".repeat(32)).is_err());
    assert!(ManagedSession::new("0123456789abcdef".into(), "not-a-secret".into()).is_err());
    let (_dir, _runtime, manager) = setup();
    for _ in 0..40 {
        manager.action(SpeechAction::Refresh).unwrap();
        idle(&manager);
    }
    assert!(manager.get_snapshot().logs.len() <= 32);
}
