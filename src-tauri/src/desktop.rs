use crate::{
    backend::Backend,
    config,
    environment::{self, EnvironmentReport},
    protocol::{
        backend_error, redact, validated_launch_url, validated_stop_pid,
        wait_for_launch_authentication, BackendReply,
    },
};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewBuilder,
    Emitter, EventTarget, Manager, Webview, WebviewUrl, Window, WindowBuilder, WindowEvent,
};
use url::Url;

#[path = "desktop_notifications.rs"]
mod notifications;
#[path = "desktop_titlebar.rs"]
mod titlebar;
#[path = "desktop_updates.rs"]
mod updates;

#[derive(Clone, Serialize)]
pub struct Snapshot {
    state: String,
    phase: String,
    message: String,
    busy: bool,
    managed: bool,
    origin: String,
    last_error: Option<String>,
    logs: Vec<String>,
    environment: EnvironmentReport,
    environment_checking: bool,
    config_path: String,
}
struct Controller {
    backend: Mutex<Option<config::Config>>,
    config_directory: PathBuf,
    legacy_config: PathBuf,
    snapshot: Mutex<Snapshot>,
    busy: AtomicBool,
    exiting: AtomicBool,
    // Serialize explicit quit with installer admission, not with WSL detection.
    installation: Mutex<bool>,
    log_path: PathBuf,
}
impl Controller {
    fn snapshot(&self) -> Snapshot {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        snapshot.busy = self.busy.load(Ordering::SeqCst);
        snapshot
    }
    fn publish(&self, app: &tauri::AppHandle) {
        let snapshot = self.snapshot();
        for label in ["launcher", "settings"] {
            let _ = app.emit_to(EventTarget::webview(label), "launcher-state", &snapshot);
        }
        if let Some(tray) = app.tray_by_id("dsh-tray") {
            let status = match snapshot.state.as_str() {
                "ready" => "运行中",
                "starting" => "启动中",
                "stopped" => "已停止",
                "error" => "需要处理",
                _ => "正在检查",
            };
            let _ = tray.set_tooltip(Some(format!("DSH · {status}")));
        }
    }
    fn record(&self, app: &tauri::AppHandle, message: &str) {
        let message = redact(message);
        {
            let mut s = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            s.logs.push(message.clone());
            if s.logs.len() > 120 {
                s.logs.remove(0);
            }
        }
        // This is only the launcher's own sanitized activity log, never DSH web.log.
        if let Some(parent) = self.log_path.parent() {
            let _ = fs::create_dir_all(parent);
            let oversized = fs::metadata(&self.log_path).is_ok_and(|m| m.len() > 512 * 1024);
            let file = if oversized {
                OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&self.log_path)
            } else {
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.log_path)
            };
            if let Ok(mut file) = file {
                let _ = writeln!(file, "{message}");
            }
        }
        self.publish(app);
    }
    fn phase(&self, app: &tauri::AppHandle, phase: &str, message: &str) {
        {
            let mut s = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            s.phase = phase.into();
            s.message = message.into();
            s.last_error = None;
        }
        self.record(app, message);
    }
    fn apply(&self, app: &tauri::AppHandle, reply: &BackendReply, idle: bool) {
        let mut s = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        s.state = reply.state.clone();
        s.managed = ["ready", "starting"].contains(&reply.state.as_str()) && reply.managed;
        if idle {
            s.phase = match reply.state.as_str() {
                "ready" => "已就绪",
                "stopped" => "服务已停止",
                "starting" => "服务正在启动",
                _ => "检查状态",
            }
            .into();
            s.message = match reply.state.as_str() {
                "ready" if reply.managed => "DSH 已就绪，可以打开工作窗口。",
                "ready" => "发现运行中的 DSH，尚未验证托管归属；不会自动停止它。",
                "stopped" => "服务未运行，点击打开 DSH 即可启动。",
                _ => "正在等待服务就绪。",
            }
            .into();
        }
        drop(s);
        self.publish(app);
    }
    fn failure(&self, app: &tauri::AppHandle, error: &str, reveal_startup: bool) {
        let error = redact(error);
        {
            let mut s = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            s.state = "error".into();
            // Preserve which stage failed so the splash does not blame environment checks.
            s.environment_checking = false;
            s.message = error.clone();
            s.last_error = Some(error.clone());
        }
        self.record(app, &error);
        if reveal_startup {
            show_launcher(app);
        }
    }
    fn backend(&self) -> Result<Backend, String> {
        let config = self
            .backend
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        config
            .map(Backend::new)
            .ok_or_else(|| "启动配置不可用，请按环境检查提示处理。".into())
    }
}

