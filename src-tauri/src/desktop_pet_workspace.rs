//! Settings-only read/open IPC. Never prepares a directory or contacts DSH.
use super::{assistant::Assistant, pet_settings::assert_settings, Controller};
use crate::{
    assistant::{BackendIdentity, Binding},
    pet_workspace::{self, WorkspaceSnapshot},
};
use std::{
    io::ErrorKind,
    sync::{atomic::Ordering, Arc},
};
use tauri::{Manager, Webview};

fn probe(target: &str) -> Result<bool, ()> {
    match std::fs::metadata(target) {
        Ok(meta) => Ok(meta.is_dir()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    }
}

fn with_current<T>(
    app: &tauri::AppHandle,
    action: impl FnOnce(Option<&Binding>, Option<&BackendIdentity>) -> T,
) -> Result<T, String> {
    let controller = app.state::<Arc<Controller>>();
    if controller.exiting.load(Ordering::SeqCst) {
        return Err("启动器正在退出。".into());
    }
    // Short critical section: copy/check identity or dispatch; never perform UNC I/O here.
    // This is independent of service readiness and never starts a backend.
    let config = controller.backend.lock().unwrap_or_else(|e| e.into_inner());
    let current = config.as_ref().map(|config| BackendIdentity {
        distribution: config.distribution.clone(),
        user: config.linux_user.clone(),
        origin: config.origin(),
    });
    let assistant = app.state::<Arc<Assistant>>();
    Ok(assistant.with_workspace_binding(|binding| action(binding, current.as_ref())))
}

fn run_workspace(app: &tauri::AppHandle, open: bool) -> Result<WorkspaceSnapshot, String> {
    let (binding, current) =
        with_current(app, |binding, current| (binding.cloned(), current.cloned()))?;
    // WSL's UNC provider can be slow or unavailable. Never block shared state locks on it.
    let snapshot = pet_workspace::inspect(binding.as_ref(), current.as_ref(), probe);
    with_current(app, |latest_binding, latest_current| {
        pet_workspace::unchanged(
            binding.as_ref(),
            current.as_ref(),
            latest_binding,
            latest_current,
        )?;
        if open {
            if snapshot.status != pet_workspace::WorkspaceStatus::Ready {
                return Err(snapshot.message);
            }
            pet_workspace::open_bound(
                latest_binding,
                latest_current,
                |_| Ok(true),
                |target| open::that_detached(target).map_err(|_| ()),
            )
        } else {
            Ok(snapshot)
        }
    })?
}

#[tauri::command]
pub(super) async fn get_pet_workspace(
    view: Webview,
    app: tauri::AppHandle,
) -> Result<WorkspaceSnapshot, String> {
    assert_settings(&view)?;
    tauri::async_runtime::spawn_blocking(move || run_workspace(&app, false))
        .await
        .map_err(|_| "读取工作目录的线程异常结束。".to_owned())?
}
#[tauri::command]
pub(super) async fn open_pet_workspace(
    view: Webview,
    app: tauri::AppHandle,
) -> Result<WorkspaceSnapshot, String> {
    assert_settings(&view)?;
    tauri::async_runtime::spawn_blocking(move || run_workspace(&app, true))
        .await
        .map_err(|_| "打开工作目录的线程异常结束。".to_owned())?
}
