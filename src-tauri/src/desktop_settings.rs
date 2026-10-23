//! Trusted local settings pages; the remote workspace stays alive without native IPC.
use super::{assert_local, local_content, settings_section, titlebar};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Mutex,
};
use tauri::{
    webview::WebviewBuilder, Emitter, EventTarget, Manager, Rect, Webview, WebviewUrl, Window,
};

#[derive(Clone, Copy)]
struct Page {
    ready: bool,
    section: &'static str,
}
// Only workers take this lock. Native UI callbacks read atomics, never this mutex.
static NAVIGATION: Mutex<[Page; 2]> = Mutex::new(
    [Page {
        ready: false,
        section: "environment",
    }; 2],
);
static ACTIVE: AtomicU8 = AtomicU8::new(0);
static REQUESTED: AtomicU8 = AtomicU8::new(0);

pub(super) fn label(host: &str) -> Option<&'static str> {
    match host {
        "launcher" => Some("launcher-settings"),
        "dsh" => Some("dsh-settings"),
        _ => None,
    }
}
fn index(host: &str) -> usize {
    usize::from(host == "dsh")
}
fn bit(host: &str) -> u8 {
    match host {
        "launcher" => 1,
        "dsh" => 2,
        _ => 0,
    }
}
pub(super) fn is_active(host: &str) -> bool {
    ACTIVE.load(Ordering::SeqCst) & bit(host) != 0
}
pub(super) fn is_open(host: &str) -> bool {
    (ACTIVE.load(Ordering::SeqCst) | REQUESTED.load(Ordering::SeqCst)) & bit(host) != 0
}

fn assert_page(view: &Webview) -> Result<Window, String> {
    assert_local(view)?;
    let window = view.window();
    if label(window.label()) != Some(view.label()) {
        return Err("此页面无权切换设置页面。".into());
    }
    Ok(window)
}
fn reveal(window: &Window, page: &Webview) -> Result<(), String> {
    let content = window
        .app_handle()
        .get_webview(window.label())
        .ok_or("原页面不可用。")?;
    let (position, size) = titlebar::content_geometry(window).map_err(|_| "无法读取页面尺寸。")?;
    let result = page
        .set_bounds(Rect {
            position: position.into(),
            size: size.into(),
        })
        .and_then(|_| page.show())
        .and_then(|_| content.hide());
    if result.is_err() {
        let _ = page.hide();
        let _ = content.show();
        ACTIVE.fetch_and(!bit(window.label()), Ordering::SeqCst);
        REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
        return Err("无法显示设置页面。".into());
    }
    ACTIVE.fetch_or(bit(window.label()), Ordering::SeqCst);
    REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
    // Do not show/unminimize the parent here: a late ready reply must not undo closing to tray.
    if window.is_focused().unwrap_or(false) {
        let _ = page.set_focus();
    }
    Ok(())
}

/// Explicit menu/IPC requests use the caller's verified host and a fixed section.
pub(super) fn show_in(window: &Window, section: &str) -> Result<(), String> {
    let page_label = label(window.label()).ok_or("不支持的设置页面窗口。")?;
    if !settings_section(section) {
        return Err("不支持的设置页面。".into());
    }
    let mut pages = NAVIGATION.lock().unwrap_or_else(|e| e.into_inner());
    let state = &mut pages[index(window.label())];
    state.section = match section {
        "notifications" => "notifications",
        "updates" => "updates",
        "logs" => "logs",
        _ => "environment",
    };
    let app = window.app_handle();
    REQUESTED.fetch_or(bit(window.label()), Ordering::SeqCst);
    let result = (|| {
        let page = if let Some(page) = app.get_webview(page_label) {
            if page.window().label() != window.label() {
                return Err("设置页面归属无效。".into());
            }
            page
        } else {
            state.ready = false;
            let (position, size) =
                titlebar::content_geometry(window).map_err(|_| "无法读取页面尺寸。")?;
            let created = window.add_child(
                WebviewBuilder::new(
                    page_label,
                    WebviewUrl::App(format!("index.html?view=settings&section={section}").into()),
                )
                .focused(false)
                .on_navigation(move |target| local_content(target, page_label))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
                position,
                size,
            );
            let page = match created {
                Ok(page) => page,
                Err(_) => {
                    REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
                    return Err("无法创建设置页面，请检查 WebView2 Runtime。".into());
                }
            };
            // Keep the original visible until the local document subscribes and reports ready.
            if page.hide().is_err() {
                let _ = page.close();
                REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
                return Err("无法准备设置页面。".into());
            }
            page
        };
        if state.ready {
            if app
                .emit_to(
                    EventTarget::webview(page_label),
                    "launcher-show-settings",
                    state.section,
                )
                .is_err()
            {
                REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
                return Err("无法切换设置页面。".into());
            }
            reveal(window, &page)?;
        }
        Ok(())
    })();
    if result.is_err() {
        REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
    }
    result
}

/// Tray shortcuts reuse an existing host; no standalone settings window is created.
pub(super) fn show(app: &tauri::AppHandle, section: &str) -> Result<(), String> {
    let window = ["dsh", "launcher"]
        .into_iter()
        .filter_map(|label| app.get_window(label))
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_window("dsh"))
        .or_else(|| app.get_window("launcher"))
        .ok_or("应用窗口不可用。")?;
    window.show().map_err(|_| "无法显示应用窗口。")?;
    window.unminimize().map_err(|_| "无法还原应用窗口。")?;
    window.set_focus().map_err(|_| "无法激活应用窗口。")?;
    show_in(&window, section)
}

#[tauri::command]
pub(super) async fn settings_page_ready(view: Webview) -> Result<String, String> {
    let window = assert_page(&view)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut pages = NAVIGATION.lock().unwrap_or_else(|e| e.into_inner());
        let state = &mut pages[index(window.label())];
        state.ready = true;
        if REQUESTED.load(Ordering::SeqCst) & bit(window.label()) != 0 {
            if let Err(error) = reveal(&window, &view) {
                REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
                return Err(error);
            }
        }
        Ok(state.section.to_owned())
    })
    .await
    .map_err(|_| "设置页面线程异常结束。".to_owned())?
}

#[tauri::command]
pub(super) async fn return_from_settings(view: Webview) -> Result<(), String> {
    let window = assert_page(&view)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = NAVIGATION.lock().unwrap_or_else(|e| e.into_inner());
        let app = window.app_handle();
        let content = app.get_webview(window.label()).ok_or("原页面不可用。")?;
        // Restore existing content: no navigation, browser history, or service operation.
        content.show().map_err(|_| "无法恢复原页面。")?;
        view.hide().map_err(|_| "无法关闭设置页面。")?;
        ACTIVE.fetch_and(!bit(window.label()), Ordering::SeqCst);
        REQUESTED.fetch_and(!bit(window.label()), Ordering::SeqCst);
        let _ = content.set_focus();
        // Startup can complete while its settings page is open; reveal the prepared workspace.
        if window.label() == "launcher"
            && app.get_window("dsh").is_some()
            && app
                .state::<std::sync::Arc<super::Controller>>()
                .snapshot()
                .state
                == "ready"
        {
            super::show_dsh(app);
            let _ = window.hide();
        }
        Ok(())
    })
    .await
    .map_err(|_| "返回页面线程异常结束。".to_owned())?
}