fn settings_section(section: &str) -> bool {
    matches!(
        section,
        "environment" | "notifications" | "updates" | "logs"
    )
}

/// Only the bundled content views, never a titlebar or the remote DSH page.
fn local_content(url: &Url, label: &str) -> bool {
    let packaged = ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none();
    let dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    if !(packaged || dev)
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "/" | "/index.html")
        || url.fragment().is_some()
    {
        return false;
    }
    match label {
        "launcher" => url.query().is_none(),
        "settings" => {
            let pairs: Vec<_> = url.query_pairs().collect();
            pairs.len() == 2
                && pairs
                    .iter()
                    .any(|(key, value)| key.as_ref() == "view" && value.as_ref() == "settings")
                && pairs.iter().any(|(key, value)| {
                    key.as_ref() == "section" && settings_section(value.as_ref())
                })
        }
        _ => false,
    }
}

fn assert_local(window: &Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法验证调用窗口。")?;
    if !matches!(
        (window.label(), window.window().label()),
        ("launcher", "launcher") | ("settings", "settings")
    ) || !local_content(&url, window.label())
    {
        return Err("此页面无权控制本机服务。".into());
    }
    Ok(())
}

#[tauri::command]
async fn open_settings(
    window: Webview,
    app: tauri::AppHandle,
    section: String,
) -> Result<(), String> {
    assert_local(&window)?;
    // WebView2 child creation must not synchronously block the Windows UI thread.
    tauri::async_runtime::spawn_blocking(move || show_settings(&app, &section))
        .await
        .map_err(|_| "设置窗口线程异常结束。".to_owned())?
}
#[tauri::command]
fn get_snapshot(
    window: Webview,
    state: tauri::State<'_, Arc<Controller>>,
) -> Result<Snapshot, String> {
    assert_local(&window)?;
    Ok(state.snapshot())
}
#[tauri::command]
async fn perform_action(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Controller>>,
    action: String,
) -> Result<Snapshot, String> {
    assert_local(&window)?;
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || perform(&app, &controller, &action))
        .await
        .map_err(|_| "操作线程异常结束。".to_owned())?
}

#[tauri::command]
async fn set_project_directory(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Controller>>,
    repository: String,
) -> Result<Snapshot, String> {
    assert_local(&window)?;
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if controller
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("已有操作正在进行，请稍候。".into());
        }
        controller.publish(&app);
        let result = (|| -> Result<(), String> {
            if ["ready", "starting"].contains(&controller.snapshot().state.as_str()) {
                return Err("服务运行时不能修改 DSH 目录，请先停止服务。".into());
            }
            let config = reload_config(&controller)?;
            environment::save_repository(&config, &repository)?;
            controller.record(
                &app,
                "已保存 DSH 目录，正在重新检测；未安装软件或重启现有服务。",
            );
            ensure_ready(&app, &controller, true)
        })();
        if let Err(error) = result {
            // Keep invalid directory/save errors in Settings; do not steal focus.
            controller.failure(&app, &error, false);
            controller.busy.store(false, Ordering::SeqCst);
            controller.publish(&app);
            return Err(error);
        }
        controller.busy.store(false, Ordering::SeqCst);
        controller.publish(&app);
        Ok(controller.snapshot())
    })
    .await
    .map_err(|_| "配置线程异常结束。".to_owned())?
}

