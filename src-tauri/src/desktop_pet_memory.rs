//! Settings-only native memory IPC; no service-ready requirement and no automatic initialization.
use super::{assistant::Assistant, pet_settings::assert_settings, Controller};
use crate::{
    assistant::Binding,
    config::Config,
    environment::NativeRunner,
    pet_memory::{self, MemoryAction, MemorySnapshot},
};
use std::sync::{atomic::Ordering, Arc};
use tauri::{Manager, Webview};

/// Read-only helper for native session admission. Caller must hold operation_mutex() and
/// validate the current Controller/Assistant identity before and after this blocking call.
/// This never initializes the store and is not an IPC command.
pub(super) fn get_for_binding(
    config: &Config,
    binding: &Binding,
) -> Result<MemorySnapshot, String> {
    pet_memory::run_with(&mut NativeRunner, config, binding, None)
}

fn current(app: &tauri::AppHandle) -> Result<(Option<Config>, Option<Binding>), String> {
    let controller = app.state::<Arc<Controller>>();
    let config = controller.backend_config()?;
    let assistant = app.state::<Arc<Assistant>>();
    let binding = assistant.with_workspace_binding(|binding| binding.cloned());
    // Configuration can change independently of assistant state. Re-read before admitting I/O.
    let latest = controller.backend_config()?;
    if config.as_ref().map(pet_memory::backend_identity)
        != latest.as_ref().map(pet_memory::backend_identity)
    {
        return Err("后端配置已变化，请刷新记忆后重试。".into());
    }
    Ok((config, binding))
}

fn run_memory(
    app: &tauri::AppHandle,
    request: Option<MemoryAction>,
) -> Result<MemorySnapshot, String> {
    if let Some(action) = request.as_ref() {
        action.validate()?;
    }
    // Shared with assistant send and rebind. Acquire before controller/backend/assistant locks.
    let _operation = pet_memory::operation_mutex()
        .lock()
        .map_err(|_| "记忆操作状态异常，请重启启动器。".to_owned())?;
    let (config, binding) = current(app)?;
    let (Some(config), Some(binding)) = (config, binding) else {
        return Ok(MemorySnapshot::unavailable(
            "尚未初始化桌宠工作目录，请前往设置 > 桌面宠物 > 初始化宠物目录；查看此页不会初始化记忆。",
        ));
    };
    if pet_memory::scope(&binding, &pet_memory::backend_identity(&config)).is_err() {
        return Ok(MemorySnapshot::unavailable(
            "当前后端与工作目录绑定不一致，请刷新后重试。",
        ));
    }
    // Last identity check immediately before WSL execution, and again even if execution fails.
    let (before_config, before_binding) = current(app)?;
    if before_binding.as_ref() != Some(&binding)
        || before_config.as_ref().map(pet_memory::backend_identity)
            != Some(pet_memory::backend_identity(&config))
    {
        return Err("绑定或后端配置已变化，请刷新记忆后重试。".into());
    }
    let result = pet_memory::run_with(&mut NativeRunner, &config, &binding, request.as_ref()).map(
        |mut snapshot| {
            // Read-only readiness probe. A local consent flag alone is not proof
            // that this saved Session actually uses the isolated pet preset.
            if snapshot.enabled {
                let ready = binding
                    .session_id
                    .as_deref()
                    .and_then(|id| {
                        let cookie =
                            super::notifications::auth_cookie(app, &config.origin()).ok()?;
                        let client =
                            crate::assistant_transport::Client::new(&config.origin(), cookie)
                                .ok()?;
                        Some(
                            client.pet_preset_available().ok()?
                                && client.session_uses_pet_preset(id).ok()?,
                        )
                    })
                    .unwrap_or(false);
                snapshot.runtime_ready = ready;
                if ready {
                    snapshot.message = Some(
                        "已连接桌宠专属记忆 Agent；相关记忆随对话发送给当前 DSH 模型。".into(),
                    );
                }
            }
            snapshot
        },
    );
    let (latest_config, latest_binding) = current(app)?;
    if latest_binding.as_ref() != Some(&binding)
        || latest_config.as_ref().map(pet_memory::backend_identity)
            != Some(pet_memory::backend_identity(&config))
    {
        return Err("绑定或后端配置已变化，请刷新记忆后重试。".into());
    }
    if app
        .state::<Arc<Controller>>()
        .exiting
        .load(Ordering::SeqCst)
    {
        return Err("启动器正在退出。".into());
    }
    match result {
        Ok(snapshot) => Ok(snapshot),
        Err(message) if request.is_none() => Ok(MemorySnapshot::unavailable(&message)),
        Err(message) => Err(message),
    }
}

#[tauri::command]
pub(super) async fn get_pet_memory(
    view: Webview,
    app: tauri::AppHandle,
) -> Result<MemorySnapshot, String> {
    assert_settings(&view)?;
    tauri::async_runtime::spawn_blocking(move || run_memory(&app, None))
        .await
        .map_err(|_| "读取记忆的线程异常结束。".to_owned())?
}

#[tauri::command]
pub(super) async fn pet_memory_action(
    view: Webview,
    app: tauri::AppHandle,
    request: MemoryAction,
) -> Result<MemorySnapshot, String> {
    assert_settings(&view)?;
    request.validate()?;
    tauri::async_runtime::spawn_blocking(move || run_memory(&app, Some(request)))
        .await
        .map_err(|_| "记忆操作线程异常结束。".to_owned())?
}
