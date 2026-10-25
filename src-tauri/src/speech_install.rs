//! One installation owner, cancellable until the existing inspection/save commits.
use crate::speech_settings::{Cancellation, Manager as SpeechManager, SpeechConfig};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Condvar, Mutex};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    Idle,
    Installing,
    Completed,
    Cancelled,
    Error,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechInstallStatus {
    pub id: u64,
    pub status: InstallState,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Progress {
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}
pub trait Runtime: Send + Sync + 'static {
    fn install(
        &self,
        cancel: &Cancellation,
        progress: &dyn Fn(Progress),
    ) -> Result<SpeechConfig, String>;
}
type Listener = Arc<dyn Fn(SpeechInstallStatus) + Send + Sync>;
struct State {
    status: SpeechInstallStatus,
    cancel: Cancellation,
    closed: bool,
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
impl Manager {
    pub fn new(runtime: Arc<dyn Runtime>, listener: Listener) -> Self {
        Self {
            shared: Arc::new(Shared {
                runtime,
                listener,
                changed: Condvar::new(),
                state: Mutex::new(State {
                    status: SpeechInstallStatus {
                        id: 0,
                        status: InstallState::Idle,
                        stage: "尚未安装".into(),
                        downloaded_bytes: 0,
                        total_bytes: None,
                        error: None,
                    },
                    cancel: Cancellation::default(),
                    closed: false,
                }),
            }),
        }
    }
    pub fn snapshot(&self) -> SpeechInstallStatus {
        self.shared.state.lock().unwrap().status.clone()
    }
    pub fn is_busy(&self) -> bool {
        let s = self.shared.state.lock().unwrap();
        s.closed || s.status.status == InstallState::Installing
    }
    pub fn start(&self, speech: Arc<SpeechManager>) -> Result<SpeechInstallStatus, String> {
        let mut state = self.shared.state.lock().unwrap();
        if state.closed {
            return Err("语音安装器已关闭。".into());
        }
        if state.status.status == InstallState::Installing {
            return Ok(state.status.clone());
        }
        // Shared admission also excludes initialize/download/start/check/path-save.
        let lease = speech.begin_resource_download()?;
        let id = state
            .status
            .id
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("安装版本号已用尽。")?;
        let cancel = Cancellation::default();
        state.cancel = cancel.clone();
        state.status = SpeechInstallStatus {
            id,
            status: InstallState::Installing,
            stage: "准备安装".into(),
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
        };
        let snapshot = state.status.clone();
        drop(state);
        (self.shared.listener)(snapshot.clone());
        let shared = self.shared.clone();
        let spawned = std::thread::Builder::new()
            .name("speech-install".into())
            .spawn(move || {
                let progress = |p: Progress| {
                    let mut state = shared.state.lock().unwrap();
                    if state.status.id != id
                        || state.status.status != InstallState::Installing
                        || cancel.is_cancelled()
                    {
                        return;
                    }
                    state.status.stage = p.stage;
                    state.status.downloaded_bytes =
                        state.status.downloaded_bytes.max(p.downloaded_bytes);
                    state.status.total_bytes = p.total_bytes;
                    // Serialize notifications with cancellation; same-id status never regresses.
                    (shared.listener)(state.status.clone());
                };
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    progress(Progress {
                        stage: "检查已有语音配置".into(),
                        downloaded_bytes: 0,
                        total_bytes: None,
                    });
                    // A valid installation must not be mutated by pip or rebuilt under its users.
                    if speech.reuse_install_config(&lease, &cancel)? {
                        return Ok(());
                    }
                    speech.ensure_install_stopped(&lease, &cancel)?;
                    let config = shared.runtime.install(&cancel, &progress)?;
                    cancel.check()?;
                    progress(Progress {
                        stage: "检测并保存语音配置".into(),
                        downloaded_bytes: 0,
                        total_bytes: None,
                    });
                    speech
                        .save_install_config(&lease, config, &cancel)
                        .map(|_| ())
                }))
                .unwrap_or_else(|_| Err("语音安装工作线程异常，未确认成功。".into()));
                drop(lease);
                let mut state = shared.state.lock().unwrap();
                // Successful atomic commit wins over a cancellation arriving after commit.
                state.status.status = if result.is_ok() {
                    InstallState::Completed
                } else if cancel.is_cancelled() {
                    InstallState::Cancelled
                } else {
                    InstallState::Error
                };
                state.status.stage = match state.status.status {
                    InstallState::Completed => "安装完成",
                    InstallState::Cancelled => "安装已取消",
                    _ => "安装失败",
                }
                .into();
                state.status.error = if state.status.status == InstallState::Error {
                    result.err()
                } else {
                    None
                };
                (shared.listener)(state.status.clone());
                shared.changed.notify_all();
            });
        if spawned.is_err() {
            let mut state = self.shared.state.lock().unwrap();
            state.status.status = InstallState::Error;
            state.status.stage = "安装失败".into();
            state.status.error = Some("无法启动语音安装线程。".into());
            (self.shared.listener)(state.status.clone());
            self.shared.changed.notify_all();
            return Err("无法启动语音安装线程。".into());
        }
        Ok(snapshot)
    }
    pub fn cancel(&self) -> SpeechInstallStatus {
        let mut state = self.shared.state.lock().unwrap();
        if state.status.status == InstallState::Installing {
            state.cancel.cancel();
            state.status.stage = "正在取消并清理".into();
            (self.shared.listener)(state.status.clone());
        }
        state.status.clone()
    }
    pub fn shutdown(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.closed = true;
        state.cancel.cancel();
        while state.status.status == InstallState::Installing {
            state = self.shared.changed.wait(state).unwrap();
        }
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
#[path = "speech_install_tests.rs"]
mod tests;
