//! Native Tauri surfaces for the DSH-backed desktop assistant.
//! Credentials and authoritative chat history remain outside bundled JavaScript.
use super::{notifications, Controller};
use crate::{
    assistant::{BackendIdentity, Binding, BindingStore, Projection, SessionRow, Snapshot},
    assistant_transport::Client,
    config::Config,
    environment::NativeRunner,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::WebviewBuilder, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager,
    PhysicalPosition, Webview, WebviewUrl, Window, WindowBuilder, WindowEvent,
};
use url::Url;

const PET: &str = "assistant-pet";
const CHAT: &str = "assistant-chat";
static IDS: AtomicU64 = AtomicU64::new(0);

struct Data {
    projection: Projection,
    binding: Option<Binding>,
    cancel: Arc<AtomicBool>,
    generation: u64,
    regions: Vec<HitRegion>,
    dragging_until: Option<Instant>,
    motion_active: bool,
    pending_request: Option<String>,
    pending_position: Option<(PetPosition, Instant)>,
}
pub(super) struct Assistant {
    data: Mutex<Data>,
    operation: Mutex<()>,
    windows: Mutex<()>,
    wake: Condvar,
    directory: PathBuf,
}
impl Assistant {
    pub(super) fn new(directory: PathBuf) -> Self {
        let mut projection = Projection::default();
        let binding = match BindingStore::new(directory.join("assistant-binding.json")).load() {
            Ok(binding) => binding,
            Err(_) => {
                projection
                    .set_operation("error", "助手绑定无法读取，请检查配置目录；未覆盖原配置。");
                None
            }
        };
        if let Some(binding) = &binding {
            projection.set_binding(Some(binding));
            projection.set_enabled(true);
            projection.set_connection(false, "connecting", "正在恢复助手会话。");
        }
        Self {
            data: Mutex::new(Data {
                projection,
                binding,
                cancel: Arc::new(AtomicBool::new(false)),
                generation: 0,
                regions: Vec::new(),
                dragging_until: None,
                motion_active: false,
                pending_request: None,
                pending_position: None,
            }),
            operation: Mutex::new(()),
            windows: Mutex::new(()),
            wake: Condvar::new(),
            directory,
        }
    }
    fn store(&self) -> BindingStore {
        BindingStore::new(self.directory.join("assistant-binding.json"))
    }
    fn snapshot(&self) -> Snapshot {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .projection
            .snapshot()
    }
    fn publish(&self, app: &tauri::AppHandle) {
        let snapshot = self.snapshot();
        for label in [PET, CHAT] {
            let _ = app.emit_to(EventTarget::webview(label), "assistant-state", &snapshot);
        }
    }
    fn status(&self, app: &tauri::AppHandle, connected: bool, phase: &str, message: &str) {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .projection
            .set_connection(connected, phase, message);
        self.publish(app);
    }
    fn bind(&self, app: &tauri::AppHandle, binding: Binding) -> Result<(), String> {
        self.store()
            .save(&binding)
            .map_err(|_| "无法保存助手会话绑定；请检查磁盘后重试。")?;
        {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            data.cancel.store(true, Ordering::SeqCst);
            data.cancel = Arc::new(AtomicBool::new(false));
            data.generation = data.generation.wrapping_add(1);
            data.projection.set_binding(Some(&binding));
            data.projection.set_enabled(true);
            data.projection
                .set_connection(false, "connecting", "正在连接助手会话。");
            data.pending_request = None;
            data.binding = Some(binding);
        }
        self.wake.notify_all();
        self.publish(app);
        Ok(())
    }
    /// Fail closed on a legacy/custom binding, without touching its files or DSH history.
    fn require_setup(&self, app: &tauri::AppHandle, generation: u64, message: &str) {
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.generation != generation {
            return;
        }
        data.cancel.store(true, Ordering::SeqCst);
        data.generation = data.generation.wrapping_add(1);
        data.binding = None;
        data.pending_request = None;
        data.projection.set_binding(None);
        data.projection.set_enabled(false);
        data.projection.set_connection(false, "setup", message);
        // Keep the persisted binding intact until the user explicitly enables the default.
        drop(data);
        self.publish(app);
        self.wake.notify_all();
    }
    fn wait(&self, seconds: u64) {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        drop(self.wake.wait_timeout(data, Duration::from_secs(seconds)));
    }
    /// Read only: keep the binding fixed for a short snapshot/check/dispatch closure (no filesystem I/O).
    pub(super) fn with_workspace_binding<T>(&self, read: impl FnOnce(Option<&Binding>) -> T) -> T {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        read(data.binding.as_ref())
    }
    fn binding(&self) -> Result<Binding, String> {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .binding
            .clone()
            .ok_or_else(|| "请先启用桌面助手。".into())
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HitRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Action {
    Enable {},
    Retry,
    NewSession,
    SelectSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Send {
        text: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "clientTimeZone")]
        client_time_zone: Option<String>,
    },
    Cancel,
    OpenDsh,
    ToggleChat,
    Hide,
    Drag,
    MotionActive {
        active: bool,
    },
    PetInput {
        active: bool,
    },
    PetSource,
    PetSettings,
    HitRegions {
        regions: Vec<HitRegion>,
    },
}

