//! A bundled, isolated titlebar webview. The DSH page retains no native capabilities.
use serde::{Deserialize, Serialize};
use tauri::{
    webview::WebviewBuilder, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager,
    PhysicalPosition, PhysicalSize, Rect, Webview, WebviewUrl, Window, WindowEvent,
};
use url::Url;

const HEIGHT: f64 = 32.0;

#[derive(Serialize, Clone)]
pub(super) struct State {
    maximized: bool,
    focused: bool,
    title: String,
}
fn state(window: &Window) -> tauri::Result<State> {
    Ok(State {
        maximized: window.is_maximized()?,
        focused: window.is_focused()?,
        title: window.title()?,
    })
}

fn local_titlebar(url: &Url) -> bool {
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    let dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    (packaged || dev)
        && url.path() == "/titlebar.html"
        && url.query().is_none()
        && url.fragment().is_none()
}

/// Bind the command to its invoking view's own parent; never accept a window label.
fn assert_titlebar(view: &Webview) -> Result<Window, String> {
    let window = view.window();
    let pair = (view.label(), window.label());
    if !matches!(
        pair,
        ("launcher-titlebar", "launcher") | ("dsh-titlebar", "dsh")
    ) || !view.url().ok().is_some_and(|url| local_titlebar(&url))
    {
        return Err("此页面无权操作窗口标题栏。".into());
    }
    Ok(window)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    State,
    Minimize,
    Maximize,
    Close,
    Drag,
}

#[tauri::command]
pub(super) async fn titlebar_action(view: Webview, action: Action) -> Result<State, String> {
    let window = assert_titlebar(&view)?;
    let result = match action {
        Action::State => Ok(()),
        Action::Minimize => window.minimize(),
        Action::Maximize => {
            if window.is_maximized().map_err(|_| "无法读取窗口状态。")? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // close() raises CloseRequested: the shared handler hides to tray, never stops WSL.
        Action::Close => window.close(),
        Action::Drag => window.start_dragging(),
    };
    result.map_err(|_| "窗口操作未完成，请重试。")?;
    state(&window).map_err(|_| "无法读取窗口状态。".into())
}

#[tauri::command]
pub(super) async fn open_titlebar_settings(view: Webview) -> Result<(), String> {
    let window = assert_titlebar(&view)?;
    // Child creation runs off the UI thread; only this verified parent can be selected.
    tauri::async_runtime::spawn_blocking(move || {
        super::settings_page::show_in(&window, "environment")
    })
    .await
    .map_err(|_| "设置页面线程异常结束。".to_owned())?
}

#[tauri::command]
pub(super) async fn open_titlebar_updates(view: Webview) -> Result<(), String> {
    let window = assert_titlebar(&view)?;
    tauri::async_runtime::spawn_blocking(move || super::settings_page::show_in(&window, "updates"))
        .await
        .map_err(|_| "更新页面线程异常结束。".to_owned())?
}

#[tauri::command]
pub(super) fn get_titlebar_update_state(
    view: Webview,
    state: tauri::State<'_, std::sync::Arc<super::updates::Updates>>,
) -> Result<super::updates::UpdateNotice, String> {
    assert_titlebar(&view)?;
    Ok(state.titlebar_notice())
}

pub(super) fn content_geometry(
    window: &Window,
) -> tauri::Result<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let size = window.inner_size()?;
    let top = (HEIGHT * window.scale_factor()?).round() as u32;
    Ok((
        PhysicalPosition::new(0, top as i32),
        PhysicalSize::new(size.width, size.height.saturating_sub(top)),
    ))
}

pub(super) fn attach(window: &Window) -> tauri::Result<()> {
    let width = window.inner_size()?.width as f64 / window.scale_factor()?;
    let label = format!("{}-titlebar", window.label());
    window.add_child(
        WebviewBuilder::new(&label, WebviewUrl::App("titlebar.html".into()))
            .focused(false)
            .on_navigation(local_titlebar)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width, HEIGHT),
    )?;
    layout(window)
}

fn layout(window: &Window) -> tauri::Result<()> {
    let app = window.app_handle();
    if let (Some(content), Some(titlebar)) = (
        app.get_webview(window.label()),
        app.get_webview(&format!("{}-titlebar", window.label())),
    ) {
        let size = window.inner_size()?;
        if size.width == 0 || size.height == 0 || window.is_minimized()? {
            return Ok(());
        }
        let (position, content_size) = content_geometry(window)?;
        content.set_bounds(Rect {
            position: position.into(),
            size: content_size.into(),
        })?;
        if let Some(settings) =
            super::settings_page::label(window.label()).and_then(|label| app.get_webview(label))
        {
            if settings.window().label() == window.label() {
                settings.set_bounds(Rect {
                    position: position.into(),
                    size: content_size.into(),
                })?;
            }
        }
        titlebar.set_bounds(Rect {
            position: PhysicalPosition::new(0, 0).into(),
            size: PhysicalSize::new(size.width, position.y as u32).into(),
        })?;
    }
    Ok(())
}

pub(super) fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(window.label(), "launcher" | "dsh") {
        return;
    }
    if matches!(
        event,
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
    ) {
        let _ = layout(window);
    }
    if matches!(
        event,
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Focused(_)
    ) {
        if let Ok(state) = state(window) {
            let _ = window.app_handle().emit_to(
                EventTarget::webview(format!("{}-titlebar", window.label())),
                "titlebar-state",
                state,
            );
        }
    }
}
