//! Trusted pet/settings asynchronous speech facade. No GUI thread blocking HTTP.
use super::assistant::assert_assistant;
use crate::assistant_speech::{pet_caller, SpeechBridge, SpeechRequest, PET_VIEW, VOICE_ID};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, Manager, Webview, Window, WindowEvent};

pub(super) fn assert_pet(view: &Webview) -> Result<(), String> {
    assert_assistant(view)?;
    let url = view.url().map_err(|_| "无法验证助手页面。")?;
    if !pet_caller(view.label(), view.window().label(), &url) {
        return Err("此页面无权使用桌面宠物语音。".into());
    }
    Ok(())
}
#[derive(Serialize)]
pub(super) struct SpeechReply {
    request_id: String,
    wav_base64: String,
    voice_id: &'static str,
}
fn allowed(view: &Webview, test: bool) -> Result<(), String> {
    if test {
        super::speech_settings::assert_page(view, true)
    } else {
        assert_pet(view)?;
        if !view.window().is_visible().unwrap_or(false) {
            return Err("桌面宠物已隐藏，语音请求已停止。".into());
        }
        Ok(())
    }
}
fn publish_stops(app: &tauri::AppHandle, ids: &[String], except: Option<&str>) {
    for id in ids {
        for label in [PET_VIEW, "launcher-settings", "dsh-settings"] {
            if except != Some(label) {
                let _ = app.emit_to(
                    label,
                    "launcher-speech-stop",
                    serde_json::json!({"request_id":id}),
                );
            }
        }
    }
}
pub(super) async fn generate(
    view: Webview,
    request: SpeechRequest,
    test: bool,
) -> Result<SpeechReply, String> {
    allowed(&view, test)?;
    let app = view.app_handle().clone();
    let state = app.state::<Arc<SpeechBridge>>().inner().clone();
    let manager = app
        .state::<Arc<super::speech_settings::SpeechControls>>()
        .manager()?;
    let (ticket, superseded) = state.begin(&request)?;
    publish_stops(&app, &superseded, Some(view.label()));
    for id in &superseded {
        let _ = manager.cancel_request(id);
    }
    let worker = state.clone();
    let worker_ticket = ticket.clone();
    let request_id = request.request_id.clone();
    let wav_base64 = tauri::async_runtime::spawn_blocking(move || {
        for id in &superseded {
            let _ = SpeechBridge::cancel_remote(id);
        }
        if !worker.is_current(&worker_ticket) {
            return Err(SpeechBridge::cancelled_error());
        }
        manager.ensure_ready(&request.request_id)?;
        if !worker.is_current(&worker_ticket) {
            let _ = manager.cancel_request(&request.request_id);
            return Err(SpeechBridge::cancelled_error());
        }
        worker
            .synthesize(&worker_ticket, &request, &superseded)
            .map(|wav| STANDARD.encode(wav))
    })
    .await
    .map_err(|_| "本机语音任务中断，请重试。".to_string())??;
    allowed(&view, test)?;
    if !state.is_current(&ticket) {
        return Err(SpeechBridge::cancelled_error());
    }
    Ok(SpeechReply {
        request_id,
        wav_base64,
        voice_id: VOICE_ID,
    })
}
#[tauri::command]
pub(super) async fn assistant_speech_synthesize(
    view: Webview,
    _state: tauri::State<'_, Arc<SpeechBridge>>,
    request: SpeechRequest,
) -> Result<SpeechReply, String> {
    assert_pet(&view)?;
    generate(view, request, false).await
}
pub(super) async fn cancel_for_view(view: &Webview, request_id: String) -> Result<(), String> {
    let app = view.app_handle();
    let state = app.state::<Arc<SpeechBridge>>();
    state.cancel(&request_id)?;
    let manager = app
        .state::<Arc<super::speech_settings::SpeechControls>>()
        .manager()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = manager.cancel_request(&request_id);
        SpeechBridge::cancel_remote(&request_id)
    })
    .await
    .map_err(|_| "本机语音取消任务中断。".to_string())?
}
#[tauri::command]
pub(super) async fn assistant_speech_cancel(
    view: Webview,
    _state: tauri::State<'_, Arc<SpeechBridge>>,
    request_id: String,
) -> Result<(), String> {
    assert_pet(&view)?;
    cancel_for_view(&view, request_id).await
}
pub(super) fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<SpeechBridge>>() {
        let ids = state.invalidate();
        publish_stops(app, &ids, None);
        let manager = app
            .try_state::<Arc<super::speech_settings::SpeechControls>>()
            .and_then(|s| s.manager().ok());
        if !ids.is_empty() {
            tauri::async_runtime::spawn_blocking(move || {
                for id in ids {
                    if let Some(m) = &manager {
                        let _ = m.cancel_request(&id);
                    }
                    let _ = SpeechBridge::cancel_remote(&id);
                }
            });
        }
    }
}
pub(super) fn on_window_event(window: &Window, event: &WindowEvent) {
    if matches!(
        event,
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
    ) {
        if let Some(label) = super::settings_page::label(window.label()) {
            super::speech_settings::cancel_tests(window.app_handle(), label);
        }
    }
    if window.label() == PET_VIEW
        && matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        )
    {
        stop(window.app_handle());
    }
}
