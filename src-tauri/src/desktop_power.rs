//! Task-scoped Windows sleep inhibition. Independent of notification preferences.
use super::{assert_local, notifications, Controller};
use crate::power::{
    running_tasks, ActivityLease, NativeInhibitor, PowerGuard, PowerSettings, PowerSnapshot,
    SleepInhibitor,
};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, EventTarget, Webview};

struct Data {
    snapshot: PowerSnapshot,
    epoch: u64,
    settings_error: Option<String>,
}
pub(super) struct Power {
    directory: PathBuf,
    data: Mutex<Data>,
    wake: Condvar,
}
impl Power {
    pub(super) fn new(directory: PathBuf) -> Self {
        let (enabled, settings_error) = match PowerSettings::load(&directory) {
            Ok(settings) => (settings.enabled, None),
            Err(error) => (false, Some(error)),
        };
        let snapshot = PowerSnapshot {
            enabled,
            active: false,
            phase: if settings_error.is_some() {
                "error"
            } else if enabled {
                "connecting"
            } else {
                "disabled"
            }
            .into(),
            message: settings_error.clone().unwrap_or_else(|| {
                if enabled {
                    "等待 DSH 服务与工作窗口登录；仅在任务运行期间阻止自动休眠。"
                } else {
                    "任务防休眠已关闭，遵循系统原有电源策略。"
                }
                .into()
            }),
        };
        Self {
            directory,
            data: Mutex::new(Data {
                snapshot,
                epoch: 0,
                settings_error,
            }),
            wake: Condvar::new(),
        }
    }
    fn snapshot(&self) -> PowerSnapshot {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .clone()
    }
    fn publish(&self, app: &tauri::AppHandle) {
        let snapshot = self.snapshot();
        for label in ["launcher", "launcher-settings", "dsh-settings"] {
            let _ = app.emit_to(
                EventTarget::webview(label),
                "launcher-power-state",
                &snapshot,
            );
        }
    }
    fn wait(&self, epoch: u64) {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.epoch == epoch {
            drop(self.wake.wait_timeout(data, Duration::from_secs(3)));
        }
    }
    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        // Serialize persistence and generation changes. Native calls are worker-only.
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        PowerSettings { enabled }.save(&self.directory)?;
        data.epoch = data.epoch.wrapping_add(1);
        data.settings_error = None;
        data.snapshot.enabled = enabled;
        data.snapshot.phase = if enabled { "connecting" } else { "disabled" }.into();
        data.snapshot.message = if enabled {
            "已启用，正在检查运行中的任务。"
        } else if data.snapshot.active {
            "已关闭，正在释放防休眠请求。"
        } else {
            "任务防休眠已关闭，遵循系统原有电源策略。"
        }
        .into();
        Ok(())
    }
    /// Discard observations made before a setting change; never reacquire on a stale RPC.
    /// This method does not marshal to the UI thread while holding the state lock.
    fn reconcile<I: SleepInhibitor>(
        &self,
        epoch: u64,
        guard: &mut PowerGuard<I>,
        required: bool,
        phase: &str,
        message: &str,
    ) -> bool {
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.epoch != epoch {
            return false;
        }
        let previous = data.snapshot.clone();
        let result = guard.set_required(required && data.snapshot.enabled);
        data.snapshot.active = guard.active();
        match result {
            Err(error) => {
                data.snapshot.phase = "error".into();
                data.snapshot.message =
                    format!("{error} 将自动重试；当前防休眠状态以实际请求为准。");
            }
            Ok(()) => {
                data.snapshot.phase = phase.into();
                data.snapshot.message = message.into();
            }
        }
        data.snapshot != previous
    }
}

#[tauri::command]
pub(super) fn get_power_snapshot(
    window: Webview,
    state: tauri::State<'_, Arc<Power>>,
) -> Result<PowerSnapshot, String> {
    assert_local(&window)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub(super) async fn set_power_enabled(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Power>>,
    enabled: bool,
) -> Result<PowerSnapshot, String> {
    assert_local(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.set_enabled(enabled)?;
        state.publish(&app);
        state.wake.notify_all();
        Ok(state.snapshot())
    })
    .await
    .map_err(|_| "保存电源设置的线程异常结束。".to_owned())?
}

