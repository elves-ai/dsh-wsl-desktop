//! Privileged updater adapter. The DSH webview never receives these commands.
use super::{assert_local, show_settings, Controller};
use crate::update::{validate_download, UpdateGate, UpdateSnapshot};
use std::{
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, EventTarget, Manager, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Minimal projection for titlebars: never send release notes, URLs or download controls.
#[derive(Clone, serde::Serialize)]
pub(super) struct UpdateNotice {
    available: bool,
}

struct Data {
    snapshot: UpdateSnapshot,
    package: Option<Update>,
}
pub(super) struct Updates {
    gate: UpdateGate,
    data: Mutex<Data>,
}
impl Updates {
    pub(super) fn new(version: &str) -> Self {
        Self {
            gate: UpdateGate::default(),
            data: Mutex::new(Data {
                snapshot: UpdateSnapshot::new(version),
                package: None,
            }),
        }
    }
    fn snapshot(&self) -> UpdateSnapshot {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot
            .clone()
    }
    pub(super) fn titlebar_notice(&self) -> UpdateNotice {
        UpdateNotice {
            available: self.snapshot().version.is_some(),
        }
    }
    fn change(&self, app: &tauri::AppHandle, change: impl FnOnce(&mut Data)) -> UpdateSnapshot {
        let snapshot = {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            change(&mut data);
            data.snapshot.clone()
        };
        for label in ["launcher", "launcher-settings", "dsh-settings"] {
            let _ = app.emit_to(
                EventTarget::webview(label),
                "launcher-update-state",
                &snapshot,
            );
        }
        let notice = UpdateNotice {
            available: snapshot.version.is_some(),
        };
        for label in ["launcher-titlebar", "dsh-titlebar"] {
            let _ = app.emit_to(
                EventTarget::webview(label),
                "titlebar-update-state",
                &notice,
            );
        }
        snapshot
    }
    fn fail(&self, app: &tauri::AppHandle, message: &str) -> UpdateSnapshot {
        self.change(app, |data| {
            data.package = None;
            data.snapshot.phase = "error".into();
            data.snapshot.busy = false;
            data.snapshot.message = message.into();
        })
    }
}

#[tauri::command]
pub(super) fn get_update_snapshot(
    window: Webview,
    state: tauri::State<'_, Arc<Updates>>,
) -> Result<UpdateSnapshot, String> {
    assert_local(&window)?;
    Ok(state.snapshot())
}
#[tauri::command]
pub(super) async fn check_update(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Updates>>,
) -> Result<UpdateSnapshot, String> {
    assert_local(&window)?;
    Ok(check(&app, &state).await)
}
pub(super) async fn check(app: &tauri::AppHandle, updates: &Updates) -> UpdateSnapshot {
    let Some(_lease) = updates.gate.enter() else {
        return updates.snapshot();
    };
    updates.change(app, |data| {
        let current = data.snapshot.current_version.clone();
        data.snapshot = UpdateSnapshot::new(&current);
        data.snapshot.phase = "checking".into();
        data.snapshot.busy = true;
        data.snapshot.message = "正在从 GitHub Releases 检查正式版本。".into();
        data.package = None;
    });
    let updater = match app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        // The default hook tears down Tauri BEFORE ShellExecute, even when Windows
        // then rejects the installer (e.g. UAC/AV). Keep IPC/tray alive for retry.
        // On success the plugin exits this process; Windows reclaims its resources.
        .on_before_exit(|| {})
        .configure_client(|client| {
            client
                .https_only(true)
                .connect_timeout(Duration::from_secs(10))
        })
        .build()
    {
        Ok(updater) => updater,
        Err(_) => return updates.fail(app, "更新配置不可用，请从项目 Release 页面手动安装。"),
    };
    match updater.check().await {
        Ok(Some(mut package)) => {
            if let Err(message) = validate_download(
                &updates.snapshot().current_version,
                &package.version,
                &package.download_url,
            ) {
                return updates.fail(app, &message);
            }
            if package.signature.is_empty() || package.signature.len() > 16 * 1024 {
                return updates.fail(app, "更新签名信息无效，未下载或安装。 ");
            }
            package.timeout = Some(Duration::from_secs(10 * 60));
            let snapshot = updates.change(app, |data| {
                data.snapshot.phase = "available".into();
                data.snapshot.busy = false;
                data.snapshot.version = Some(package.version.clone());
                data.snapshot.notes = package
                    .body
                    .as_ref()
                    .map(|body| body.chars().take(8000).collect());
                data.snapshot.message = "有新的正式版本；仅在你确认后下载并安装。".into();
                data.package = Some(package);
            });
            // Availability is a silent snapshot change, never a window/focus action.
            snapshot
        }
        Ok(None) => updates.change(app, |data| {
            data.snapshot.phase = "up_to_date".into();
            data.snapshot.busy = false;
            data.snapshot.message = "当前已是最新正式版本。".into();
        }),
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => updates.fail(
            app,
            "尚未找到更新清单。可从 GitHub Release 页面手动下载，或稍后重试。",
        ),
        Err(_) => updates.fail(
            app,
            "检查更新失败，请检查 GitHub 网络连接后重试；不会影响 WSL 服务。",
        ),
    }
}
/// Explicit menu action only; automatic update checks must never open a window.
pub(super) fn show_updates(app: &tauri::AppHandle) -> Result<(), String> {
    show_settings(app, "updates")
}

/// Blocks tray/service operations too, not merely the frontend buttons.
struct ServiceLease {
    app: tauri::AppHandle,
    controller: Arc<Controller>,
}
impl ServiceLease {
    fn enter(app: &tauri::AppHandle) -> Result<Self, String> {
        let controller = app.state::<Arc<Controller>>().inner().clone();
        let mut installing = controller
            .installation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if controller.exiting.load(Ordering::SeqCst)
            || controller
                .busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return Err("服务操作正在进行，请完成后再安装更新。".into());
        }
        // Quit may finish between the initial check and acquiring busy.
        if controller.exiting.load(Ordering::SeqCst) {
            controller.busy.store(false, Ordering::SeqCst);
            return Err("启动器正在退出。".into());
        }
        *installing = true;
        drop(installing);
        controller.publish(app);
        Ok(Self {
            app: app.clone(),
            controller,
        })
    }
}
impl Drop for ServiceLease {
    fn drop(&mut self) {
        *self
            .controller
            .installation
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        self.controller.busy.store(false, Ordering::SeqCst);
        self.controller.publish(&self.app);
    }
}
fn confirm_install(version: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO,
    };
    let text: Vec<u16> = format!("下载并安装启动器 {version}？\n\n将验证更新签名，然后运行安装包并重启 Windows 启动器。DSH 窗口会暂时关闭，但不会停止、重启或升级 WSL 中的 DSH 服务。\n\n如使用独立 EXE，此操作使用安装包安装应用，不会原地替换下载的独立 EXE。请保存窗口中尚未提交的输入。").encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "DSH · 启动器更新".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        ) == IDYES
    }
}
#[tauri::command]
pub(super) async fn install_update(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Updates>>,
) -> Result<UpdateSnapshot, String> {
    assert_local(&window)?;
    let Some(_lease) = state.gate.enter() else {
        return Ok(state.snapshot());
    };
    let package = {
        let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.snapshot.phase != "available" {
            return Err("请先检查并选择可用更新。".into());
        }
        data.package
            .clone()
            .ok_or("没有可安装的更新，请重新检查。")?
    };
    validate_download(
        &state.snapshot().current_version,
        &package.version,
        &package.download_url,
    )?;
    let _service_lease = ServiceLease::enter(&app)?;
    let version = package.version.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || confirm_install(&version))
        .await
        .map_err(|_| "无法打开更新确认框。")?;
    if !confirmed {
        return Ok(state.change(&app, |data| {
            data.snapshot.message = "已取消安装，可稍后再更新；WSL 服务保持原状。".into();
        }));
    }
    state.change(&app, |data| {
        data.snapshot.phase = "downloading".into();
        data.snapshot.busy = true;
        data.snapshot.downloaded = 0;
        data.snapshot.total = None;
        data.snapshot.message = "正在下载更新；完成并验证签名后安装。".into();
    });
    let mut last_emit = Instant::now();
    let bytes = package
        .download(
            |chunk, total| {
                {
                    let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                    data.snapshot.progress(chunk, total);
                }
                if last_emit.elapsed() >= Duration::from_millis(100) {
                    state.change(&app, |_| {});
                    last_emit = Instant::now();
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(state.fail(
                &app,
                "更新下载或签名验证失败，未运行安装包。请重新检查更新后重试。",
            ))
        }
    };
    state.change(&app, |data| {
        data.snapshot.phase = "installing".into();
        data.snapshot.message =
            "签名已验证，正在运行安装包。启动器将重启，WSL 服务继续运行。".into();
    });
    // install verifies again, starts NSIS and exits only the Windows launcher process.
    // Never call stop_service/backend.stop or pre-emptively tear down IPC here.
    let result = tauri::async_runtime::spawn_blocking(move || package.install(bytes)).await;
    let message = match result {
        Ok(Ok(())) => "安装器已启动，请按安装器提示完成更新。",
        _ => "无法启动更新安装包。请重新检查，或从项目 Release 页面手动安装。",
    };
    Ok(state.fail(&app, message))
}
