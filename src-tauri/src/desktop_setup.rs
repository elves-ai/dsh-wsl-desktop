//! Trusted local first-run IPC. No commands are granted to the Harness webview.
use super::{assert_local, config, ensure_ready, Controller, Snapshot};
use crate::setup::{self, Identity, SetupRequest};
use std::sync::{atomic::Ordering, Arc};
use tauri::{State, Webview};

#[tauri::command]
pub(super) async fn setup_distributions(window: Webview) -> Result<Vec<String>, String> {
    assert_local(&window)?;
    tauri::async_runtime::spawn_blocking(setup::distributions)
        .await
        .map_err(|_| "发行版检测线程异常结束。".to_owned())?
}
#[tauri::command]
pub(super) async fn setup_identity(
    window: Webview,
    distribution: String,
    linux_user: String,
) -> Result<Identity, String> {
    assert_local(&window)?;
    tauri::async_runtime::spawn_blocking(move || setup::identity(&distribution, &linux_user))
        .await
        .map_err(|_| "Linux 用户检测线程异常结束。".to_owned())?
}

struct SetupLease {
    app: tauri::AppHandle,
    controller: Arc<Controller>,
}
impl Drop for SetupLease {
    fn drop(&mut self) {
        self.controller.busy.store(false, Ordering::SeqCst);
        self.controller.publish(&self.app);
    }
}
#[tauri::command]
pub(super) async fn complete_setup(
    window: Webview,
    app: tauri::AppHandle,
    state: State<'_, Arc<Controller>>,
    request: SetupRequest,
) -> Result<Snapshot, String> {
    assert_local(&window)?;
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if controller.exiting.load(Ordering::SeqCst) {
            return Err("启动器正在退出。".into());
        }
        if controller
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("已有操作正在进行，请稍候。".into());
        }
        let lease = SetupLease {
            app: app.clone(),
            controller: controller.clone(),
        };
        controller.publish(&app);
        let result = (|| {
            if controller.exiting.load(Ordering::SeqCst) {
                return Err("启动器正在退出。".into());
            }
            let config = setup::complete(
                &controller.config_directory,
                &controller.legacy_config,
                &request,
            )?;
            *controller.backend.lock().unwrap_or_else(|e| e.into_inner()) = Some(config);
            controller
                .snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .setup_required = false;
            controller.record(
                &app,
                "首次配置已保存；已部署配套管理器，未安装依赖或修改旧环境，正在检查并启动。 ",
            );
            ensure_ready(&app, &controller, true)
        })();
        if let Err(error) = &result {
            controller
                .snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .setup_required =
                config::needs_setup(&controller.config_directory, &controller.legacy_config);
            controller.failure(&app, error, false);
        }
        drop(lease);
        result.map(|_| controller.snapshot())
    })
    .await
    .map_err(|_| "首次配置线程异常结束；可重新检测后重试。".to_owned())?
}