fn show_launcher(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("launcher") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
// Serialize concurrent menu/IPC requests without ever taking this lock on the UI thread.
static SETTINGS_WINDOW: Mutex<()> = Mutex::new(());

/// Create or reactivate the single settings window. Call from a worker thread.
pub fn show_settings(app: &tauri::AppHandle, section: &str) -> Result<(), String> {
    if !settings_section(section) {
        return Err("不支持的设置页面。".into());
    }
    let _guard = SETTINGS_WINDOW.lock().unwrap_or_else(|e| e.into_inner());
    let window = if let Some(window) = app.get_window("settings") {
        // Preserve the loaded page and unsaved edits when switching sections.
        app.emit_to(
            EventTarget::webview("settings"),
            "launcher-show-settings",
            section,
        )
        .map_err(|_| "无法切换设置页面。")?;
        window
    } else {
        let window = WindowBuilder::new(app, "settings")
            .title("DSH · 设置")
            .decorations(false)
            .inner_size(860.0, 680.0)
            .min_inner_size(700.0, 560.0)
            .visible(false)
            .build()
            .map_err(|_| "无法创建设置窗口。")?;
        fit_window(&window, 860, 680);
        let result = (|| -> tauri::Result<()> {
            let (position, size) = titlebar::content_geometry(&window)?;
            window.add_child(
                WebviewBuilder::new(
                    "settings",
                    WebviewUrl::App(format!("index.html?view=settings&section={section}").into()),
                )
                .on_navigation(|target| local_content(target, "settings"))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
                position,
                size,
            )?;
            titlebar::attach(&window)
        })();
        if result.is_err() {
            let _ = window.destroy();
            return Err("无法创建设置 WebView2 窗口，请检查 WebView2 Runtime。".into());
        }
        window
    };
    window.show().map_err(|_| "无法显示设置窗口。")?;
    window.unminimize().map_err(|_| "无法还原设置窗口。")?;
    window.set_focus().map_err(|_| "无法激活设置窗口。")?;
    Ok(())
}

fn activate(app: &tauri::AppHandle) {
    if let Some(controller) = app.try_state::<Arc<Controller>>() {
        let snapshot = controller.snapshot();
        if snapshot.state == "ready" && app.get_window("dsh").is_some() {
            show_dsh(app);
        } else {
            show_launcher(app);
            if !snapshot.busy {
                dispatch(app, "open");
            }
        }
    } else {
        show_launcher(app);
    }
}

fn show_dsh(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("dsh") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        show_launcher(app);
    }
}

/// Native confirmation defaults to NO, including when invoked from the tray.
fn confirm(action: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO,
    };
    let verb = match action {
        "stop" => "停止服务",
        "restart" => "重启服务",
        _ => "停止服务并退出",
    };
    let text: Vec<u16> = format!("确定要{verb}吗？\n\n这会中断 DSH 中所有正在运行的任务和连接，包括旧启动器连接的会话。不会关闭整个 WSL。\n\n如只想退出窗口，请选择“仅退出启动器”。").encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "DeepSeek Harness".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        ) == IDYES
    }
}

fn windows_status(origin: &str) -> Option<u16> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?
        .get(format!("{origin}/"))
        .send()
        .ok()
        .map(|r| r.status().as_u16())
}
// Refresh from disk so fixing configuration never requires restarting the launcher.
fn reload_config(controller: &Controller) -> Result<config::Config, String> {
    let loaded = config::load(&controller.config_directory, &controller.legacy_config);
    // Keep the last valid control target on a malformed edit, so an owned
    // running service can still be stopped safely using its original settings.
    if let Ok(loaded) = &loaded {
        *controller.backend.lock().unwrap_or_else(|e| e.into_inner()) = Some(loaded.config.clone());
    }
    loaded.map(|loaded| loaded.config)
}

