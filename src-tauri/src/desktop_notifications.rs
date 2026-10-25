//! Windows notification adapter. No DSH-page IPC, injected scripts or Host mutations.
use super::{assert_local, Controller};
use crate::{
    notification_channels::{ChannelGate, SystemDelivery},
    notification_transport::RpcClient,
    notifications::{
        notification_session_url, task_notice_body, CursorTracker, NoticeKind,
        NotificationSettings, NotificationSnapshot,
    },
    pet_notifications::BubbleKind,
    user_attention::AttentionTracker,
};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, EventTarget, Manager, Webview};
use tauri_plugin_notification::NotificationExt;
use url::Url;

static CLICK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Data {
    snapshot: NotificationSnapshot,
    epoch: u64,
    delivery_error: Option<String>,
}
pub(super) struct Notifications {
    directory: PathBuf,
    data: Mutex<Data>,
    wake: Condvar,
    toasts: super::toasts::Toasts,
}
impl Notifications {
    pub(super) fn new(directory: PathBuf) -> Self {
        let snapshot = match NotificationSettings::load(&directory) {
            Ok(settings) => NotificationSnapshot {
                enabled: settings.enabled,
                notify_when_focused: settings.notify_when_focused,
                phase: if settings.enabled {
                    "connecting"
                } else {
                    "disabled"
                }
                .into(),
                message: if settings.enabled {
                    "等待 DSH 工作窗口完成登录；将自动检查执行结果。"
                } else {
                    "系统通知已关闭。"
                }
                .into(),
            },
            Err(message) => NotificationSnapshot {
                enabled: false,
                notify_when_focused: false,
                phase: "error".into(),
                message,
            },
        };
        Self {
            directory,
            data: Mutex::new(Data {
                snapshot,
                epoch: 0,
                delivery_error: None,
            }),
            wake: Condvar::new(),
            toasts: super::toasts::Toasts::new(),
        }
    }
    fn snapshot(&self) -> NotificationSnapshot {
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
                "launcher-notification-state",
                &snapshot,
            );
        }
    }
    fn status(&self, app: &tauri::AppHandle, epoch: u64, phase: &str, message: &str) {
        let changed = {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            if !data.snapshot.enabled || data.epoch != epoch {
                return;
            }
            let (phase, message) = match &data.delivery_error {
                Some(error) => ("error", error.clone()),
                None if phase == "listening" => (
                    phase,
                    listening_message(data.snapshot.notify_when_focused).to_owned(),
                ),
                None => (phase, message.to_owned()),
            };
            if data.snapshot.phase == phase && data.snapshot.message == message {
                false
            } else {
                data.snapshot.phase = phase.into();
                data.snapshot.message = message;
                true
            }
        };
        if changed {
            self.publish(app);
        }
    }
    fn wait(&self, epoch: u64) {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.epoch == epoch {
            drop(self.wake.wait_timeout(data, Duration::from_secs(3)));
        }
    }
    fn gate(&self, app: &tauri::AppHandle) -> ChannelGate {
        let (toasts, toast_epoch) = {
            let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            (data.snapshot.enabled, data.epoch)
        };
        let (bubbles, bubble_epoch) = super::pet_settings::bubble_gate(app);
        // Pet display replaces the system toast with sound, even if bubbles are disabled.
        ChannelGate::route(
            toasts,
            toast_epoch,
            super::pet_settings::pet_visible(app),
            bubbles,
            bubble_epoch,
        )
    }
    fn current(&self, app: &tauri::AppHandle, captured: ChannelGate) -> bool {
        captured.current(self.gate(app))
    }
}

#[tauri::command]
pub(super) fn get_notification_snapshot(
    window: Webview,
    state: tauri::State<'_, Arc<Notifications>>,
) -> Result<NotificationSnapshot, String> {
    assert_local(&window)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub(super) async fn set_notifications_enabled(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Notifications>>,
    enabled: bool,
    notify_when_focused: Option<bool>,
) -> Result<NotificationSnapshot, String> {
    assert_local(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            // Serializes disk writes and notification delivery with disable.
            let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            let settings = NotificationSettings {
                enabled,
                notify_when_focused: notify_when_focused
                    .unwrap_or(data.snapshot.notify_when_focused),
            };
            settings.save(&state.directory)?;
            // Only enable/disable starts a new generation. Changing the focus policy
            // must not discard cursors or replay already-consumed pending questions.
            if data.snapshot.enabled != enabled {
                data.epoch = data.epoch.wrapping_add(1);
                data.delivery_error = None;
                data.snapshot.phase = if enabled { "connecting" } else { "disabled" }.into();
                data.snapshot.message = if enabled {
                    "已启用，正在连接 DSH。"
                } else {
                    "系统通知已关闭。"
                }
                .into();
            } else if data.snapshot.phase == "listening" && data.delivery_error.is_none() {
                data.snapshot.message = listening_message(settings.notify_when_focused).into();
            }
            data.snapshot.enabled = settings.enabled;
            data.snapshot.notify_when_focused = settings.notify_when_focused;
        }
        state.publish(&app);
        state.wake.notify_all();
        Ok(state.snapshot())
    })
    .await
    .map_err(|_| "保存通知设置的线程异常结束。".to_string())?
}