fn action_allowed(label: &str, action: &Action) -> bool {
    match action {
        Action::PetInput { .. } | Action::MotionActive { .. } | Action::HitRegions { .. } => {
            label == PET
        }
        Action::Enable { .. } | Action::NewSession | Action::SelectSession { .. } => label == CHAT,
        // Inline conversation shares the bound session, never project/session setup.
        Action::Send { .. } | Action::Cancel | Action::Retry => [PET, CHAT].contains(&label),
        Action::OpenDsh
        | Action::ToggleChat
        | Action::Hide
        | Action::Drag
        | Action::PetSource
        | Action::PetSettings => [PET, CHAT].contains(&label),
    }
}

fn document_allowed(url: &Url, label: &str) -> bool {
    let origin = ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none();
    let dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    if !(origin || dev)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/assistant.html"
        || url.fragment().is_some()
    {
        return false;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    pairs.len() == 1
        && pairs[0].0 == "view"
        && pairs[0].1
            == if label == PET {
                "pet"
            } else if label == CHAT {
                "chat"
            } else {
                return false;
            }
}
pub(super) fn assert_assistant(view: &Webview) -> Result<(), String> {
    if view.label() != view.window().label()
        || !document_allowed(&view.url().map_err(|_| "无法验证助手页面。")?, view.label())
    {
        return Err("此页面无权调用桌面助手。".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) fn get_assistant_snapshot(
    view: Webview,
    state: tauri::State<'_, Arc<Assistant>>,
) -> Result<Snapshot, String> {
    assert_assistant(&view)?;
    Ok(state.snapshot())
}
#[tauri::command]
pub(super) async fn assistant_action(
    view: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Assistant>>,
    request: Action,
) -> Result<Snapshot, String> {
    assert_assistant(&view)?;
    if !action_allowed(view.label(), &request) {
        return Err("此助手页面无权执行该操作。".into());
    }
    let state = state.inner().clone();
    let caller = view.label().to_owned();
    let window = view.window();
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize memory consent/management with sends and binding changes.
        // Acquire before Assistant.operation/data or Controller.backend locks.
        let _memory_lease = if matches!(
            &request,
            Action::Enable { .. }
                | Action::NewSession
                | Action::SelectSession { .. }
                | Action::Send { .. }
                | Action::Retry
        ) {
            Some(
                crate::pet_memory::operation_mutex()
                    .try_lock()
                    .map_err(|_| "正在处理记忆或会话操作，请稍后重试。")?,
            )
        } else {
            None
        };
        match request {
            Action::HitRegions { regions } => {
                if caller != PET
                    || regions.len() > 16
                    || regions.iter().any(|r| {
                        ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
                            || r.width <= 0.0
                            || r.height <= 0.0
                            || r.x < 0.0
                            || r.y < 0.0
                            || r.x + r.width > 400.0
                            || r.y + r.height > 340.0
                    })
                {
                    return Err("助手交互区域无效。".into());
                }
                state.data.lock().unwrap_or_else(|e| e.into_inner()).regions = regions;
            }
            Action::PetSettings => super::settings_page::show(&app, "pet")?,
            Action::PetSource => {
                open::that_detached("https://github.com/PC2005-cloud/dsh-pet")
                    .map_err(|_| "无法打开上游项目地址。")?;
            }
            Action::PetInput { active } => {
                app.state::<Arc<super::pet_interactions::PetInteractions>>()
                    .set_composer_active(&app, active)?;
            }
            Action::MotionActive { active } => {
                if caller != PET {
                    return Err("此操作仅适用于桌宠窗口。".into());
                }
                state
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .motion_active = active;
                if active {
                    let _ = window.set_ignore_cursor_events(false);
                }
            }
            Action::Drag => {
                state
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .dragging_until = Some(Instant::now() + Duration::from_secs(2));
                let _ = window.set_ignore_cursor_events(false);
                window.start_dragging().map_err(|_| "无法拖动助手窗口。")?;
            }
            Action::ToggleChat => toggle_chat(&app, &state)?,
            Action::Hide => {
                if caller == PET {
                    app.state::<Arc<super::pet_settings::PetControls>>()
                        .set_visible(&app, false)?;
                } else {
                    window.hide().map_err(|_| "无法隐藏对话面板。")?;
                }
            }
            Action::OpenDsh => open_session(&app, &state)?,
            action => {
                let _lease = state
                    .operation
                    .try_lock()
                    .map_err(|_| "助手正在处理操作，请稍候。")?;
                let result = run_action(&app, &state, action);
                if let Err(message) = &result {
                    state.status(&app, false, "error", message);
                }
                result?;
            }
        }
        Ok(state.snapshot())
    })
    .await
    .map_err(|_| "助手操作线程异常结束。".to_owned())?
}

fn identity(config: &Config) -> BackendIdentity {
    BackendIdentity {
        distribution: config.distribution.clone(),
        user: config.linux_user.clone(),
        origin: config.origin(),
    }
}
fn config(app: &tauri::AppHandle) -> Result<Config, String> {
    let controller = app.state::<Arc<Controller>>();
    if controller.exiting.load(Ordering::SeqCst) || controller.snapshot().state != "ready" {
        return Err("DSH 服务尚未就绪，请打开工作窗口检查连接。".into());
    }
    Ok(controller.backend()?.config)
}
fn client(app: &tauri::AppHandle, config: &Config) -> Result<Client, String> {
    Client::new(
        &config.origin(),
        notifications::auth_cookie(app, &config.origin())?,
    )
    .map_err(|e| e.to_string())
}
fn checked_binding(state: &Assistant, config: &Config) -> Result<Binding, String> {
    let binding = state.binding()?;
    if binding.backend != identity(config) {
        return Err("DSH 服务配置已变化，请重新确认默认工作区；未向旧会话发送消息。".into());
    }
    crate::assistant_policy::require_default_workspace(
        &binding,
        &default_directory(config, false)?,
    )?;
    Ok(binding)
}
/// Resolve only the managed WSL directory; no path comes from IPC or saved bindings.
fn default_directory(config: &Config, create: bool) -> Result<String, String> {
    let mut args = config.wsl_args("probe")?;
    args.truncate(6);
    args.extend([
        "-c".to_owned(),
        include_str!("../helpers/assistant_directory.py").to_owned(),
    ]);
    if !create {
        args.push("--inspect".to_owned());
    }
    let output = NativeRunner
        .run_input(&args, None, Duration::from_secs(15))
        .map_err(|_| "无法准备助手工作目录，请检查 WSL 状态。")?;
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "助手目录响应无效。")?;
    if !output.success {
        return Err("助手目录不可用；请检查路径、权限或是否为符号链接。".into());
    }
    value
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| p.starts_with('/'))
        .map(str::to_owned)
        .ok_or_else(|| "助手目录响应无效。".into())
}
fn id() -> String {
    let seed = format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        IDS.fetch_add(1, Ordering::Relaxed)
    );
    let hex = format!("{:x}", Sha256::digest(seed.as_bytes()));
    format!(
        "session-{}-{}-4{}-a{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}
fn value_id(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(|| "DSH 返回的项目或会话标识无效。".into())
}
fn create_session(
    app: &tauri::AppHandle,
    state: &Assistant,
    rpc: &Client,
    mut binding: Binding,
) -> Result<(), String> {
    if binding.session_pending {
        let mut project = binding.clone();
        project.session_id = None;
        let (rows, _) = catalog(rpc, &project)?;
        if crate::assistant_policy::pending_exists(&binding, &rows) {
            binding.session_pending = false;
            return state.bind(app, binding);
        }
    }
    let backend = config(app)?;
    let memory = super::pet_memory::get_for_binding(&backend, &binding)?;
    let preset = if memory.enabled {
        if !rpc
            .pet_preset_available()
            .map_err(|_| "无法确认桌宠 Agent 扩展，请检查 DSH 连接和扩展安装。")?
        {
            return Err(
                "尚未安装可用的 desktop-pet 专属 Agent；请先安装扩展，不会退回普通 Agent。".into(),
            );
        }
        Some("desktop-pet")
    } else {
        None
    };
    if identity(&config(app)?) != binding.backend {
        return Err("后端已变化，请重新检查桌宠绑定。".into());
    }
    if !binding.session_pending {
        binding.session_id = Some(id());
        binding.session_pending = true;
        state.bind(app, binding.clone())?;
    }
    let created = rpc
        .session_create_for_preset(&binding.workspace_id, binding.session_id.as_deref(), preset)
        .map_err(|e| format!("{e} 会话创建结果未确认，重试将核对同一个会话标识。"))?;
    binding.session_id = Some(value_id(&created, "sessionId")?);
    binding.session_pending = false;
    state.bind(app, binding)
}

/// Validate the persisted Workspace identity, path, and active Session membership.
/// Never recreate a deleted/archived target as a side effect of reconnecting.
fn catalog(rpc: &Client, binding: &Binding) -> Result<(Vec<SessionRow>, bool), String> {
    let workspaces = rpc.workspace_list().map_err(|e| e.to_string())?;
    let list = rpc.session_list().map_err(|e| e.to_string())?;
    crate::assistant_policy::catalog(&workspaces, &list, binding)
}
fn require_session(rows: &[SessionRow], binding: &Binding) -> Result<(), String> {
    crate::assistant_policy::require_session(rows, binding)
}
fn run_action(app: &tauri::AppHandle, state: &Assistant, action: Action) -> Result<(), String> {
    let config = config(app)?;
    let rpc = client(app, &config)?;
    match action {
        Action::Enable {} => {
            // Enable alone may create the fixed default directory or Workspace.
            let path = default_directory(&config, true)?;
            let value = rpc.workspace_create(&path).map_err(|e| e.to_string())?;
            let workspace = value.get("workspace").ok_or("DSH 未返回助手项目。")?;
            let workspace_id = value_id(workspace, "workspaceId")?;
            if value.get("created").and_then(Value::as_bool) == Some(true) {
                let _ = rpc.workspace_rename(&workspace_id, "桌面助手");
            }
            let previous = state
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .binding
                .clone();
            if let Some(binding) = previous.filter(|b| {
                b.backend == identity(&config)
                    && b.workspace_id == workspace_id
                    && b.workspace_path == path
            }) {
                if binding.session_pending {
                    create_session(app, state, &rpc, binding)?;
                } else {
                    let (rows, _) = catalog(&rpc, &binding)?;
                    require_session(&rows, &binding)?;
                    state.bind(app, binding)?;
                }
            } else {
                let binding = Binding {
                    backend: identity(&config),
                    workspace_id,
                    workspace_path: path,
                    session_id: None,
                    session_pending: false,
                };
                state.bind(app, binding.clone())?;
                create_session(app, state, &rpc, binding)?;
            }
        }
        Action::Retry => {
            let binding = checked_binding(state, &config)?;
            let generation = state
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .generation;
            let workspaces = rpc.workspace_list().map_err(|e| e.to_string())?;
            if crate::assistant_policy::bound_workspace(&workspaces, &binding).is_err() {
                state.require_setup(app, generation, "默认工作区已删除或绑定失效，请重新确认启用；不会自动创建目录，旧历史对话未删除。");
                return Ok(());
            }
            if binding.session_pending || binding.session_id.is_none() {
                create_session(app, state, &rpc, binding)?;
            } else {
                let (rows, _) = catalog(&rpc, &binding)?;
                require_session(&rows, &binding)?;
                state.bind(app, binding)?;
            }
        }
        Action::NewSession => {
            let binding = checked_binding(state, &config)?;
            // A missing current session must not prevent explicit recovery by new conversation.
            let mut project_only = binding.clone();
            project_only.session_id = None;
            catalog(&rpc, &project_only)?;
            create_session(
                app,
                state,
                &rpc,
                Binding {
                    session_pending: false,
                    ..binding
                },
            )?;
        }
        Action::SelectSession { session_id } => {
            let mut binding = checked_binding(state, &config)?;
            let mut project_only = binding.clone();
            project_only.session_id = None;
            let (sessions, _) = catalog(&rpc, &project_only)?;
            if !sessions.iter().any(|s| s.id == session_id) {
                return Err("只能选择助手项目中的未归档会话。".into());
            }
            binding.session_id = Some(session_id);
            binding.session_pending = false;
            state.bind(app, binding)?;
        }
        Action::Send {
            text,
            request_id,
            client_time_zone,
        } => {
            let binding = checked_binding(state, &config)?;
            let snap = state.snapshot();
            let pending = state
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pending_request
                .is_some()
                || binding.session_pending;
            if !crate::assistant_policy::send_allowed(&snap, pending) {
                return Err("会话尚未就绪或正在运行，请稍候；需要回答问题时请进入 DSH。".into());
            }
            let (sessions, running) = catalog(&rpc, &binding)?;
            require_session(&sessions, &binding)?;
            if running {
                return Err("会话正在 DSH 中运行，请等待或停止后再发送。".into());
            }
            state
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .projection
                .set_sessions(sessions);
            let session_id = binding.session_id.as_deref().ok_or("尚未绑定会话。")?;
            let memory = super::pet_memory::get_for_binding(&config, &binding)?;
            if memory.enabled
                && !rpc
                    .session_uses_pet_preset(session_id)
                    .map_err(|_| "无法核对桌宠专属 Agent，请重新连接后重试。")?
            {
                return Err("当前仍是普通会话。请安装 desktop-pet 扩展后新建对话；不会将记忆追加到普通会话。".into());
            }
            if identity(&self::config(app)?) != binding.backend {
                return Err("后端已变化，未发送消息。".into());
            }
            state
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pending_request = Some(request_id.clone());
            state.status(app, true, "sending", "正在提交消息；请勿重复发送。");
            rpc.session_prompt(session_id, &request_id, &text, client_time_zone.as_deref())
                .map_err(|e| {
                    format!("{e} 发送结果可能尚未确认，请先重连并核对历史，不要直接重复发送。")
                })?;
            // Only sequenced follow events can establish running/completed.
            // A fast turn may already have ended before this acknowledgement arrives.
            state.publish(app);
        }
        Action::Cancel => {
            let binding = checked_binding(state, &config)?;
            let session_id = binding.session_id.as_deref().ok_or("尚未绑定会话。")?;
            state.status(
                app,
                true,
                "cancelling",
                "正在请求停止当前运行；排队消息不会因此被删除。",
            );
            rpc.session_cancel(session_id).map_err(|e| e.to_string())?;
            // Do not overwrite a terminal follow event with a late RPC acknowledgement.
            state.publish(app);
        }
        _ => return Err("不支持的助手操作。".into()),
    }
    state.wake.notify_all();
    Ok(())
}

fn open_session(app: &tauri::AppHandle, state: &Assistant) -> Result<(), String> {
    let config = match config(app) {
        Ok(c) => c,
        Err(e) => {
            super::show_launcher(app);
            return Err(e);
        }
    };
    let binding = match checked_binding(state, &config) {
        Ok(b) => b,
        Err(_) => {
            super::show_dsh(app);
            return Ok(());
        }
    };
    if let Some(session_id) = binding.session_id {
        let target = crate::notifications::notification_session_url(
            config.port,
            &session_id,
            IDS.fetch_add(1, Ordering::Relaxed),
        )?;
        notifications::open_notified_session(app, &target)
    } else {
        super::show_dsh(app);
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct PetPosition {
    x: i32,
    y: i32,
}
fn place(window: &Window, app: &tauri::AppHandle, directory: &std::path::Path, pet: bool) {
    let anchor = if !pet {
        app.get_window(PET)
            .and_then(|w| w.outer_position().ok().map(|p| (w, p)))
    } else {
        None
    };
    let monitor = anchor
        .as_ref()
        .and_then(|(w, _)| w.current_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let area = monitor.work_area();
    let mut size = window
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(220, 250));
    if !pet && (size.width > area.size.width || size.height > area.size.height) {
        size.width = size.width.min(area.size.width);
        size.height = size.height.min(area.size.height);
        let _ = window.set_size(size);
    }
    let saved = pet
        .then(|| fs::read(directory.join("assistant-position.json")).ok())
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<PetPosition>(&bytes).ok());
    let (mut x, mut y) = saved.map(|p| (p.x, p.y)).unwrap_or((
        area.position.x + area.size.width.saturating_sub(size.width + 24) as i32,
        area.position.y + area.size.height.saturating_sub(size.height + 24) as i32,
    ));
    if pet {
        // Saved top-left may legitimately sit outside the monitor: only transparent
        // video padding is off screen. Use the same character bounds as live dragging.
        if let Ok(position) = super::pet::constrain_pet_position(
            window,
            crate::pet_geometry::Point {
                x: x as f64,
                y: y as f64,
            },
        ) {
            let _ =
                window.set_position(PhysicalPosition::new(position.x as i32, position.y as i32));
        }
        return;
    }
    if let Some((anchor, position)) = anchor {
        let pet_size = anchor
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(220, 250));
        x = if position.x - size.width as i32 - 12 >= area.position.x {
            position.x - size.width as i32 - 12
        } else {
            position.x + pet_size.width as i32 + 12
        };
        y = position.y + pet_size.height as i32 - size.height as i32;
    }
    // Restore on the saved monitor only if the entire window is reachable there.
    if let Ok(Some(saved_monitor)) = app.monitor_from_point(x as f64, y as f64) {
        let a = saved_monitor.work_area();
        x = x.clamp(
            a.position.x,
            a.position.x + a.size.width.saturating_sub(size.width) as i32,
        );
        y = y.clamp(
            a.position.y,
            a.position.y + a.size.height.saturating_sub(size.height) as i32,
        );
    } else {
        x = x.clamp(
            area.position.x,
            area.position.x + area.size.width.saturating_sub(size.width) as i32,
        );
        y = y.clamp(
            area.position.y,
            area.position.y + area.size.height.saturating_sub(size.height) as i32,
        );
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
}
fn create_window(app: &tauri::AppHandle, state: &Assistant, pet: bool) -> Result<Window, String> {
    let _lease = state.windows.lock().unwrap_or_else(|e| e.into_inner());
    let label = if pet { PET } else { CHAT };
    if let Some(window) = app.get_window(label) {
        return Ok(window);
    }
    let (width, height) = if pet { (360.0, 320.0) } else { (420.0, 600.0) };
    let window = WindowBuilder::new(app, label)
        .title(if pet {
            "DSH 桌面助手"
        } else {
            "桌面助手 · DSH"
        })
        .decorations(false)
        .inner_size(width, height)
        .min_inner_size(
            if pet { width } else { 320.0 },
            if pet { height } else { 360.0 },
        )
        .resizable(false)
        .transparent(pet)
        .shadow(!pet)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(!pet)
        .visible(false)
        .build()
        .map_err(|_| "无法创建桌面助手窗口。")?;
    let result = window.add_child(
        WebviewBuilder::new(
            label,
            WebviewUrl::App(
                format!("assistant.html?view={}", if pet { "pet" } else { "chat" }).into(),
            ),
        )
        .transparent(pet)
        .focused(false)
        .on_navigation(move |url| document_allowed(url, label))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width, height),
    );
    if result.is_err() {
        let _ = window.destroy();
        return Err("无法创建助手 WebView2 页面。".into());
    }
    place(&window, app, &state.directory, pet);
    Ok(window)
}
pub(super) fn reveal_pet(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<Assistant>>();
    let pet = create_window(app, &state, true)?;
    pet.unminimize().map_err(|_| "无法还原桌面宠物。")?;
    pet.show().map_err(|_| "无法显示桌面宠物。")?;
    Ok(())
}
pub(super) fn show(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<Arc<super::pet_settings::PetControls>>()
        .set_visible(app, true)?;
    let state = app.state::<Arc<Assistant>>();
    if !state.snapshot().enabled {
        let chat = create_window(app, &state, false)?;
        let _ = chat.show();
        let _ = chat.set_focus();
    }
    Ok(())
}
fn toggle_chat(app: &tauri::AppHandle, state: &Assistant) -> Result<(), String> {
    let window = create_window(app, state, false)?;
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        place(&window, app, &state.directory, false);
        window.show().map_err(|_| "无法显示对话面板。")?;
        let _ = window.set_focus();
    }
    Ok(())
}
pub(super) fn on_window_event(window: &Window, event: &WindowEvent) {
    if ![PET, CHAT].contains(&window.label()) {
        return;
    }
    if window.label() == PET
        && matches!(
            event,
            WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Resized(_)
        )
    {
        // Invalidate before any UI dispatch/spawn; monitor cache locks never span Tauri calls.
        super::pet::invalidate_work_areas();
    }
    if let WindowEvent::Moved(position) = event {
        if window.label() == PET {
            if let Some(state) = window.app_handle().try_state::<Arc<Assistant>>() {
                let value = PetPosition {
                    x: position.x,
                    y: position.y,
                };
                state
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pending_position = Some((value, Instant::now()));
            }
        }
    }
    if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
        let window = window.clone();
        let app = window.app_handle().clone();
        thread::spawn(move || {
            if window.label() == PET {
                // Preserve the live drag location across DPI changes; never restore an old saved position here.
                if let (Some(view), Ok(position)) = (app.get_webview(PET), window.outer_position())
                {
                    let _ = super::pet::move_pet(
                        view,
                        app.clone(),
                        position.x as f64,
                        position.y as f64,
                    );
                }
            } else if let Some(state) = app.try_state::<Arc<Assistant>>() {
                place(&window, &app, &state.directory, false);
            }
        });
    }
    if let WindowEvent::Resized(size) = event {
        if let Some(view) = window.app_handle().get_webview(window.label()) {
            let _ = view.set_size(*size);
        }
    }
}

