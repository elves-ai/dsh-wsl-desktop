//! Trusted pet/settings asynchronous speech facade. No GUI thread blocking HTTP.
use super::assistant::assert_assistant;
use crate::assistant_speech::{
    pet_caller, SpeechBridge, SpeechRequest, SpeechTimings, PET_VIEW, VOICE_ID,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{sync::Arc, time::Instant};
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
    timings: SpeechTimings,
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
    previous_request_id: Option<String>,
) -> Result<SpeechReply, String> {
    let total_started = Instant::now();
    allowed(&view, test)?;
    let app = view.app_handle().clone();
    let state = app.state::<Arc<SpeechBridge>>().inner().clone();
    let manager = app
        .state::<Arc<super::speech_settings::SpeechControls>>()
        .manager()?;
    let (ticket, superseded) = state.begin_after(&request, previous_request_id.as_deref())?;
    publish_stops(&app, &superseded, Some(view.label()));
    for id in &superseded {
        let _ = manager.cancel_request(id);
    }
    let worker = state.clone();
    let worker_ticket = ticket.clone();
    let request_id = request.request_id.clone();
    let (wav_base64, readiness, synthesis, encode) =
        tauri::async_runtime::spawn_blocking(move || {
            for id in &superseded {
                let _ = SpeechBridge::cancel_remote(id);
            }
            if !worker.is_current(&worker_ticket) {
                return Err(SpeechBridge::cancelled_error());
            }
            let readiness_started = Instant::now();
            manager.ensure_ready(&request.request_id)?;
            let readiness = readiness_started.elapsed();
            if !worker.is_current(&worker_ticket) {
                let _ = manager.cancel_request(&request.request_id);
                return Err(SpeechBridge::cancelled_error());
            }
            // Includes bridge slot queueing, health, HTTP and WAV validation.
            let synthesis_started = Instant::now();
            let wav = worker.synthesize(&worker_ticket, &request, &superseded)?;
            let synthesis = synthesis_started.elapsed();
            let encode_started = Instant::now();
            let wav_base64 = STANDARD.encode(wav);
            let encode = encode_started.elapsed();
            Ok((wav_base64, readiness, synthesis, encode))
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
        timings: SpeechTimings::from_durations(
            readiness,
            synthesis,
            encode,
            total_started.elapsed(),
        ),
    })
}
#[tauri::command]
pub(super) async fn assistant_speech_synthesize(
    view: Webview,
    _state: tauri::State<'_, Arc<SpeechBridge>>,
    request: SpeechRequest,
    previous_request_id: Option<String>,
) -> Result<SpeechReply, String> {
    assert_pet(&view)?;
    generate(view, request, false, previous_request_id).await
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
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn reply_preserves_existing_fields_and_adds_nested_timings() {
        let reply = SpeechReply {
            request_id: "timing-1".into(),
            wav_base64: "UklGRg==".into(),
            voice_id: VOICE_ID,
            timings: SpeechTimings::from_durations(
                Duration::from_millis(1),
                Duration::from_millis(2),
                Duration::ZERO,
                Duration::from_millis(4),
            ),
        };
        assert_eq!(
            serde_json::to_value(reply).unwrap(),
            serde_json::json!({
                "request_id": "timing-1",
                "wav_base64": "UklGRg==",
                "voice_id": VOICE_ID,
                "timings": {
                    "readiness_ms": 1.0,
                    "synthesis_ms": 2.0,
                    "encode_ms": 0.0,
                    "total_ms": 4.0,
                },
            })
        );
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