#[tauri::command]
pub(super) async fn test_notification(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Notifications>>,
) -> Result<NotificationSnapshot, String> {
    assert_local(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = {
            let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            if !data.snapshot.enabled {
                return Err("请先启用系统通知。".into());
            }
            match send(
                &app,
                "DSH · 测试通知",
                "任务：示例任务（测试通知）\n通知测试已提交。Windows 通知设置或勿扰模式可能屏蔽横幅。",
            ) {
                Ok(()) => {
                    data.delivery_error = None;
                    data.snapshot.message =
                        "测试通知已提交给 Windows，不代表横幅一定显示；请检查系统通知和勿扰设置。"
                            .into();
                    Ok(data.snapshot.clone())
                }
                Err(message) => {
                    data.delivery_error = Some(message.clone());
                    data.snapshot.phase = "error".into();
                    data.snapshot.message = message.clone();
                    Err(message)
                }
            }
        };
        state.publish(&app);
        result
    })
    .await
    .map_err(|_| "测试通知的线程异常结束。".to_string())?
}

fn send(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        // The Windows backend maps an omitted sound to <audio silent="true" />.
        // Request the OS default without bypassing system mute/notification settings.
        .sound("Default")
        .show()
        .map_err(|_| "无法提交系统通知，请在 Windows 安装版中重试，并检查系统通知设置。".into())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// Shared read-only session client for notifications and the independent power worker.
/// Read only the HttpOnly auth cookie whose audience is this configured authority.
/// Browser cookies are otherwise shared between localhost ports. Never log it.
pub(super) fn client(app: &tauri::AppHandle, origin: &str) -> Result<RpcClient, String> {
    RpcClient::new(origin, auth_cookie(app, origin)?)
}

/// Native authentication shared by fixed-purpose desktop clients. Never expose to JavaScript.
pub(super) fn auth_cookie(app: &tauri::AppHandle, origin: &str) -> Result<String, String> {
    let url = Url::parse(origin).map_err(|_| "本机服务地址无效。".to_owned())?;
    let window = app
        .get_webview("dsh")
        .ok_or("等待 DSH 工作窗口完成登录。")?;
    if window
        .url()
        .map_err(|_| "无法验证 DSH 工作窗口。")?
        .origin()
        != url.origin()
    {
        return Err("等待 DSH 工作窗口返回本机服务。".into());
    }
    let authority = match url.port() {
        Some(port) => format!("127.0.0.1:{port}"),
        None => "127.0.0.1".into(),
    };
    let name = format!(
        "dsh-auth-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(authority.as_bytes()))
    );
    // Called only on the worker thread: WebView2's synchronous cookie getter must
    // not block the Windows UI thread. Credentials never enter snapshots or disk.
    let cookies = window
        .cookies_for_url(url)
        .map_err(|_| "无法读取 DSH 登录状态，请重新打开工作窗口。")?;
    let cookie = cookies
        .into_iter()
        .find(|cookie| cookie.name() == name)
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .unwrap_or_default();
    Ok(cookie)
}

fn foreground(app: &tauri::AppHandle) -> bool {
    !super::settings_page::is_active("dsh")
        && app.get_window("dsh").is_some_and(|window| {
            window.is_visible().unwrap_or(true)
                && !window.is_minimized().unwrap_or(false)
                && window.is_focused().unwrap_or(true)
        })
}

fn listening_message(notify_when_focused: bool) -> &'static str {
    if notify_when_focused {
        "正在检查执行结果与待答问题（约每 3 秒）；窗口聚焦时也提醒，显示会话名称，不显示正文。"
    } else {
        "正在检查执行结果与待答问题（约每 3 秒）；前台静默，显示会话名称，不显示正文。"
    }
}

