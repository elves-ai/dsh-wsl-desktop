//! Resource DTOs and explicit download lifecycle, independent of Tauri/Windows.
#[cfg(test)]
#[path = "speech_resources_tests.rs"]
mod tests;
use crate::speech_settings::{Cancellation, Manager as SpeechManager, SpeechConfig};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendor {
    Amd,
    Nvidia,
    Mixed,
    Intel,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GpuDiscovery {
    pub vendor: GpuVendor,
    pub names: Vec<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PythonStatus {
    Ready,
    PythonTooOld,
    MissingRocmSdk,
    MissingCudaRuntime,
    MissingGpuRuntime,
    UnsupportedBackend,
    GpuUnknown,
    UnsupportedGpu,
    ProbeFailed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PythonEnvironment {
    pub path: String,
    pub version: String,
    pub ready: bool,
    pub status: PythonStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Discovery {
    pub gpu: GpuDiscovery,
    pub python_environments: Vec<PythonEnvironment>,
    pub model_dir: String,
    pub native_lib: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Initialization {
    pub config: SpeechConfig,
    pub config_path: String,
    pub reused_python: bool,
    pub created_venv: bool,
}
impl Initialization {
    fn validate(&self) -> Result<(), String> {
        validate_path(&self.config.python_path, false)?;
        validate_path(&self.config.model_dir, false)?;
        if !self.config.native_lib.is_empty() {
            validate_path(&self.config.native_lib, false)?;
        }
        validate_path(&self.config_path, false)?;
        if !self
            .config_path
            .ends_with("/.dsh-wsl-desktop/speech/config.json")
            || self.reused_python == self.created_venv
        {
            return Err("语音初始化结果无效。".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    ModelDir,
    PythonPath,
    NativeLib,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Idle,
    Downloading,
    Completed,
    Cancelled,
    Error,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadStatus {
    pub id: u64,
    pub status: DownloadState,
    pub model_dir: String,
    pub file: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Progress {
    pub file: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}
pub fn validate_path(value: &str, root: bool) -> Result<(), String> {
    if root && value == "/" {
        return Ok(());
    }
    SpeechConfig {
        python_path: value.into(),
        model_dir: value.into(),
        native_lib: value.into(),
    }
    .validate()
}
pub trait Runtime: Send + Sync + 'static {
    fn discover(&self, config: &SpeechConfig) -> Result<Discovery, String>;
    fn browse(&self, path: Option<String>, kind: PathKind) -> Result<Directory, String>;
    fn initialize(
        &self,
        config: &SpeechConfig,
        cancel: &Cancellation,
    ) -> Result<Initialization, String>;
    fn download(
        &self,
        path: &str,
        cancel: &Cancellation,
        progress: &dyn Fn(Progress),
    ) -> Result<(), String>;
}
type Listener = Arc<dyn Fn(DownloadStatus) + Send + Sync>;
struct State {
    status: DownloadStatus,
    cancel: Cancellation,
    closed: bool,
    initializing: bool,
    initialization_id: u64,
}
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    runtime: Arc<dyn Runtime>,
    listener: Listener,
}
pub struct Manager {
    shared: Arc<Shared>,
}
struct InitializationGuard(Arc<Shared>);
impl Drop for InitializationGuard {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.initializing = false;
        self.0.changed.notify_all();
    }
}
impl Manager {
    pub fn new(runtime: Arc<dyn Runtime>, listener: Listener) -> Self {
        Self {
            shared: Arc::new(Shared {
                runtime,
                listener,
                changed: Condvar::new(),
                state: Mutex::new(State {
                    status: DownloadStatus {
                        id: 0,
                        status: DownloadState::Idle,
                        model_dir: String::new(),
                        file: None,
                        downloaded_bytes: 0,
                        total_bytes: None,
                        error: None,
                    },
                    cancel: Cancellation::default(),
                    closed: false,
                    initializing: false,
                    initialization_id: 0,
                }),
            }),
        }
    }
    pub fn discover(&self, config: &SpeechConfig) -> Result<Discovery, String> {
        self.shared.runtime.discover(config)
    }
    pub fn browse(&self, path: Option<String>, kind: PathKind) -> Result<Directory, String> {
        if let Some(path) = &path {
            validate_path(path, true)?;
        }
        self.shared.runtime.browse(path, kind)
    }
    /// Explicit, local-only preparation. Never persists active Windows settings or starts a service.
    pub fn initialize(
        &self,
        config: SpeechConfig,
        speech: &SpeechManager,
    ) -> Result<Initialization, String> {
        for path in [&config.python_path, &config.model_dir, &config.native_lib] {
            if !path.is_empty() {
                validate_path(path, false)?;
            }
        }
        let mut state = self.shared.state.lock().unwrap();
        if state.closed || state.initializing || state.status.status == DownloadState::Downloading {
            return Err("另一项语音资源操作尚未结束。".into());
        }
        let lease = speech
            .begin_resource_download()
            .map_err(|_| "请先结束语音操作并停止服务，再初始化环境。".to_string())?;
        let cancel = Cancellation::default();
        state.initialization_id = state
            .initialization_id
            .checked_add(1)
            .ok_or("初始化版本号已用尽。")?;
        state.cancel = cancel.clone();
        state.initializing = true;
        self.shared.changed.notify_all();
        drop(state);
        let guard = InitializationGuard(self.shared.clone());
        let result = self
            .shared
            .runtime
            .initialize(&config, &cancel)
            .and_then(|result| {
                cancel.check()?;
                result.validate()?;
                Ok(result)
            });
        drop(lease);
        drop(guard);
        result
    }
    pub fn cancel_initialization(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if state.initializing {
            let id = state.initialization_id;
            state.cancel.cancel();
            // Cancellation acknowledgement means this exact worker has released its lease.
            while state.initializing && state.initialization_id == id {
                state = self.shared.changed.wait(state).unwrap();
            }
        }
    }
    /// Read-only admission hint for native path dialogs; never starts resource work.
    pub fn is_busy(&self) -> bool {
        let state = self.shared.state.lock().unwrap();
        state.closed || state.initializing || state.status.status == DownloadState::Downloading
    }
    pub fn snapshot(&self) -> DownloadStatus {
        self.shared.state.lock().unwrap().status.clone()
    }
    pub fn start(
        &self,
        model_dir: String,
        speech: &SpeechManager,
    ) -> Result<DownloadStatus, String> {
        validate_path(&model_dir, false)?;
        let mut state = self.shared.state.lock().unwrap();
        if state.closed || state.initializing || state.status.status == DownloadState::Downloading {
            return Err("另一项模型下载尚未结束。".into());
        }
        let lease = speech.begin_resource_download()?;
        let id = state
            .status
            .id
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or("下载版本号已用尽。")?;
        let cancel = Cancellation::default();
        state.cancel = cancel.clone();
        state.status = DownloadStatus {
            id,
            status: DownloadState::Downloading,
            model_dir: model_dir.clone(),
            file: None,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
        };
        let snapshot = state.status.clone();
        drop(state);
        (self.shared.listener)(snapshot.clone());
        let shared = self.shared.clone();
        let spawned = std::thread::Builder::new()
            .name("speech-model-download".into())
            .spawn(move || {
                let result = shared.runtime.download(&model_dir, &cancel, &|progress| {
                    let update = {
                        let mut state = shared.state.lock().unwrap();
                        if state.status.id != id || cancel.is_cancelled() {
                            return;
                        }
                        state.status.file = progress.file;
                        state.status.downloaded_bytes =
                            state.status.downloaded_bytes.max(progress.downloaded_bytes);
                        state.status.total_bytes = progress.total_bytes;
                        state.status.clone()
                    };
                    (shared.listener)(update);
                });
                // Release speech admission before publishing a terminal status.
                drop(lease);
                let update = {
                    let mut state = shared.state.lock().unwrap();
                    state.status.status = if cancel.is_cancelled() {
                        DownloadState::Cancelled
                    } else if result.is_ok() {
                        DownloadState::Completed
                    } else {
                        DownloadState::Error
                    };
                    state.status.error = if cancel.is_cancelled() {
                        None
                    } else {
                        result.err()
                    };
                    let update = state.status.clone();
                    shared.changed.notify_all();
                    update
                };
                (shared.listener)(update);
            });
        if spawned.is_err() {
            let update = {
                let mut state = self.shared.state.lock().unwrap();
                state.status.status = DownloadState::Error;
                state.status.error = Some("无法启动模型下载线程。".into());
                self.shared.changed.notify_all();
                state.status.clone()
            };
            (self.shared.listener)(update);
            return Err("无法启动模型下载线程。".into());
        }
        Ok(snapshot)
    }
    /// Idempotent. Downloading remains visible until the helper has cleaned up.
    pub fn cancel(&self) -> DownloadStatus {
        let state = self.shared.state.lock().unwrap();
        if state.status.status == DownloadState::Downloading {
            state.cancel.cancel();
        }
        state.status.clone()
    }
    pub fn shutdown(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.closed = true;
        state.cancel.cancel();
        while state.initializing || state.status.status == DownloadState::Downloading {
            state = self.shared.changed.wait(state).unwrap();
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