pub(super) fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<Assistant>>() {
        state
            .data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel
            .store(true, Ordering::SeqCst);
        state.wake.notify_all();
    }
}
pub(super) fn start(app: tauri::AppHandle, controller: Arc<Controller>, state: Arc<Assistant>) {
    // One follower per selected generation. Session history is never written locally.
    let follow_app = app.clone();
    let follow_state = state.clone();
    let follow_controller = controller.clone();
    thread::spawn(move || loop {
        if follow_controller.exiting.load(Ordering::SeqCst) {
            break;
        }
        let (binding, generation, cancel) = {
            let mut data = follow_state.data.lock().unwrap_or_else(|e| e.into_inner());
            data.cancel = Arc::new(AtomicBool::new(false));
            (
                data.binding
                    .clone()
                    .filter(|_| data.projection.snapshot().enabled),
                data.generation,
                data.cancel.clone(),
            )
        };
        let Some(binding) = binding else {
            follow_state.wait(3);
            continue;
        };
        let result = (|| -> Result<(), String> {
            let config = config(&follow_app)?;
            if binding.backend != identity(&config) {
                follow_state.require_setup(
                    &follow_app,
                    generation,
                    "DSH 配置已变化，请重新确认默认工作区；旧项目与历史对话未删除。",
                );
                return Ok(());
            }
            let default_path = default_directory(&config, false)?;
            if let Err(message) =
                crate::assistant_policy::require_default_workspace(&binding, &default_path)
            {
                follow_state.require_setup(&follow_app, generation, &message);
                return Ok(());
            }
            let rpc = client(&follow_app, &config)?;
            if binding.session_pending || binding.session_id.is_none() {
                if let Ok(_lease) = follow_state.operation.try_lock() {
                    create_session(&follow_app, &follow_state, &rpc, binding.clone())?;
                }
                return Ok(());
            }
            let (sessions, running) = catalog(&rpc, &binding)?;
            {
                let mut data = follow_state.data.lock().unwrap_or_else(|e| e.into_inner());
                if data.generation != generation {
                    return Ok(());
                }
                data.projection.set_sessions(sessions);
                data.projection.set_running(running);
            }
            let rows = follow_state.snapshot().sessions;
            require_session(&rows, &binding)?;
            let mut projection_error = None;
            rpc.session_follow(binding.session_id.as_deref().unwrap(), &cancel, |frame| {
                if cancel.load(Ordering::SeqCst)
                    || follow_controller.exiting.load(Ordering::SeqCst)
                    || follow_controller.snapshot().state != "ready"
                {
                    return false;
                }
                let changed = {
                    let mut data = follow_state.data.lock().unwrap_or_else(|e| e.into_inner());
                    if data.generation != generation {
                        return false;
                    }
                    match data.projection.apply_frame(&frame) {
                        Ok(changed) => {
                            let snapshot = data.projection.snapshot();
                            let accepted = data.pending_request.as_ref().is_some_and(|id| {
                                snapshot
                                    .messages
                                    .iter()
                                    .any(|m| m.request_id.as_ref() == Some(id))
                            });
                            let ended = frame.pointer("/event/type").and_then(Value::as_str)
                                == Some("turn/end");
                            if accepted
                                && (snapshot.running || ended || frame["type"] == "snapshot")
                            {
                                data.pending_request = None;
                                if snapshot.phase == "sending" {
                                    data.projection.set_operation(
                                        if snapshot.running { "running" } else { "idle" },
                                        "",
                                    );
                                }
                            }
                            changed
                        }
                        Err(_) => {
                            projection_error =
                                Some("会话流出现缺口或不兼容帧，将重新核对历史。".to_owned());
                            return false;
                        }
                    }
                };
                if changed {
                    follow_state.publish(&follow_app);
                }
                true
            })
            .map_err(|e| e.to_string())?;
            if let Some(error) = projection_error {
                return Err(error);
            }
            Ok(())
        })();
        if let Err(error) = result {
            if !cancel.load(Ordering::SeqCst)
                && follow_state
                    .data
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .generation
                    == generation
            {
                follow_state.status(&follow_app, false, "offline", &error);
            }
        }
        follow_state.wait(3);
    });
    // Independent status observation: disabling Windows notifications never stops the pet.
    let status_app = app.clone();
    let status_state = state.clone();
    let status_controller = controller.clone();
    thread::spawn(move || loop {
        if status_controller.exiting.load(Ordering::SeqCst) {
            break;
        }
        let binding = if status_state.snapshot().enabled {
            status_state.binding().ok()
        } else {
            None
        };
        if let Some(binding) = binding.filter(|b| !b.session_pending && b.session_id.is_some()) {
            let result = (|| -> Result<(Vec<SessionRow>, bool), String> {
                let config = config(&status_app)?;
                if binding.backend != identity(&config) {
                    return Err("DSH 配置已变化，请重新确认默认工作区。".into());
                }
                crate::assistant_policy::require_default_workspace(
                    &binding,
                    &default_directory(&config, false)?,
                )?;
                catalog(&client(&status_app, &config)?, &binding)
            })();
            {
                let mut data = status_state.data.lock().unwrap_or_else(|e| e.into_inner());
                if data.binding.as_ref() == Some(&binding) && data.projection.snapshot().enabled {
                    match result {
                        Ok((rows, running)) => {
                            let valid = require_session(&rows, &binding);
                            data.projection.set_sessions(rows);
                            if running || !data.projection.snapshot().connected {
                                data.projection.set_running(running);
                            }
                            if let Err(error) = valid {
                                data.cancel.store(true, Ordering::SeqCst);
                                data.projection
                                    .set_connection(false, "binding-error", &error);
                            }
                        }
                        Err(error) => {
                            data.cancel.store(true, Ordering::SeqCst);
                            data.projection.set_connection(false, "offline", &error);
                        }
                    }
                }
            }
            status_state.publish(&status_app);
        }
        status_state.wait(3);
    });
    // Native hit testing also works while the WebView is ignoring mouse input.
    thread::spawn(move || loop {
        if controller.exiting.load(Ordering::SeqCst) {
            break;
        }
        if let Some(window) = app
            .get_window(PET)
            .filter(|w| w.is_visible().unwrap_or(false))
        {
            if let (Ok(cursor), Ok(position), Ok(scale)) = (
                app.cursor_position(),
                window.inner_position(),
                window.scale_factor(),
            ) {
                let (regions, dragging) = {
                    let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                    if data.motion_active && !super::pet::left_button_down() {
                        data.motion_active = false;
                    }
                    (
                        data.regions.clone(),
                        data.motion_active
                            || data
                                .dragging_until
                                .is_some_and(|until| until > Instant::now()),
                    )
                };
                let x = (cursor.x - position.x as f64) / scale;
                let y = (cursor.y - position.y as f64) / scale;
                let hit = regions
                    .iter()
                    .any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
                let _ = window.set_ignore_cursor_events(!hit && !dragging);
            }
        }
        let position = {
            let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            if data
                .pending_position
                .as_ref()
                .is_some_and(|(_, at)| at.elapsed() >= Duration::from_millis(350))
            {
                data.pending_position.take().map(|(p, _)| p)
            } else {
                None
            }
        };
        if let Some(position) = position {
            if let Ok(bytes) = serde_json::to_vec(&position) {
                let temporary = state.directory.join(".assistant-position.tmp");
                if fs::create_dir_all(&state.directory).is_ok()
                    && fs::write(&temporary, bytes).is_ok()
                {
                    let _ = fs::rename(temporary, state.directory.join("assistant-position.json"));
                }
            }
        }
        thread::sleep(Duration::from_millis(80));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_actions_are_scoped_without_setup_privileges() {
        for action in [
            Action::Send {
                text: "hello".into(),
                request_id: "request".into(),
                client_time_zone: None,
            },
            Action::Cancel,
            Action::Retry,
            Action::ToggleChat,
        ] {
            assert!(action_allowed(PET, &action));
            assert!(action_allowed(CHAT, &action));
            assert!(!action_allowed("dsh-main", &action));
        }
        for action in [
            Action::Enable {},
            Action::NewSession,
            Action::SelectSession {
                session_id: "session".into(),
            },
        ] {
            assert!(!action_allowed(PET, &action));
            assert!(action_allowed(CHAT, &action));
        }
        for active in [true, false] {
            let action: Action = serde_json::from_value(serde_json::json!({
                "action": "pet_input", "active": active
            }))
            .unwrap();
            assert!(matches!(action, Action::PetInput { active: value } if value == active));
            assert!(action_allowed(PET, &action));
            assert!(!action_allowed(CHAT, &action));
            assert!(!action_allowed("dsh-main", &action));
        }
        for payload in [
            serde_json::json!({"action":"pet_input"}),
            serde_json::json!({"action":"pet_input", "active":"true"}),
            serde_json::json!({"action":"pet_input", "active":true, "extra":1}),
        ] {
            assert!(serde_json::from_value::<Action>(payload).is_err());
        }
    }

    #[test]
    fn enable_accepts_no_custom_path_and_reconfigure_is_removed() {
        assert!(serde_json::from_value::<Action>(serde_json::json!({"action":"enable"})).is_ok());
        for payload in [
            serde_json::json!({"action":"enable", "path":"/custom"}),
            serde_json::json!({"action":"enable", "path":"~/.dsh-wsl-desktop/assistant"}),
            serde_json::json!({"action":"enable", "workspaceId":"other"}),
            serde_json::json!({"action":"reconfigure"}),
        ] {
            assert!(serde_json::from_value::<Action>(payload).is_err());
        }
    }

    #[test]
    fn exact_documents_only() {
        for (label, view) in [(PET, "pet"), (CHAT, "chat")] {
            for origin in ["tauri://localhost", "http://tauri.localhost"] {
                assert!(document_allowed(
                    &Url::parse(&format!("{origin}/assistant.html?view={view}")).unwrap(),
                    label
                ));
            }
            for raw in [
                "http://127.0.0.1:3080/assistant.html?view=pet",
                "http://tauri.localhost/assistant.html?view=pet&x=1",
                "http://tauri.localhost/assistant.html?view=pet#x",
                "http://tauri.localhost/index.html?view=pet",
            ] {
                assert!(!document_allowed(&Url::parse(raw).unwrap(), label));
            }
        }
    }
}
