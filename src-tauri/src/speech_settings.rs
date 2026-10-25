//! Pure speech settings/controller. Runtime owns all OS/WSL transport; no Tauri.
//! Workers are cancellable and revision fenced. Only successful candidate checks persist.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
};

const FILE_LIMIT: u64 = 32 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechConfig {
    pub python_path: String,
    pub model_dir: String,
    pub native_lib: String,
}
pub(crate) const DEFAULT_PYTHON_GUIDANCE: &str =
    "语音仅使用默认 WSL 用户的 ~/.dsh-wsl-desktop/speech/runtime/venv/bin/python；请先初始化默认语音环境。";

/// Lexical preflight only: the WSL helper verifies the complete path against its real HOME.
pub(crate) fn validate_python_path(path: &str) -> Result<(), String> {
    if !path
        .strip_suffix("/.dsh-wsl-desktop/speech/runtime/venv/bin/python")
        .is_some_and(|home| home.starts_with('/'))
    {
        return Err(DEFAULT_PYTHON_GUIDANCE.into());
    }
    Ok(())
}
impl SpeechConfig {
    pub fn validate(&self) -> Result<(), String> {
        validate_python_path(&self.python_path)?;
        self.validate_paths()
    }
    pub(crate) fn validate_paths(&self) -> Result<(), String> {
        for value in [&self.model_dir, &self.native_lib]
            .into_iter()
            .chain((!self.python_path.is_empty()).then_some(&self.python_path))
        {
            if value.len() > 4096
                || !value.starts_with('/')
                || value.starts_with("//")
                || value.contains(['\\', ':'])
                || value.chars().any(char::is_control)
                || value
                    .split('/')
                    .skip(1)
                    .any(|p| p.is_empty() || p == "." || p == "..")
            {
                return Err("请填写规范的 WSL 绝对路径，不允许控制字符。".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechPreferences {
    pub revision: u64,
    pub initialized: bool,
    pub auto_read: bool,
    pub volume: u8,
}
impl Default for SpeechPreferences {
    fn default() -> Self {
        Self {
            revision: 0,
            initialized: false,
            auto_read: false,
            volume: 100,
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreferencesPatch {
    pub auto_read: Option<bool>,
    pub volume: Option<u8>,
    pub migrate: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Unknown,
    Checking,
    Passed,
    Error,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Unknown,
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    None,
    Managed,
    External,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelState {
    Unknown,
    Unloaded,
    Loading,
    Ready,
    Generating,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechSnapshot {
    pub revision: u64,
    pub configured: bool,
    pub config: SpeechConfig,
    pub distribution: Option<String>,
    pub busy: bool,
    pub operation: Option<String>,
    pub environment_state: CheckState,
    pub models_state: CheckState,
    pub model_progress: Option<u8>,
    pub service_state: ServiceState,
    pub ownership: Ownership,
    pub model_state: ModelState,
    pub gpu_name: Option<String>,
    pub message: String,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechAction {
    Refresh,
    Check,
    CancelCheck,
    Start,
    Stop,
}

/// Cloneable cooperative cancellation. Adapters must check while waiting as well as before I/O.
#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("语音操作已取消。".into())
        } else {
            Ok(())
        }
    }
}

/// This is never a DTO, Debug value, event, persisted value, or public snapshot.
/// Runtime must generate both values with OS randomness, not PID/port/time.
#[derive(Clone)]
pub struct ManagedSession {
    instance_id: String,
    control_token: String,
}
impl ManagedSession {
    pub fn new(instance_id: String, control_token: String) -> Result<Self, String> {
        if !(16..=128).contains(&instance_id.len())
            || !instance_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || control_token.len() != 64
            || !control_token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("受管语音服务身份无效。".into());
        }
        Ok(Self {
            instance_id,
            control_token,
        })
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
    pub fn control_token(&self) -> &str {
        &self.control_token
    }
    fn same(&self, other: &Self) -> bool {
        self.instance_id == other.instance_id && self.control_token == other.control_token
    }
}

#[derive(Clone, Debug)]
pub struct Inspection {
    pub environment_ok: bool,
    pub models_ok: bool,
    pub gpu_name: Option<String>,
    /// Static allowlisted Chinese explanation selected from known error codes only.
    /// Never raw subprocess output, paths, tokens or remote prose.
    pub error: Option<String>,
}
#[derive(Clone, Debug)]
pub struct ServiceStatus {
    pub identity_valid: bool,
    pub instance_id: Option<String>,
    pub service_state: ServiceState,
    pub model_state: ModelState,
    pub gpu_name: Option<String>,
}

/// Blocking bounded adapter operations run on controller workers (not the UI thread).
/// status is lightweight: no model import/load, GPU probe or file hashing.
/// inspect reports actual bytes-hashed percentages only and kills its helper on cancellation.
/// start must clean up failures/cancellation before returning Err; successful late starts
/// return their exact session so the controller can release them safely.
/// stop must authenticate BOTH token and instance, cancel queues/model and release only
/// that exact child. Never infer ownership from PID, port, health or public instance alone.
pub trait Runtime: Send + Sync + 'static {
    fn distribution(&self) -> Option<String>;
    fn inspect(
        &self,
        config: &SpeechConfig,
        cancel: &Cancellation,
        progress: &dyn Fn(u8),
    ) -> Result<Inspection, String>;
    /// Pure bounded status reads may overlap model operations after refresh preemption.
    /// Must never load models, mutate model files, or start/stop a service.
    fn status(&self, cancel: &Cancellation) -> Result<ServiceStatus, String>;
    fn start(&self, config: &SpeechConfig, cancel: &Cancellation)
        -> Result<ManagedSession, String>;
    fn prepare(
        &self,
        session: &ManagedSession,
        cancel: &Cancellation,
    ) -> Result<ServiceStatus, String>;
    fn stop(&self, session: &ManagedSession) -> Result<(), String>;
    fn cancel_requests(&self, _request_id: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Persisted {
    config: Option<SpeechConfig>,
    preferences: SpeechPreferences,
}
struct Store {
    path: PathBuf,
}
impl Store {
    fn load(&self) -> Result<Persisted, String> {
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) if !metadata.is_file() => return Err("语音设置必须是普通文件。".into()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Persisted::default()),
            Err(_) => return Err("无法读取语音设置；原文件未修改。".into()),
            _ => {}
        }
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Persisted::default()),
            Err(_) => return Err("无法读取语音设置；原文件未修改。".into()),
        };
        if !file.metadata().map_err(|_| "无法读取语音设置。")?.is_file() {
            return Err("语音设置必须是普通文件。".into());
        }
        let mut bytes = Vec::new();
        file.take(FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取语音设置。")?;
        if bytes.len() as u64 > FILE_LIMIT
            || bytes.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'{')
        {
            return Err("语音设置损坏或文件过大；原文件未修改。".into());
        }
        let mut data: Persisted = serde_json::from_slice(&bytes)
            .map_err(|_| "语音设置损坏或含未知字段；原文件未修改。")?;
        if let Some(config) = &mut data.config {
            config.validate_paths()?;
            if validate_python_path(&config.python_path).is_err() {
                // Keep model/native choices, but never project a legacy interpreter as runnable.
                // Loading alone must not rewrite the original settings file.
                config.python_path.clear();
            }
        }
        if data.preferences.volume > 100 {
            return Err("语音音量必须为 0 至 100。".into());
        }
        Ok(data)
    }
    fn save(&self, data: &Persisted) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(|_| "无法创建语音设置目录。")?;
        let bytes = serde_json::to_vec(data).map_err(|_| "无法编码语音设置。")?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err("语音设置文件过大。".into());
        }
        let (temp, mut file) = create_temporary(parent)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存语音设置；原文件未修改。")?;
        drop(file);
        atomic_replace(&temp.0, &self.path).map_err(|_| "无法替换语音设置；原文件未修改。")?;
        #[cfg(unix)]
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn create_temporary(parent: &Path) -> Result<(Temporary, File), String> {
    for _ in 0..32 {
        let path = parent.join(format!(
            ".speech-settings-{}-{}.tmp",
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
            Ok(file) => return Ok((Temporary(path), file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建语音设置临时文件。".into()),
        }
    }
    Err("无法创建语音设置临时文件。".into())
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
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    for attempt in 0..100 {
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(5 | 32 | 33)) || attempt == 99 {
            return Err(error);
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    unreachable!()
}

/// Called outside the state lock. Must not block or call ensure_ready/shutdown.
pub type SnapshotListener = Arc<dyn Fn(SpeechSnapshot) + Send + Sync>;
struct Operation {
    id: u64,
    kind: &'static str,
    cancel: Cancellation,
    request_id: Option<String>,
}
struct State {
    data: Persisted,
    snapshot: SpeechSnapshot,
    operation: Option<Operation>,
    next_id: u64,
    owned: Option<ManagedSession>,
    cancelled_requests: std::collections::VecDeque<String>,
    closed: bool,
    resource_download: bool,
}
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    worker: Mutex<()>,
    // Read-only status polling must never reserve admission for model/file operations.
    refreshing: Mutex<()>,
    stopping: Mutex<()>,
    runtime: Arc<dyn Runtime>,
    store: Store,
    listener: Option<SnapshotListener>,
}
/// Share with Arc<Manager>, not by constructing multiple managers for the same file.
/// All file updates (paths AND preferences) are serialized by the same state lock.
pub struct Manager {
    shared: Arc<Shared>,
}
pub struct ResourceDownloadLease(Arc<Shared>);
impl Drop for ResourceDownloadLease {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().resource_download = false;
        self.0.changed.notify_all();
    }
}
impl Manager {
    pub fn new(
        path: impl Into<PathBuf>,
        runtime: Arc<dyn Runtime>,
        listener: Option<SnapshotListener>,
    ) -> Result<Self, String> {
        let store = Store { path: path.into() };
        let data = store.load()?;
        let snapshot = SpeechSnapshot {
            revision: 0,
            configured: data
                .config
                .as_ref()
                .is_some_and(|c| !c.python_path.is_empty()),
            config: data.config.clone().unwrap_or_default(),
            distribution: safe_label(runtime.distribution()),
            busy: false,
            operation: None,
            environment_state: CheckState::Unknown,
            models_state: CheckState::Unknown,
            model_progress: None,
            service_state: ServiceState::Unknown,
            ownership: Ownership::Unknown,
            model_state: ModelState::Unknown,
            gpu_name: None,
            message: if data
                .config
                .as_ref()
                .is_some_and(|c| c.python_path.is_empty())
            {
                format!("已忽略旧配置中的外置 Python。{DEFAULT_PYTHON_GUIDANCE}")
            } else {
                "尚未检查语音服务状态。".into()
            },
            error: None,
            logs: Vec::new(),
        };
        Ok(Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    data,
                    snapshot,
                    operation: None,
                    next_id: 0,
                    owned: None,
                    cancelled_requests: Default::default(),
                    closed: false,
                    resource_download: false,
                }),
                changed: Condvar::new(),
                worker: Mutex::new(()),
                refreshing: Mutex::new(()),
                stopping: Mutex::new(()),
                runtime,
                store,
                listener,
            }),
        })
    }
    /// Atomically excludes config checks and both explicit/automatic model starts.
    /// A lease does not mutate persisted settings or claim that a model is ready.
    pub fn begin_resource_download(&self) -> Result<ResourceDownloadLease, String> {
        let _worker = self
            .shared
            .worker
            .try_lock()
            .map_err(|_| "语音操作尚未结束，请稍后重试。")?;
        let _stopping = self
            .shared
            .stopping
            .try_lock()
            .map_err(|_| "语音服务正在停止。")?;
        let mut state = self.shared.state.lock().unwrap();
        if state.closed
            || state.resource_download
            || state
                .operation
                .as_ref()
                .is_some_and(|op| op.kind != "refresh")
            || state.owned.is_some()
            || matches!(
                state.snapshot.service_state,
                ServiceState::Starting | ServiceState::Running | ServiceState::Stopping
            )
        {
            return Err("请先结束语音操作并停止服务，再下载模型。".into());
        }
        let cancelled_refresh = state.operation.is_some();
        if cancelled_refresh {
            cancel_operation(&mut state);
            bump(&mut state, "已让出状态刷新，开始准备模型下载。");
        }
        state.resource_download = true;
        let snapshot = cancelled_refresh.then(|| state.snapshot.clone());
        let lease = ResourceDownloadLease(self.shared.clone());
        drop(state);
        drop(_stopping);
        drop(_worker);
        if let Some(snapshot) = snapshot {
            self.shared.emit(snapshot);
        }
        Ok(lease)
    }
    pub fn get_snapshot(&self) -> SpeechSnapshot {
        self.shared.state.lock().unwrap().snapshot.clone()
    }
    pub fn get_preferences(&self) -> SpeechPreferences {
        self.shared.state.lock().unwrap().data.preferences.clone()
    }
    pub fn set_preferences(&self, patch: PreferencesPatch) -> Result<SpeechPreferences, String> {
        let mut state = self.shared.state.lock().unwrap();
        if state.closed {
            return Err("语音控制器已关闭。".into());
        }
        if patch.volume.is_some_and(|v| v > 100) {
            return Err("语音音量必须为 0 至 100。".into());
        }
        if patch.migrate == Some(true) && state.data.preferences.initialized {
            return Ok(state.data.preferences.clone());
        }
        if patch.auto_read.is_none() && patch.volume.is_none() && patch.migrate != Some(true) {
            return Ok(state.data.preferences.clone());
        }
        let mut data = state.data.clone();
        if let Some(value) = patch.auto_read {
            data.preferences.auto_read = value;
        }
        if let Some(value) = patch.volume {
            data.preferences.volume = value;
        }
        data.preferences.initialized = true;
        if data.preferences == state.data.preferences {
            return Ok(data.preferences);
        }
        data.preferences.revision = data
            .preferences
            .revision
            .checked_add(1)
            .ok_or("语音偏好版本号已用尽。")?;
        self.shared.store.save(&data)?;
        state.data = data;
        Ok(state.data.preferences.clone())
    }
    pub fn save_config(&self, config: SpeechConfig) -> Result<SpeechSnapshot, String> {
        config.validate()?;
        self.launch("save", Some(config), None)
    }
    pub fn action(&self, action: SpeechAction) -> Result<SpeechSnapshot, String> {
        match action {
            SpeechAction::Refresh => self.launch("refresh", None, None),
            SpeechAction::Check => self.launch("check", None, None),
            SpeechAction::Start => self.launch("start", None, None),
            SpeechAction::Stop => self.launch("stop", None, None),
            SpeechAction::CancelCheck => {
                let snapshot = {
                    let mut state = self.shared.state.lock().unwrap();
                    if state
                        .operation
                        .as_ref()
                        .is_some_and(|op| op.kind == "check" || op.kind == "save")
                    {
                        cancel_operation(&mut state);
                        state.snapshot.environment_state = CheckState::Unknown;
                        state.snapshot.models_state = CheckState::Unknown;
                        state.snapshot.model_progress = None;
                        bump(&mut state, "语音检查已取消。");
                    }
                    state.snapshot.clone()
                };
                self.shared.emit(snapshot.clone());
                Ok(snapshot)
            }
        }
    }
    /// Blocking readiness barrier; use from the caller's blocking executor. A request
    /// can cancel only the auto-start operation it initiated, never a newer UI start.
    pub fn ensure_ready(&self, request_id: &str) -> Result<SpeechSnapshot, String> {
        validate_request_id(request_id)?;
        {
            let state = self.shared.state.lock().unwrap();
            if state.cancelled_requests.iter().any(|id| id == request_id) {
                return Err("语音请求已取消。".into());
            }
        }
        self.launch("start", None, Some(request_id.into()))?;
        let mut state = self.shared.state.lock().unwrap();
        loop {
            if state.closed || state.cancelled_requests.iter().any(|id| id == request_id) {
                return Err("语音请求已取消。".into());
            }
            if !state.snapshot.busy {
                if state.snapshot.service_state == ServiceState::Running
                    && matches!(
                        state.snapshot.model_state,
                        ModelState::Ready | ModelState::Generating
                    )
                    && matches!(
                        state.snapshot.ownership,
                        Ownership::Managed | Ownership::External
                    )
                {
                    return Ok(state.snapshot.clone());
                }
                return Err(state
                    .snapshot
                    .error
                    .clone()
                    .unwrap_or_else(|| "语音模型尚未就绪。".into()));
            }
            state = self.shared.changed.wait(state).unwrap();
        }
    }
    pub fn cancel_request(&self, request_id: &str) -> Result<(), String> {
        validate_request_id(request_id)?;
        let should_stop = {
            let mut state = self.shared.state.lock().unwrap();
            if !state.cancelled_requests.iter().any(|id| id == request_id) {
                if state.cancelled_requests.len() >= 128 {
                    state.cancelled_requests.pop_front();
                }
                state.cancelled_requests.push_back(request_id.into());
            }
            let matches = state
                .operation
                .as_ref()
                .is_some_and(|op| op.request_id.as_deref() == Some(request_id));
            if matches {
                state.operation.as_ref().unwrap().cancel.cancel();
            }
            self.shared.changed.notify_all();
            matches
        };
        let result = self
            .shared
            .runtime
            .cancel_requests(request_id)
            .map_err(|_| "无法取消语音请求。".to_string());
        if should_stop {
            self.launch("stop", None, Some(request_id.into()))?;
        }
        result
    }
    /// Exit must call this before tearing down the runtime. Late successful starts
    /// see closed/cancelled and clean up their own exact managed session.
    pub fn shutdown(&self) {
        let owned = {
            let mut state = self.shared.state.lock().unwrap();
            state.closed = true;
            cancel_operation(&mut state);
            self.shared.changed.notify_all();
            state.owned.take()
        };
        if let Some(session) = owned {
            if self.shared.runtime.stop(&session).is_err() {
                self.shared.state.lock().unwrap().owned = Some(session);
            }
        }
        // Cancellation alone is insufficient at process exit: drain any in-flight
        // launch so a successful late child is released before the caller quits.
        drop(self.shared.worker.lock().unwrap());
        drop(self.shared.refreshing.lock().unwrap());
        drop(self.shared.stopping.lock().unwrap());
        let remaining = self.shared.state.lock().unwrap().owned.take();
        if let Some(session) = remaining {
            if self.shared.runtime.stop(&session).is_err() {
                self.shared.state.lock().unwrap().owned = Some(session);
            }
        }
    }
    fn launch(
        &self,
        kind: &'static str,
        candidate: Option<SpeechConfig>,
        request_id: Option<String>,
    ) -> Result<SpeechSnapshot, String> {
        let distribution = safe_label(self.shared.runtime.distribution());
        let (id, cancel, config, snapshot) = {
            let mut state = self.shared.state.lock().unwrap();
            if state.closed {
                return Err("语音控制器已关闭。".into());
            }
            if state.resource_download && matches!(kind, "save" | "check" | "start") {
                return Err("模型正在下载，请完成或取消下载后再操作。".into());
            }
            // A live model must never silently retain old paths while the saved
            // configuration changes underneath it. Check before superseding work.
            if kind == "save"
                && candidate.as_ref() != state.data.config.as_ref()
                && (state.owned.is_some()
                    || matches!(
                        state.snapshot.service_state,
                        ServiceState::Starting | ServiceState::Running | ServiceState::Stopping
                    ))
            {
                return Err("请先停止语音服务后再修改路径".into());
            }
            if kind == "stop"
                && request_id.is_some()
                && !state
                    .operation
                    .as_ref()
                    .is_some_and(|op| op.request_id == request_id)
            {
                return Ok(state.snapshot.clone());
            }
            if kind == "start"
                && request_id
                    .as_ref()
                    .is_some_and(|id| state.cancelled_requests.contains(id))
            {
                return Err("语音请求已取消。".into());
            }
            if state.operation.is_some() {
                // Refresh never interrupts expensive work; readiness joins an existing start.
                if kind == "refresh"
                    || (kind == "start"
                        && state
                            .operation
                            .as_ref()
                            .is_some_and(|op| op.kind == "start"))
                {
                    return Ok(state.snapshot.clone());
                }
                if !matches!(kind, "stop" | "save")
                    && !state
                        .operation
                        .as_ref()
                        .is_some_and(|op| op.kind == "refresh")
                {
                    return Err("另一项语音操作正在进行中。".into());
                }
                cancel_operation(&mut state);
            }
            let config = candidate.or_else(|| state.data.config.clone());
            if matches!(kind, "save" | "check" | "start") {
                if let Some(config) = &config {
                    config.validate()?;
                }
            }
            // An existing external ready service remains usable even without local paths.
            if matches!(kind, "save" | "check") && config.is_none() {
                return Err("请先配置语音路径。".into());
            }
            state.next_id = state
                .next_id
                .checked_add(1)
                .ok_or("语音操作版本号已用尽。")?;
            let id = state.next_id;
            let cancel = Cancellation::default();
            state.operation = Some(Operation {
                id,
                kind,
                cancel: cancel.clone(),
                request_id,
            });
            if state.owned.is_none() {
                state.snapshot.distribution = distribution;
            }
            state.snapshot.busy = true;
            state.snapshot.operation = Some(kind.into());
            state.snapshot.error = None;
            if matches!(kind, "save" | "check") {
                state.snapshot.environment_state = CheckState::Checking;
                state.snapshot.models_state = CheckState::Checking;
                state.snapshot.model_progress = None;
            }
            if kind == "start" {
                state.snapshot.service_state = ServiceState::Starting;
            }
            if kind == "stop" {
                state.snapshot.service_state = ServiceState::Stopping;
            }
            bump(
                &mut state,
                match kind {
                    "save" | "check" => "正在检查语音环境和模型文件。",
                    "start" => "正在准备语音服务和模型。",
                    "stop" => "正在停止受管语音服务。",
                    _ => "正在刷新语音状态。",
                },
            );
            (id, cancel, config, state.snapshot.clone())
        };
        self.shared.emit(snapshot.clone());
        let shared = self.shared.clone();
        let spawn = thread::Builder::new()
            .name("speech-settings".into())
            .spawn(move || {
                if kind == "stop" {
                    run_stop(&shared, id, &cancel);
                    return;
                }
                // Status is a pure runtime read. Serialize polls separately so a slow
                // HTTP response cannot block explicit checks, starts or downloads.
                let _guard = if kind == "refresh" {
                    shared.refreshing.lock().unwrap()
                } else {
                    shared.worker.lock().unwrap()
                };
                if !shared.current(id, &cancel) {
                    return;
                }
                match kind {
                    "save" | "check" => {
                        run_inspect(&shared, id, kind == "save", config.unwrap(), &cancel)
                    }
                    "start" => run_start(&shared, id, config, &cancel),
                    _ => run_refresh(&shared, id, &cancel),
                }
            });
        if spawn.is_err() {
            self.shared.finish(id, |state| {
                fail(state, "无法启动语音工作线程。");
            });
        }
        Ok(snapshot)
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate_request_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        Err("语音请求标识无效。".into())
    } else {
        Ok(())
    }
}
fn safe_label(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
}
fn cancel_operation(state: &mut State) {
    if let Some(op) = state.operation.take() {
        op.cancel.cancel();
        if matches!(op.kind, "check" | "save") {
            state.snapshot.environment_state = CheckState::Unknown;
            state.snapshot.models_state = CheckState::Unknown;
            state.snapshot.model_progress = None;
        }
        if let Some(id) = op.request_id {
            if !state.cancelled_requests.contains(&id) {
                if state.cancelled_requests.len() >= 128 {
                    state.cancelled_requests.pop_front();
                }
                state.cancelled_requests.push_back(id);
            }
        }
    }
    state.snapshot.busy = false;
    state.snapshot.operation = None;
}
fn bump(state: &mut State, message: &str) {
    state.snapshot.revision = state.snapshot.revision.saturating_add(1);
    state.snapshot.message = message.into();
    if state.snapshot.logs.last().map(String::as_str) != Some(message) {
        state.snapshot.logs.push(message.into());
        if state.snapshot.logs.len() > 32 {
            state.snapshot.logs.remove(0);
        }
    }
}
fn fail(state: &mut State, message: &str) {
    state.snapshot.error = Some(message.into());
    bump(state, message);
}
impl Shared {
    fn emit(&self, snapshot: SpeechSnapshot) {
        self.changed.notify_all();
        if let Some(listener) = &self.listener {
            listener(snapshot);
        }
    }
    fn current(&self, id: u64, cancel: &Cancellation) -> bool {
        if cancel.is_cancelled() {
            return false;
        }
        let state = self.state.lock().unwrap();
        !state.closed && state.operation.as_ref().is_some_and(|op| op.id == id)
    }
    fn update(&self, id: u64, update: impl FnOnce(&mut State)) {
        let snapshot = {
            let mut state = self.state.lock().unwrap();
            if state.closed
                || !state
                    .operation
                    .as_ref()
                    .is_some_and(|op| op.id == id && !op.cancel.is_cancelled())
            {
                return;
            }
            update(&mut state);
            state.snapshot.clone()
        };
        self.emit(snapshot);
    }
    fn finish(&self, id: u64, update: impl FnOnce(&mut State)) {
        self.update(id, |state| {
            update(state);
            state.operation = None;
            state.snapshot.busy = false;
            state.snapshot.operation = None;
        });
    }
}

fn apply_status(state: &mut State, status: ServiceStatus) {
    state.snapshot.service_state = status.service_state;
    state.snapshot.gpu_name = safe_label(status.gpu_name);
    if status.service_state == ServiceState::Stopped {
        state.snapshot.ownership = Ownership::None;
        state.snapshot.model_state = ModelState::Unloaded;
    } else if status.identity_valid {
        state.snapshot.ownership = if state
            .owned
            .as_ref()
            .is_some_and(|s| Some(s.instance_id()) == status.instance_id.as_deref())
        {
            Ownership::Managed
        } else {
            Ownership::External
        };
        state.snapshot.model_state = status.model_state;
    } else {
        state.snapshot.ownership = Ownership::Unknown;
        state.snapshot.model_state = ModelState::Unknown;
    }
}
fn run_refresh(shared: &Shared, id: u64, cancel: &Cancellation) {
    let result = shared.runtime.status(cancel);
    shared.finish(id, |state| match result {
        Ok(status) => {
            apply_status(state, status);
            bump(state, "语音状态已刷新。");
        }
        Err(_) => {
            state.snapshot.service_state = ServiceState::Unknown;
            state.snapshot.model_state = ModelState::Unknown;
            state.snapshot.ownership = Ownership::Unknown;
            fail(state, "无法读取语音服务状态。");
        }
    });
}
fn run_inspect(shared: &Shared, id: u64, save: bool, config: SpeechConfig, cancel: &Cancellation) {
    let result = shared.runtime.inspect(&config, cancel, &|progress| {
        if progress > 100 {
            return;
        }
        shared.update(id, |state| {
            if state
                .snapshot
                .model_progress
                .is_none_or(|old| progress >= old)
            {
                state.snapshot.model_progress = Some(progress);
                bump(state, "正在校验模型文件哈希。");
            }
        });
    });
    shared.finish(id, |state| match result {
        Ok(result) => {
            state.snapshot.environment_state = if result.environment_ok {
                CheckState::Passed
            } else {
                CheckState::Error
            };
            // Environment checks short-circuit hashing; a skipped model check
            // is unknown, not evidence of corrupt or missing model files.
            state.snapshot.models_state = if !result.environment_ok {
                CheckState::Unknown
            } else if result.models_ok {
                CheckState::Passed
            } else {
                CheckState::Error
            };
            state.snapshot.gpu_name = safe_label(result.gpu_name);
            if !result.environment_ok || !result.models_ok {
                fail(state, "语音环境或模型检查未通过；已保留原路径。");
                if let Some(error) = result
                    .error
                    .filter(|e| !e.is_empty() && e.len() <= 512 && !e.chars().any(char::is_control))
                {
                    state.snapshot.error = Some(error);
                }
                return;
            }
            if save {
                let mut data = state.data.clone();
                data.config = Some(config.clone());
                // This lock fences cancellation/new operations through atomic commit.
                if shared.store.save(&data).is_err() {
                    fail(state, "无法保存语音路径；已保留原设置。");
                    return;
                }
                state.data = data;
                state.snapshot.config = config;
                state.snapshot.configured = true;
            }
            bump(
                state,
                if save {
                    "语音路径检查通过并已保存。"
                } else {
                    "语音环境和模型文件检查通过。"
                },
            );
        }
        Err(_) => {
            state.snapshot.environment_state = CheckState::Error;
            state.snapshot.models_state = CheckState::Unknown;
            fail(state, "语音检查失败；已保留原路径。");
        }
    });
}

fn ready(status: &ServiceStatus) -> bool {
    status.identity_valid
        && status.service_state == ServiceState::Running
        && matches!(
            status.model_state,
            ModelState::Ready | ModelState::Generating
        )
}
fn run_start(shared: &Shared, id: u64, config: Option<SpeechConfig>, cancel: &Cancellation) {
    let status = match shared.runtime.status(cancel) {
        Ok(status) => status,
        Err(_) => {
            shared.finish(id, |state| {
                state.snapshot.service_state = ServiceState::Unknown;
                state.snapshot.model_state = ModelState::Unknown;
                fail(state, "无法读取语音状态；未接管任何服务。");
            });
            return;
        }
    };
    if !shared.current(id, cancel) {
        return;
    }
    if ready(&status) {
        shared.finish(id, |state| {
            apply_status(state, status);
            bump(state, "语音模型已就绪。");
        });
        return;
    }
    let owned = {
        let state = shared.state.lock().unwrap();
        state
            .owned
            .as_ref()
            .filter(|s| {
                status.identity_valid && status.instance_id.as_deref() == Some(s.instance_id())
            })
            .cloned()
    };
    let session = if let Some(owned) = owned {
        owned
    } else {
        if status.service_state != ServiceState::Stopped {
            shared.finish(id, |state| {
                apply_status(state, status);
                fail(state, "现有语音服务尚未就绪；未接管该服务。");
            });
            return;
        }
        let Some(config) = config else {
            shared.finish(id, |state| {
                apply_status(state, status);
                fail(state, "启动前请先配置并检查语音路径。");
            });
            return;
        };
        // Public absence does not prove our old child exited. Release its exact
        // identity before replacing the only owned slot; never orphan a prior child.
        let previous = shared.state.lock().unwrap().owned.clone();
        if let Some(previous) = previous {
            if !release_session(shared, &previous) {
                shared.finish(id, |state| {
                    fail(state, "旧受管语音服务尚未释放；请先重试停止。");
                });
                return;
            }
        }
        if !shared.current(id, cancel) {
            return;
        }
        let session = match shared.runtime.start(&config, cancel) {
            Ok(session) => session,
            Err(_) => {
                shared.finish(id, |state| {
                    state.snapshot.service_state = ServiceState::Error;
                    state.snapshot.model_state = ModelState::Error;
                    fail(state, "受管语音服务启动失败。");
                });
                return;
            }
        };
        let accepted = {
            let mut state = shared.state.lock().unwrap();
            if state.closed
                || cancel.is_cancelled()
                || !state.operation.as_ref().is_some_and(|op| op.id == id)
            {
                false
            } else {
                state.owned = Some(session.clone());
                true
            }
        };
        if !accepted {
            // The worker gate guarantees no newer launch has claimed the slot.
            // Track even late starts until authenticated release succeeds.
            shared.state.lock().unwrap().owned = Some(session.clone());
            release_session(shared, &session);
            return;
        }
        session
    };
    if !shared.current(id, cancel) {
        release_session(shared, &session);
        return;
    }
    shared.update(id, |state| {
        state.snapshot.service_state = ServiceState::Running;
        state.snapshot.ownership = Ownership::Managed;
        state.snapshot.model_state = ModelState::Loading;
        bump(state, "正在加载语音模型。");
    });
    let prepared = shared.runtime.prepare(&session, cancel);
    if !shared.current(id, cancel) {
        release_session(shared, &session);
        return;
    }
    match prepared {
        Ok(status)
            if ready(&status) && status.instance_id.as_deref() == Some(session.instance_id()) =>
        {
            shared.finish(id, |state| {
                apply_status(state, status);
                bump(state, "语音模型已就绪。");
            });
        }
        _ => {
            release_session(shared, &session);
            shared.finish(id, |state| {
                state.snapshot.service_state = ServiceState::Error;
                state.snapshot.model_state = ModelState::Error;
                state.snapshot.ownership = if state.owned.is_some() {
                    Ownership::Managed
                } else {
                    Ownership::None
                };
                fail(state, "语音模型准备失败；已尝试释放受管服务。");
            });
        }
    }
}
/// Taking the owned slot prevents two cancellation paths from releasing the same
/// session concurrently. An unsuccessful release stays tracked for exit/retry.
fn release_session(shared: &Shared, session: &ManagedSession) -> bool {
    let taken = {
        let mut state = shared.state.lock().unwrap();
        if state.owned.as_ref().is_some_and(|s| s.same(session)) {
            state.owned.take()
        } else {
            None
        }
    };
    let Some(taken) = taken else {
        return true;
    };
    if shared.runtime.stop(&taken).is_ok() {
        return true;
    }
    let mut state = shared.state.lock().unwrap();
    if state.owned.is_none() {
        state.owned = Some(taken);
    }
    false
}
fn run_stop(shared: &Shared, id: u64, cancel: &Cancellation) {
    let _stop_guard = shared.stopping.lock().unwrap();
    let owned = {
        let state = shared.state.lock().unwrap();
        if state.closed
            || cancel.is_cancelled()
            || !state.operation.as_ref().is_some_and(|op| op.id == id)
        {
            return;
        }
        state.owned.clone()
    };
    let mut released = owned
        .as_ref()
        .is_none_or(|session| release_session(shared, session));
    // Wait for an older start/check to finish cancellation and late-start cleanup.
    let _guard = shared.worker.lock().unwrap();
    if !shared.current(id, cancel) {
        return;
    }
    let remaining = shared.state.lock().unwrap().owned.clone();
    if let Some(owned) = remaining {
        released = release_session(shared, &owned);
    }
    let status = shared.runtime.status(cancel);
    shared.finish(id, |state| {
        if let Ok(status) = status {
            apply_status(state, status);
        } else {
            state.snapshot.service_state = ServiceState::Unknown;
            state.snapshot.model_state = ModelState::Unknown;
            state.snapshot.ownership = Ownership::Unknown;
        }
        if released {
            bump(
                state,
                if matches!(
                    state.snapshot.ownership,
                    Ownership::External | Ownership::Unknown
                ) && state.snapshot.service_state != ServiceState::Stopped
                {
                    "非受管语音服务未执行关闭；请以实际状态为准。"
                } else {
                    "受管语音服务已停止。"
                },
            );
        } else {
            fail(state, "未能完全释放受管语音服务；请重试停止。");
        }
    });
}

#[cfg(test)]
#[path = "speech_settings_tests.rs"]
mod tests;