pub(super) fn start(app: tauri::AppHandle, controller: Arc<Controller>, state: Arc<Power>) {
    thread::spawn(move || {
        // SetThreadExecutionState is thread-scoped. Construct, use and drop on this
        // dedicated thread; neither the UI thread nor async runtime owns the request.
        let mut guard = PowerGuard::new(NativeInhibitor::default());
        let mut lease = ActivityLease::default();
        let clock = Instant::now();
        let mut generation = None;
        let mut last_log = String::new();
        loop {
            if controller.exiting.load(Ordering::SeqCst) {
                break;
            }
            let (enabled, epoch, settings_error) = {
                let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                (
                    data.snapshot.enabled,
                    data.epoch,
                    data.settings_error.clone(),
                )
            };
            if generation != Some(epoch) {
                lease.update(Some(false), clock.elapsed());
                generation = Some(epoch);
            }
            let (required, phase, message) = if !enabled {
                lease.update(Some(false), clock.elapsed());
                match settings_error {
                    Some(error) => (false, "error", error),
                    None => (
                        false,
                        "disabled",
                        "任务防休眠已关闭，遵循系统原有电源策略。".into(),
                    ),
                }
            } else if controller.snapshot().state != "ready" {
                lease.update(Some(false), clock.elapsed());
                (
                    false,
                    "connecting",
                    "等待本机 DSH 服务就绪；不会为防休眠自动启动服务。".into(),
                )
            } else {
                // Only session/list is needed; no conversation history is inspected.
                let observation = (|| {
                    let backend = controller.backend()?;
                    let rpc = notifications::client(&app, &backend.config.origin())?;
                    running_tasks(&rpc.list()?)
                })();
                let required = lease.update(observation.as_ref().ok().copied(), clock.elapsed());
                match observation {
                    Ok(true) => (
                        required,
                        "active",
                        "检测到运行中的任务，已阻止系统自动休眠；屏幕仍可正常熄灭。".into(),
                    ),
                    Ok(false) => (
                        false,
                        "idle",
                        "当前没有运行中的任务，遵循系统原有电源策略（约每 3 秒检查）。".into(),
                    ),
                    Err(error) => (
                        required,
                        "error",
                        format!(
                            "{error} 将自动重试；{}",
                            if required {
                                "暂时保留防休眠，距最后有效运行状态满 30 秒后释放。"
                            } else {
                                "当前未保持防休眠，遵循系统原有电源策略。"
                            }
                        ),
                    ),
                }
            };
            // A stop/quit may have happened while the bounded RPC was in flight.
            let ready = controller.snapshot().state == "ready";
            let exiting = controller.exiting.load(Ordering::SeqCst);
            let (required, phase, message) = if enabled && (!ready || exiting) {
                lease.update(Some(false), clock.elapsed());
                (
                    false,
                    "connecting",
                    "DSH 服务未就绪或启动器正在退出，正在释放防休眠请求。".into(),
                )
            } else {
                (required, phase, message)
            };
            let changed = state.reconcile(epoch, &mut guard, required, phase, &message);
            if changed {
                state.publish(&app);
                let snapshot = state.snapshot();
                let log = format!(
                    "电源管理：{} {}",
                    if snapshot.active {
                        "防休眠生效。"
                    } else {
                        "未保持防休眠。"
                    },
                    snapshot.message
                );
                if log != last_log {
                    controller.record(&app, &log);
                    last_log = log;
                }
            }
            state.wait(epoch);
        }
        // Drop clears ES_SYSTEM_REQUIRED. Windows also clears it automatically on
        // thread/process termination, including forced exit or an updater restart.
        drop(guard);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    struct Fake(Rc<RefCell<Vec<bool>>>);
    impl SleepInhibitor for Fake {
        fn set_required(&mut self, required: bool) -> Result<(), String> {
            self.0.borrow_mut().push(required);
            Ok(())
        }
    }
    fn state(enabled: bool) -> Power {
        Power {
            directory: PathBuf::new(),
            data: Mutex::new(Data {
                snapshot: PowerSnapshot {
                    enabled,
                    active: false,
                    phase: "connecting".into(),
                    message: String::new(),
                },
                epoch: 0,
                settings_error: None,
            }),
            wake: Condvar::new(),
        }
    }
    #[test]
    fn disabled_settings_and_stale_observations_cannot_acquire() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut guard = PowerGuard::new(Fake(calls.clone()));
        let state = state(false);
        assert!(!state.reconcile(99, &mut guard, true, "active", "stale"));
        state.reconcile(0, &mut guard, true, "disabled", "disabled");
        assert!(!state.snapshot().active);
        assert!(calls.borrow().is_empty());
    }
    #[test]
    fn generation_change_discards_inflight_result_then_releases_on_current_pass() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut guard = PowerGuard::new(Fake(calls.clone()));
        let state = state(true);
        state.reconcile(0, &mut guard, true, "active", "running");
        {
            let mut data = state.data.lock().unwrap();
            data.epoch = 1;
            data.snapshot.enabled = false;
        }
        assert!(!state.reconcile(0, &mut guard, true, "active", "stale"));
        state.reconcile(1, &mut guard, false, "disabled", "disabled");
        assert!(!state.snapshot().active);
        assert_eq!(&*calls.borrow(), &[true, false]);
    }
}