/// Share the same focus policy, disable and exit guards for every notification kind.
fn deliver(
    app: &tauri::AppHandle,
    controller: &Controller,
    state: &Notifications,
    epoch: u64,
    channels: ChannelGate,
    target: Url,
    title: &str,
    body: &str,
    kind: BubbleKind,
    key: &str,
) {
    // WebView/window queries may marshal to the UI thread. Never hold the state
    // lock while the UI could be reading a notification snapshot.
    let is_foreground = foreground(app);
    if controller.exiting.load(Ordering::SeqCst) || controller.snapshot().state != "ready" {
        return;
    }
    let notify_when_focused = {
        let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
        data.snapshot.notify_when_focused
    };
    if channels.allows_bubble(state.gate(app)) && (!is_foreground || notify_when_focused) {
        super::pet_notifications::emit(app, target.clone(), kind, title, body, key);
    }
    let Some(delivery) =
        channels.system_delivery(state.gate(app), is_foreground, notify_when_focused)
    else {
        return;
    };
    let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
    let settings = NotificationSettings {
        enabled: data.snapshot.enabled,
        notify_when_focused: data.snapshot.notify_when_focused,
    };
    if !settings.should_notify(is_foreground)
        || data.epoch != epoch
        || controller.exiting.load(Ordering::SeqCst)
        || controller.snapshot().state != "ready"
    {
        return;
    }
    let result = match delivery {
        SystemDelivery::SoundOnly => super::toasts::play_notification_sound(),
        SystemDelivery::Toast => {
            let click_app = app.clone();
            let app_id = toast_app_id(app);
            state.toasts.show(&app_id, title, body, move || {
                if let Err(message) = open_notified_session(&click_app, &target) {
                    if let Some(controller) = click_app.try_state::<Arc<Controller>>() {
                        // Fixed diagnostics only: no session name, ID, URL or credentials in logs.
                        controller.record(&click_app, &message);
                    }
                }
            })
        }
    };
    if let Err(message) = result {
        data.delivery_error = Some(message);
    }
}

// Match the existing plugin's installed-app identity and development fallback.
fn toast_app_id(app: &tauri::AppHandle) -> String {
    let development = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.display().to_string()))
        .is_some_and(|directory| {
            let sep = std::path::MAIN_SEPARATOR;
            directory.ends_with(&format!("{sep}target{sep}debug"))
                || directory.ends_with(&format!("{sep}target{sep}release"))
        });
    if development {
        r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe".into()
    } else {
        app.config().identifier.clone()
    }
}

/// Native activation worker only. No new window/service, injected script or remote IPC.
pub(super) fn open_notified_session(app: &tauri::AppHandle, target: &Url) -> Result<(), String> {
    let controller = app
        .try_state::<Arc<Controller>>()
        .ok_or("启动器尚未就绪。")?;
    if controller.exiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    if controller.snapshot().state != "ready" {
        super::show_launcher(app);
        return Err("通知对应的服务当前不可用，请在启动器中检查连接。".into());
    }
    let backend = controller.backend()?;
    let origin = Url::parse(&backend.config.origin()).map_err(|_| "本机服务地址无效。")?;
    if target.origin() != origin.origin() {
        return Err("本机服务配置已变化，未打开旧通知对应的会话。".into());
    }
    let view = app.get_webview("dsh").ok_or("DSH 工作窗口尚未就绪。")?;
    let current = view.url().map_err(|_| "无法验证 DSH 工作窗口。")?;
    if current.origin() != origin.origin() {
        return Err("DSH 工作窗口来源不匹配，未打开通知会话。".into());
    }
    // For the root GUI keep path/query unchanged: only its fragment changes, so the
    // existing document, draft state and running interactions survive the navigation.
    let mut destination = if current.path() == "/" {
        current
    } else {
        origin
    };
    destination.set_fragment(target.fragment());
    for label in ["launcher", "dsh"] {
        if let Some(window) = app.get_window(label) {
            super::settings_page::restore_in(&window)?;
        }
    }
    if controller.exiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    view.navigate(destination)
        .map_err(|_| "无法打开通知对应的会话。")?;
    super::show_dsh(app);
    let _ = view.set_focus();
    if let Some(launcher) = app.get_window("launcher") {
        let _ = launcher.hide();
    }
    Ok(())
}

pub(super) fn wake(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<Notifications>>() {
        state.wake.notify_all();
    }
}
pub(super) fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<Notifications>>() {
        state.toasts.shutdown();
    }
}