fn check_environment(app: &tauri::AppHandle, controller: &Controller) -> Result<(), String> {
    {
        let mut s = controller
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        s.environment = EnvironmentReport::pending();
        s.environment_checking = true;
    }
    controller.phase(
        app,
        "检测运行环境",
        "正在检查运行环境；不会安装软件或修改系统配置。 ",
    );
    let loaded = reload_config(controller);
    let report = environment::inspect(
        loaded.as_ref().ok(),
        loaded.as_ref().err().map(String::as_str),
    );
    let passed = report.passed();
    {
        let mut s = controller
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Ok(config) = &loaded {
            s.origin = config.origin();
        }
        s.environment = report;
        s.environment_checking = false;
    }
    controller.publish(app);
    if !passed {
        return Err("运行环境尚未准备好，请按检查列表处理后重新检测。".into());
    }
    Ok(())
}

fn ensure_ready(
    app: &tauri::AppHandle,
    controller: &Controller,
    open_window: bool,
) -> Result<(), String> {
    check_environment(app, controller)?;
    if controller.exiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    let backend = controller.backend()?;
    let deadline = Instant::now() + Duration::from_secs(backend.config.startup_timeout_seconds);
    let mut started = false;
    let mut bootstrap_deadline = deadline;
    let mut supervisor = None;
    controller.phase(app, "检查 WSL", "正在检查已有 DSH 服务，不会重复启动。 ");
    loop {
        if controller.exiting.load(Ordering::SeqCst) {
            return Ok(());
        }
        let reply = match backend.invoke("probe") {
            Ok(reply) => reply,
            Err(error)
                if started
                    && Instant::now() < bootstrap_deadline
                    && [
                        backend_error(Some("unverified_startup")),
                        backend_error(Some("process_changed")),
                    ]
                    .contains(&error) =>
            {
                // A fresh child can listen just before its supervisor publishes run.json.
                thread::sleep(Duration::from_millis(500));
                continue;
            }
            Err(error) => return Err(error),
        };
        if controller.exiting.load(Ordering::SeqCst) {
            return Ok(());
        }
        controller.apply(app, &reply, false);
        match reply.state.as_str() {
            "ready" => {
                let url = validated_launch_url(&reply, backend.config.port)?;
                if controller.snapshot().phase != "等待网页登录认证" {
                    controller.phase(
                        app,
                        "检查本机连接",
                        "服务已就绪，正在确认 Windows 可以访问。 ",
                    );
                }
                if let Some(status @ (200 | 401)) = windows_status(&backend.config.origin()) {
                    if controller.exiting.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    if open_window {
                        if wait_for_launch_authentication(&reply, status, Instant::now(), deadline)?
                        {
                            if controller.snapshot().phase != "等待网页登录认证" {
                                controller.phase(
                                    app,
                                    "等待网页登录认证",
                                    "服务已启动，正在等待网页登录认证链接；就绪后将自动打开 DSH。",
                                );
                            }
                            // Re-probe without spawning or restarting the managed service.
                            thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                        controller.phase(app, "打开工作窗口", "正在加载 DSH 工作窗口。 ");
                        open_dsh(app, &backend.config, url)?;
                    }
                    controller.phase(
                        app,
                        "已就绪",
                        if open_window {
                            "DSH 已就绪；关闭工作窗口不会停止后台任务。"
                        } else {
                            "DSH 已启动，可以打开工作窗口。"
                        },
                    );
                    return Ok(());
                }
            }
            "stopped" if started => {
                // The detached wrapper can finish before the supervisor takes its lock.
                // Wait briefly for that handoff, without spawning a duplicate supervisor.
                if Instant::now() >= bootstrap_deadline {
                    return Err("DSH 在就绪前退出，请检查 WSL 服务日志；未自动重启。".into());
                }
            }
            "stopped" => {
                controller.phase(
                    app,
                    "启动服务",
                    "正在启动 WSL 内的 DSH，首次启动可能需要一些时间。 ",
                );
                // Do not spawn a supervisor after a concurrent explicit quit.
                let _admission = controller
                    .installation
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if controller.exiting.load(Ordering::SeqCst) {
                    return Ok(());
                }
                supervisor = Some(backend.start()?);
                bootstrap_deadline = (Instant::now() + Duration::from_secs(3)).min(deadline);
                started = true;
            }
            "starting" => (),
            _ => return Err("后端返回了非预期的服务状态。".into()),
        }
        if let Some(child) = supervisor.as_mut() {
            if let Some(status) = child.try_wait().map_err(|_| "无法检查后台启动状态。")?
            {
                if !status.success() {
                    return Err("WSL 后台进程启动失败，请检查 WSL 服务日志。".into());
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(
                "等待 DSH 就绪超时。服务可能仍在启动；不会自动停止现有服务，请稍后重试。".into(),
            );
        }
        thread::sleep(Duration::from_millis(500));
    }
}
fn stop_service(app: &tauri::AppHandle, controller: &Controller) -> Result<(), String> {
    let backend = controller.backend()?;
    let reply = backend.invoke("probe")?;
    if reply.state == "stopped" {
        controller.apply(app, &reply, false);
        return Ok(());
    }
    // Authorize by verified PID/lock/start time, never by a browser launch token.
    // The adapter rechecks identity under operation.lock immediately before signaling.
    let expected_pid = validated_stop_pid(&reply)?;
    controller.phase(
        app,
        "停止服务",
        "正在请求 DSH 正常退出，不会强制结束进程或关闭 WSL。 ",
    );
    let stopped = backend.stop(expected_pid)?;
    if stopped.state != "stopped" {
        return Err("未确认服务停止，不会继续执行重启或退出。".into());
    }
    controller.apply(app, &stopped, false);
    controller.phase(app, "服务已停止", "DSH 已确认停止。 ");
    Ok(())
}

fn open_external(url: &Url, trusted: &Url) {
    // Never send loopback launch credentials, userinfo or non-web schemes to a shell.
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url
            .query_pairs()
            .any(|(key, _)| key.eq_ignore_ascii_case("token"))
    {
        return;
    }
    if url.origin() == trusted.origin() {
        return;
    }
    let target = url.to_string();
    thread::spawn(move || {
        let _ = open::that_detached(target);
    });
}
fn open_dsh(app: &tauri::AppHandle, config: &config::Config, url: Url) -> Result<(), String> {
    if let Some(view) = app.get_webview("dsh") {
        view.navigate(url)
            .map_err(|_| "无法重新连接 DSH 工作窗口。")?;
        show_dsh(app);
        return Ok(());
    }
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法确定 WebView 数据目录。")?
        .join("webview");
    fs::create_dir_all(&data).map_err(|_| "无法创建 WebView 数据目录。")?;
    let trusted = Url::parse(&config.origin()).map_err(|_| "本机地址配置错误。")?;
    let nav_origin = trusted.clone();
    let popup_origin = trusted.clone();
    let page_origin = trusted.clone();
    let app_on_load = app.clone();
    let window = WindowBuilder::new(app, "dsh")
        .title("DeepSeek Harness · WSL")
        .decorations(false)
        .inner_size(config.window_width as f64, config.window_height as f64)
        .min_inner_size(600.0, 400.0)
        .visible(false)
        .build()
        .map_err(|_| "无法创建 DSH 工作窗口。")?;
    fit_window(&window, config.window_width, config.window_height);
    let result = (|| -> tauri::Result<()> {
        let (position, size) = titlebar::content_geometry(&window)?;
        window.add_child(
            WebviewBuilder::new("dsh", WebviewUrl::External(url))
                .data_directory(data)
                .on_navigation(move |target| {
                    if target.origin() == nav_origin.origin() {
                        true
                    } else {
                        open_external(target, &nav_origin);
                        false
                    }
                })
                .on_new_window(move |target, _| {
                    // Internal previews stay in the existing remote view and gain no IPC.
                    if target.origin() == popup_origin.origin() {
                        if let Some(view) = app_on_load.get_webview("dsh") {
                            let _ = view.navigate(target);
                        }
                    } else {
                        open_external(&target, &popup_origin);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(move |view, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished
                        && payload.url().origin() == page_origin.origin()
                    {
                        let window = view.window();
                        let _ = window.show();
                        let _ = window.set_focus();
                        if let Some(launcher) = view.app_handle().get_window("launcher") {
                            let _ = launcher.hide();
                        }
                    }
                }),
            position,
            size,
        )?;
        titlebar::attach(&window)
    })();
    if result.is_err() {
        // Never leave a frameless, uncontrollable window after partial creation.
        let _ = window.destroy();
        return Err("无法创建 WebView2 工作窗口，请检查 WebView2 Runtime。".into());
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}
fn fit_window(window: &Window, width: u32, height: u32) {
    // Tauri's monitor conversion handles mixed DPI. Clamp to 90% of the work area.
    let monitor = window
        .app_handle()
        .cursor_position()
        .ok()
        .and_then(|point| window.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let w = (width as f64).min(work.size.width as f64 / scale * 0.90);
        let h = (height as f64).min(work.size.height as f64 / scale * 0.90);
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
        let actual = window.outer_size().ok();
        if let Some(actual) = actual {
            let x = work.position.x + (work.size.width as i32 - actual.width as i32) / 2;
            let y = work.position.y + (work.size.height as i32 - actual.height as i32) / 2;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    } else {
        let _ = window.center();
    }
}

fn perform(
    app: &tauri::AppHandle,
    controller: &Arc<Controller>,
    action: &str,
) -> Result<Snapshot, String> {
    if ![
        "open", "check", "start", "stop", "restart", "logs", "quit", "exit",
    ]
    .contains(&action)
    {
        return Err("不支持的操作。".into());
    }
    if action == "logs" {
        show_settings(app, "logs")?;
        return Ok(controller.snapshot());
    }
    // A read-only probe or a stalled startup must never trap the user in the UI.
    // Keep installer admission serialized, but do not wait for the WSL busy flag.
    if action == "quit" {
        {
            let installing = controller
                .installation
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if *installing {
                return Err("更新安装正在进行，请完成或取消后退出。".into());
            }
            controller.exiting.store(true, Ordering::SeqCst);
        }
        controller.record(
            app,
            "仅退出启动器，不再等待服务操作；不会额外停止 WSL 服务。",
        );
        app.exit(0);
        return Ok(controller.snapshot());
    }
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
    controller.publish(app);
    let result = (|| -> Result<(), String> {
        if ["stop", "restart", "exit"].contains(&action) && !confirm(action) {
            controller.phase(app, "操作已取消", "已取消操作，后台服务保持原状。 ");
            return Ok(());
        }
        match action {
            "open" | "check" => ensure_ready(app, controller, true),
            "start" => ensure_ready(app, controller, false),
            "stop" => stop_service(app, controller),
            "restart" => {
                stop_service(app, controller)?;
                ensure_ready(app, controller, true)
            }
            "exit" => {
                stop_service(app, controller)?;
                controller.exiting.store(true, Ordering::SeqCst);
                app.exit(0);
                Ok(())
            }
            _ => unreachable!(),
        }
    })();
    if let Err(error) = result {
        // Publish the failure while still owning the operation slot.
        controller.failure(app, &error, true);
        controller.busy.store(false, Ordering::SeqCst);
        controller.publish(app);
        return Err(error);
    }
    controller.busy.store(false, Ordering::SeqCst);
    controller.publish(app);
    Ok(controller.snapshot())
}
fn dispatch(app: &tauri::AppHandle, action: &'static str) {
    let app = app.clone();
    let controller = app.state::<Arc<Controller>>().inner().clone();
    thread::spawn(move || {
        let _ = perform(&app, &controller, action);
    });
}

/// One handler for both the top menu and tray: keep confirmations and update locks intact.
fn handle_menu_action(app: &tauri::AppHandle, id: &str) {
    match id {
        "open" => dispatch(app, "open"),
        "logs" => dispatch(app, "logs"),
        "environment" | "notifications" => {
            let app = app.clone();
            let section = id.to_owned();
            thread::spawn(move || {
                if let Err(error) = show_settings(&app, &section) {
                    app.state::<Arc<Controller>>().record(&app, &error);
                }
            });
        }
        "updates" => {
            let app = app.clone();
            thread::spawn(move || {
                if let Err(error) = updates::show_updates(&app) {
                    app.state::<Arc<Controller>>().record(&app, &error);
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<Arc<updates::Updates>>().inner().clone();
                    updates::check(&app, &state).await;
                });
            });
        }
        "start" => dispatch(app, "start"),
        "stop" => dispatch(app, "stop"),
        "restart" => dispatch(app, "restart"),
        "quit" => dispatch(app, "quit"),
        "exit" => dispatch(app, "exit"),
        _ => (),
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .on_menu_event(|app, event| handle_menu_action(app, event.id.as_ref()))
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            activate(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            open_settings,
            perform_action,
            set_project_directory,
            updates::get_update_snapshot,
            updates::check_update,
            updates::install_update,
            notifications::get_notification_snapshot,
            notifications::set_notifications_enabled,
            notifications::test_notification,
            titlebar::titlebar_action,
            titlebar::show_titlebar_menu
        ])
        .setup(|app| {
            let directory = app.path().app_config_dir()?;
            let legacy = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| directory.clone())
                .join("DeepSeekHarnessLauncher/config.json");
            let loaded = config::load(&directory, &legacy);
            let (backend, error, imported) = match loaded {
                Ok(loaded) => {
                    let _ = loaded.path;
                    (Some(Backend::new(loaded.config)), None, loaded.imported)
                }
                Err(error) => (None, Some(error), false),
            };
            let origin = backend
                .as_ref()
                .map(|b| b.config.origin())
                .unwrap_or_else(|| "http://127.0.0.1:3080".into());
            let controller = Arc::new(Controller {
                backend: Mutex::new(backend.map(|b| b.config)),
                config_directory: directory.clone(),
                legacy_config: legacy,
                snapshot: Mutex::new(Snapshot {
                    state: if error.is_some() { "error" } else { "unknown" }.into(),
                    phase: "准备启动".into(),
                    message: error
                        .clone()
                        .unwrap_or_else(|| "正在准备 WSL 运行环境。".into()),
                    busy: false,
                    managed: false,
                    origin,
                    last_error: error,
                    logs: Vec::new(),
                    environment: EnvironmentReport::pending(),
                    environment_checking: true,
                    config_path: directory.join("config.json").to_string_lossy().into_owned(),
                }),
                busy: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
                installation: Mutex::new(false),
                log_path: directory.join("launcher.log"),
            });
            app.manage(controller.clone());
            let notification_state = Arc::new(notifications::Notifications::new(directory.clone()));
            app.manage(notification_state.clone());
            notifications::start(app.handle().clone(), controller.clone(), notification_state);
            app.manage(Arc::new(updates::Updates::new(
                &app.package_info().version.to_string(),
            )));
            if imported {
                controller.record(
                    app.handle(),
                    "已导入旧启动器配置；旧脚本、浏览器数据和 DSH 配置未修改。",
                );
            }
            app.manage(titlebar::Menus::new(app.handle())?);
            let launcher = WindowBuilder::new(app, "launcher")
                .title("DSH · WSL Desktop")
                .decorations(false)
                .inner_size(640.0, 640.0)
                .min_inner_size(540.0, 520.0)
                .center()
                .build()?;
            let (position, size) = titlebar::content_geometry(&launcher)?;
            launcher.add_child(
                WebviewBuilder::new("launcher", WebviewUrl::App("index.html".into()))
                    .on_navigation(|target| local_content(target, "launcher"))
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
                position,
                size,
            )?;
            titlebar::attach(&launcher)?;
            let open = MenuItem::with_id(app, "open", "打开 DSH", true, None::<&str>)?;
            let control = MenuItem::with_id(app, "logs", "诊断日志…", true, None::<&str>)?;
            let update = MenuItem::with_id(app, "updates", "检查启动器更新…", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "启动服务", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "停止服务…", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启服务…", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "仅退出启动器（保留服务）", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "停止服务并退出…", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open, &control, &update, &start, &stop, &restart, &quit, &exit,
                ],
            )?;
            TrayIconBuilder::with_id("dsh-tray")
                .icon(app.default_window_icon().cloned().ok_or("缺少应用图标")?)
                .tooltip("DSH · 正在启动")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        activate(tray.app_handle());
                    }
                })
                .build(app)?;
            // Always diagnose, including first run with no launcher configuration.
            dispatch(app.handle(), "open");
            let monitor_app = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(15));
                if controller.exiting.load(Ordering::SeqCst) {
                    break;
                }
                let snapshot = controller.snapshot();
                if snapshot.state != "ready" || !snapshot.environment.passed() {
                    continue;
                } // Do not repeatedly wake a stopped WSL.
                if controller
                    .busy
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    continue;
                }
                // The pre-lock snapshot may predate a just-completed failed operation.
                // Never erase its recovery/error UI with a late monitor result.
                let current = controller.snapshot();
                if current.state != "ready"
                    || current.last_error.is_some()
                    || !current.environment.passed()
                {
                    controller.busy.store(false, Ordering::SeqCst);
                    continue;
                }
                if let Ok(backend) = controller.backend() {
                    match backend.invoke("probe") {
                        Ok(reply) => {
                            controller.apply(&monitor_app, &reply, true);
                            controller.busy.store(false, Ordering::SeqCst);
                            controller.publish(&monitor_app);
                        }
                        Err(error) => {
                            {
                                let mut s = controller
                                    .snapshot
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                s.state = "error".into();
                                s.last_error = Some(redact(&error));
                                s.phase = "状态查询失败".into();
                                s.message = redact(&error);
                            }
                            controller.record(&monitor_app, &error);
                            controller.busy.store(false, Ordering::SeqCst);
                            controller.publish(&monitor_app);
                        }
                    }
                } else {
                    controller.busy.store(false, Ordering::SeqCst);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            titlebar::on_window_event(window, event);
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(controller) = window.app_handle().try_state::<Arc<Controller>>() {
                    if !controller.exiting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize DSH WSL Desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Some(controller) = app.try_state::<Arc<Controller>>() {
                if !controller.exiting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        }
    });
}

#[cfg(test)]
mod content_security_tests {
    use super::local_content;
    use url::Url;

    #[test]
    fn only_exact_bundled_documents_and_settings_sections_are_trusted() {
        for origin in ["tauri://localhost", "http://tauri.localhost"] {
            assert!(local_content(
                &Url::parse(&format!("{origin}/index.html")).unwrap(),
                "launcher"
            ));
            for section in ["environment", "notifications", "updates", "logs"] {
                let url = Url::parse(&format!(
                    "{origin}/index.html?view=settings&section={section}"
                ))
                .unwrap();
                assert!(local_content(&url, "settings"));
                assert!(!local_content(&url, "launcher"));
                assert!(!local_content(&url, "dsh"));
            }
        }
        let dev = Url::parse("http://127.0.0.1:1420/?view=settings&section=environment").unwrap();
        assert_eq!(local_content(&dev, "settings"), cfg!(debug_assertions));
    }

    #[test]
    fn remote_unexpected_and_ambiguous_settings_urls_are_rejected() {
        for raw in [
            "http://127.0.0.1:3080/?view=settings&section=environment",
            "https://example.com/index.html?view=settings&section=environment",
            "http://tauri.localhost/titlebar.html?view=settings&section=environment",
            "http://tauri.localhost/index.html?view=settings",
            "http://tauri.localhost/index.html?view=settings&section=unknown",
            "http://tauri.localhost/index.html?view=settings&section=logs&section=updates",
            "http://tauri.localhost/index.html?view=settings&section=logs&extra=1",
            "http://tauri.localhost/index.html?view=settings&section=logs#other",
            "http://user:password@tauri.localhost/index.html?view=settings&section=logs",
        ] {
            assert!(
                !local_content(&Url::parse(raw).unwrap(), "settings"),
                "unexpected trusted URL: {raw}"
            );
        }
    }
}
