use super::*;
use crate::speech_settings::{
    Inspection, ManagedSession, ModelState, ServiceState, ServiceStatus, SpeechAction,
};
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Default)]
struct Fixture {
    install_gate: AtomicBool,
    inspect_gate: AtomicBool,
    good: AtomicBool,
    inspect_error_once: AtomicBool,
    service_running: AtomicBool,
    installs: AtomicU64,
    inspections: AtomicU64,
}
fn wait(gate: &AtomicBool, cancel: &Cancellation) -> Result<(), String> {
    for _ in 0..1000 {
        if gate.load(Ordering::SeqCst) {
            return cancel.check();
        }
        cancel.check()?;
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("fixture timeout")
}
fn config() -> SpeechConfig {
    SpeechConfig {
        python_path: "/home/test/.dsh-wsl-desktop/speech/runtime/venv/bin/python".into(),
        model_dir: "/home/test/models".into(),
        native_lib: "/home/test/libqwen.so".into(),
    }
}
impl Runtime for Fixture {
    fn install(
        &self,
        cancel: &Cancellation,
        progress: &dyn Fn(Progress),
    ) -> Result<SpeechConfig, String> {
        self.installs.fetch_add(1, Ordering::SeqCst);
        progress(Progress {
            stage: "下载并校验模型".into(),
            downloaded_bytes: 12,
            total_bytes: Some(12),
        });
        wait(&self.install_gate, cancel)?;
        Ok(config())
    }
}
impl crate::speech_settings::Runtime for Fixture {
    fn distribution(&self) -> Option<String> {
        Some("fixture".into())
    }
    fn inspect(
        &self,
        _: &SpeechConfig,
        cancel: &Cancellation,
        progress: &dyn Fn(u8),
    ) -> Result<Inspection, String> {
        self.inspections.fetch_add(1, Ordering::SeqCst);
        progress(10);
        wait(&self.inspect_gate, cancel)?;
        if self.inspect_error_once.swap(false, Ordering::SeqCst) {
            return Err("fixture transport error".into());
        }
        Ok(Inspection {
            environment_ok: self.good.load(Ordering::SeqCst),
            models_ok: self.good.load(Ordering::SeqCst),
            gpu_name: None,
            error: None,
        })
    }
    fn status(&self, _: &Cancellation) -> Result<ServiceStatus, String> {
        Ok(ServiceStatus {
            identity_valid: false,
            instance_id: None,
            service_state: if self.service_running.load(Ordering::SeqCst) {
                ServiceState::Running
            } else {
                ServiceState::Stopped
            },
            model_state: ModelState::Unloaded,
            gpu_name: None,
        })
    }
    fn start(&self, _: &SpeechConfig, _: &Cancellation) -> Result<ManagedSession, String> {
        panic!("installer must never start")
    }
    fn prepare(&self, _: &ManagedSession, _: &Cancellation) -> Result<ServiceStatus, String> {
        panic!("installer must never prepare")
    }
    fn stop(&self, _: &ManagedSession) -> Result<(), String> {
        Ok(())
    }
}
fn setup() -> (
    Manager,
    Arc<SpeechManager>,
    Arc<Fixture>,
    std::path::PathBuf,
) {
    let fixture = Arc::new(Fixture::default());
    let path = std::env::temp_dir().join(format!(
        "dsh-install-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let speech = Arc::new(SpeechManager::new(&path, fixture.clone(), None).unwrap());
    let owner = speech.clone();
    let manager = Manager::new(
        fixture.clone(),
        Arc::new(move |s| {
            if matches!(
                s.status,
                InstallState::Completed | InstallState::Cancelled | InstallState::Error
            ) {
                // Terminal delivery must occur after admission was released.
                assert!(owner.begin_resource_download().is_ok());
            }
        }),
    );
    (manager, speech, fixture, path)
}
fn terminal(manager: &Manager) -> SpeechInstallStatus {
    let mut state = manager.shared.state.lock().unwrap();
    while state.status.status == InstallState::Installing {
        let (next, timeout) = manager
            .shared
            .changed
            .wait_timeout(state, Duration::from_secs(4))
            .unwrap();
        assert!(!timeout.timed_out());
        state = next;
    }
    state.status.clone()
}
#[test]
fn completed_requires_inspection_save_and_never_autoread_or_service() {
    let (m, s, f, path) = setup();
    f.install_gate.store(true, Ordering::SeqCst);
    f.good.store(true, Ordering::SeqCst);
    assert_eq!(m.start(s.clone()).unwrap().status, InstallState::Installing);
    for _ in 0..1000 {
        if f.inspections.load(Ordering::SeqCst) > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(m.snapshot().status, InstallState::Installing);
    assert!(!path.exists());
    f.inspect_gate.store(true, Ordering::SeqCst);
    assert_eq!(terminal(&m).status, InstallState::Completed);
    assert_eq!(s.get_snapshot().config, config());
    assert!(!s.get_preferences().auto_read);
    assert!(path.exists());
    std::fs::remove_file(path).unwrap();
}
#[test]
fn cancellation_concurrency_retry_and_shutdown_release_admission() {
    let (m, s, f, path) = setup();
    let first = m.start(s.clone()).unwrap();
    assert_eq!(m.start(s.clone()).unwrap().id, first.id);
    assert!(s.action(SpeechAction::Check).is_err());
    assert!(s.begin_resource_download().is_err());
    m.cancel();
    assert_eq!(terminal(&m).status, InstallState::Cancelled);
    assert!(!path.exists());
    f.good.store(true, Ordering::SeqCst);
    f.install_gate.store(true, Ordering::SeqCst);
    f.inspect_gate.store(true, Ordering::SeqCst);
    assert!(m.start(s.clone()).unwrap().id > first.id);
    assert_eq!(terminal(&m).status, InstallState::Completed);
    let count = f.installs.load(Ordering::SeqCst);
    m.start(s.clone()).unwrap();
    assert_eq!(terminal(&m).status, InstallState::Completed);
    assert_eq!(
        f.installs.load(Ordering::SeqCst),
        count,
        "valid installed config must never be modified"
    );
    std::fs::remove_file(path).unwrap();
    m.shutdown();
    assert!(m.start(s).is_err());
}
#[test]
fn inspection_failure_and_cancel_preserve_previous_configuration() {
    let (m, s, f, path) = setup();
    f.install_gate.store(true, Ordering::SeqCst);
    f.inspect_gate.store(true, Ordering::SeqCst);
    m.start(s.clone()).unwrap();
    assert_eq!(terminal(&m).status, InstallState::Error);
    assert!(!path.exists());
    f.inspect_gate.store(false, Ordering::SeqCst);
    f.good.store(true, Ordering::SeqCst);
    m.start(s.clone()).unwrap();
    m.shutdown();
    assert_eq!(m.snapshot().status, InstallState::Cancelled);
    assert!(!s.get_snapshot().configured);
    assert!(!path.exists());
}
#[test]
fn persistence_failure_never_reports_completed() {
    let (m, s, f, path) = setup();
    f.install_gate.store(true, Ordering::SeqCst);
    f.inspect_gate.store(true, Ordering::SeqCst);
    f.good.store(true, Ordering::SeqCst);
    std::fs::create_dir(&path).unwrap();
    m.start(s).unwrap();
    assert_eq!(terminal(&m).status, InstallState::Error);
    assert!(path.is_dir());
    std::fs::remove_dir(path).unwrap();
}
#[test]
fn status_schema_is_exact_and_cancellation_idle_is_idempotent() {
    let (m, _, _, _) = setup();
    let status = m.cancel();
    assert_eq!(status.status, InstallState::Idle);
    let v = serde_json::to_value(status).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 6);
    assert_eq!(v["status"], "idle");
    assert_eq!(v["id"], 0);
}
#[test]
fn running_external_service_blocks_installer_even_with_unknown_cached_state() {
    let (m, s, f, _) = setup();
    f.service_running.store(true, Ordering::SeqCst);
    assert_eq!(s.get_snapshot().service_state, ServiceState::Unknown);
    m.start(s).unwrap();
    assert_eq!(terminal(&m).status, InstallState::Error);
    assert_eq!(f.installs.load(Ordering::SeqCst), 0);
}
fn save_fixture(s: &SpeechManager, f: &Fixture) {
    f.good.store(true, Ordering::SeqCst);
    f.inspect_gate.store(true, Ordering::SeqCst);
    s.save_config(config()).unwrap();
    for _ in 0..1000 {
        if !s.get_snapshot().busy {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("save fixture timeout")
}
#[test]
fn old_inspection_transport_error_allows_repair_and_failed_check_keeps_bytes() {
    let (m, s, f, path) = setup();
    save_fixture(&s, &f);
    f.inspect_error_once.store(true, Ordering::SeqCst);
    f.install_gate.store(true, Ordering::SeqCst);
    m.start(s.clone()).unwrap();
    assert_eq!(terminal(&m).status, InstallState::Completed);
    assert_eq!(f.installs.load(Ordering::SeqCst), 1);
    let original = std::fs::read(&path).unwrap();
    f.good.store(false, Ordering::SeqCst);
    m.start(s.clone()).unwrap();
    assert_eq!(terminal(&m).status, InstallState::Error);
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(s.get_snapshot().config, config());
    std::fs::remove_file(path).unwrap();
}
#[test]
fn cancelling_after_inspection_progress_emits_new_idle_revision() {
    let f = Arc::new(Fixture::default());
    f.install_gate.store(true, Ordering::SeqCst);
    let events = Arc::new(Mutex::new(Vec::new()));
    let capture = events.clone();
    let path = std::env::temp_dir().join(format!(
        "dsh-install-cancel-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let speech = Arc::new(
        SpeechManager::new(
            &path,
            f.clone(),
            Some(Arc::new(move |s| capture.lock().unwrap().push(s))),
        )
        .unwrap(),
    );
    let installer = Manager::new(f, Arc::new(|_| {}));
    installer.start(speech.clone()).unwrap();
    for _ in 0..1000 {
        if events
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.busy && s.model_progress == Some(10))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let progress = events
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.busy && s.model_progress == Some(10))
        .unwrap()
        .revision;
    installer.cancel();
    assert_eq!(terminal(&installer).status, InstallState::Cancelled);
    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert!(!last.busy);
    assert!(last.operation.is_none());
    assert!(last.revision > progress);
    assert_eq!(last.revision, speech.get_snapshot().revision);
    assert!(!path.exists());
}
#[test]
fn serialized_status_passes_actual_typescript_validator() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let statuses: Vec<_> = [
        InstallState::Idle,
        InstallState::Installing,
        InstallState::Completed,
        InstallState::Cancelled,
        InstallState::Error,
    ]
    .into_iter()
    .map(|status| SpeechInstallStatus {
        id: 42,
        status,
        stage: "检测并保存语音配置".into(),
        downloaded_bytes: 2048,
        total_bytes: Some(2048),
        error: None,
    })
    .collect();
    let script = r#"const fs=require('node:fs'),ts=require('typescript');
const source=fs.readFileSync('src/speech-resources.ts','utf8').replace(/^import .*css.*;$/gm,'');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};new Function('module','exports','require',js)(mod,mod.exports,require);
for(const s of JSON.parse(process.argv[1]))if(!mod.exports.isSpeechInstallStatus(s))throw Error('Rust DTO rejected');"#;
    let result = std::process::Command::new("node")
        .current_dir(root)
        .args(["-e", script, &serde_json::to_string(&statuses).unwrap()])
        .output()
        .expect("node with project TypeScript dependency required");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