pub(super) fn start(app: tauri::AppHandle, controller: Arc<Controller>, state: Arc<Notifications>) {
    thread::spawn(move || {
        let mut tracker = CursorTracker::new(now_ms());
        let mut attention = AttentionTracker::new();
        let mut generation = None;
        loop {
            if controller.exiting.load(Ordering::SeqCst) {
                break;
            }
            let channels = state.gate(&app);
            let epoch = channels.system_epoch;
            if !channels.continuous(generation) {
                tracker.reset(now_ms());
                // Rebase reads, but retain consumed questions across toast/bubble switches.
                attention.disconnected();
            }
            generation = Some(channels);
            if !channels.active() {
                state.wait(epoch);
                continue;
            }
            if controller.snapshot().state != "ready" {
                tracker.reset(now_ms());
                attention.disconnected();
                state.status(
                    &app,
                    epoch,
                    "connecting",
                    "等待本机 DSH 服务就绪；不会为通知自动启动服务。",
                );
                state.wait(epoch);
                continue;
            }
            let result = (|| -> Result<(), String> {
                let backend = controller.backend()?;
                let rpc = client(&app, &backend.config.origin())?;
                let list = rpc.list()?;
                if !state.current(&app, channels) {
                    return Ok(());
                }
                // Questions keep the Agent running, and can be nested inside run_code.
                // Observe their durable starts/results without joining the answerer stream.
                let waiting = attention.poll(&list, |session_id, cursor| {
                    if !state.current(&app, channels) || controller.exiting.load(Ordering::SeqCst) {
                        return Err("通知检测已取消。".into());
                    }
                    rpc.page(session_id, cursor)
                })?;
                for notice in waiting {
                    let body = task_notice_body(
                        &list,
                        &notice.session_id,
                        "任务正在等待你选择、回答问题或确认计划，请打开 DSH 继续。",
                    );
                    let target = notification_session_url(
                        backend.config.port,
                        &notice.session_id,
                        CLICK_SEQUENCE.fetch_add(1, Ordering::Relaxed),
                    )?;
                    deliver(
                        &app,
                        &controller,
                        &state,
                        epoch,
                        channels,
                        target,
                        "DSH · 需要你回答",
                        &body,
                        BubbleKind::Waiting,
                        &format!("waiting:{}:{}", notice.session_id, notice.call_id),
                    );
                }
                let requests = tracker.scan(&list)?;
                for request in requests {
                    if !state.current(&app, channels) || controller.exiting.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    let page = rpc.page(&request.session_id, request.cursor)?;
                    // A completed read is acknowledged even while the window is
                    // foreground: hiding it later must not replay this result.
                    let notice = tracker.consume(&request, &page)?;
                    if let Some(notice) = notice {
                        let (title, body) = match notice.kind {
                            NoticeKind::Completed => (
                                "DSH · 本轮执行已结束",
                                "打开 DSH 查看结果。本轮结束不代表整个长任务目标已完成。",
                            ),
                            NoticeKind::Failed => ("DSH · 本轮执行失败", "打开 DSH 查看错误详情。"),
                        };
                        let body = task_notice_body(&list, &notice.session_id, body);
                        let target = notification_session_url(
                            backend.config.port,
                            &notice.session_id,
                            CLICK_SEQUENCE.fetch_add(1, Ordering::Relaxed),
                        )?;
                        let kind = match notice.kind {
                            NoticeKind::Completed => BubbleKind::Completed,
                            NoticeKind::Failed => BubbleKind::Failed,
                        };
                        let key = format!(
                            "turn:{}:{:?}:{}",
                            notice.session_id, notice.kind, notice.seq
                        );
                        deliver(
                            &app,
                            &controller,
                            &state,
                            epoch,
                            channels,
                            target,
                            title,
                            &body,
                            kind,
                            &key,
                        );
                    }
                }
                Ok(())
            })();
            match result {
                Ok(()) => state.status(
                    &app,
                    epoch,
                    "listening",
                    "正在检查执行结果与待答问题（约每 3 秒）；前台静默，显示会话名称，不显示正文。",
                ),
                Err(message) => {
                    // Reconnect establishes a fresh baseline, never replays old turns.
                    tracker.reset(now_ms());
                    attention.disconnected();
                    state.status(
                        &app,
                        epoch,
                        "error",
                        &format!("{message} 将自动重试；重新连接后不补发历史执行结果。"),
                    );
                }
            }
            state.wait(epoch);
        }
    });
}
