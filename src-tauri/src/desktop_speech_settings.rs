//! Narrow trusted settings facade; runtime paths never become JS commands.
use super::{assert_local, settings_page, Controller};
use crate::{
    speech_settings::{
        Manager as SpeechManager, PreferencesPatch, SpeechAction, SpeechConfig, SpeechPreferences,
        SpeechSnapshot,
    },
    speech_wsl::WslSpeechRuntime,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, Webview};

pub(super) struct SpeechControls {
    manager: Result<Arc<SpeechManager>, String>,
    tests: Mutex<HashMap<String, String>>,
}
impl SpeechControls {
    pub(super) fn new(
        app: tauri::AppHandle,
        controller: Arc<Controller>,
        directory: PathBuf,
    ) -> Self {
        let provider = Arc::new(move || {
            controller
                .backend
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .ok_or_else(|| "请先完成主程序的 WSL 环境配置。".to_string())
        });
        let result = WslSpeechRuntime::new(provider).and_then(|runtime| {
            let listener = Arc::new(move |snapshot: SpeechSnapshot| {
                for label in ["launcher-settings", "dsh-settings"] {
                    let _ = app.emit_to(label, "launcher-speech-state", &snapshot);
                }
            });
            SpeechManager::new(
                directory.join("speech-settings.json"),
                Arc::new(runtime),
                Some(listener),
            )
            .map(Arc::new)
        });
        Self {
            manager: result,
            tests: Mutex::new(HashMap::new()),
        }
    }
    pub(super) fn manager(&self) -> Result<Arc<SpeechManager>, String> {
        self.manager.clone()
    }
}
pub(super) fn assert_page(view: &Webview, active: bool) -> Result<(), String> {
    assert_local(view)?;
    if settings_page::label(view.window().label()) != Some(view.label()) {
        return Err("此页面无权管理语音设置。".into());
    }
    if active
        && (!settings_page::is_active(view.window().label())
            || !view.window().is_visible().unwrap_or(false))
    {
        return Err("语音设置页面已关闭，请重新打开。".into());
    }
    Ok(())
}
fn assert_preferences(view: &Webview) -> Result<(), String> {
    if view.label() == crate::assistant_speech::PET_VIEW {
        super::speech::assert_pet(view)
    } else {
        assert_page(view, false)
    }
}
fn controls(app: &tauri::AppHandle) -> Result<Arc<SpeechManager>, String> {
    app.try_state::<Arc<SpeechControls>>()
        .ok_or("语音设置尚未初始化。")?
        .manager()
}
fn publish_preferences(app: &tauri::AppHandle, p: &SpeechPreferences) {
    for label in ["launcher-settings", "dsh-settings", "assistant-pet"] {
        let _ = app.emit_to(label, "launcher-speech-preferences", p);
    }
}
#[tauri::command]
pub(super) fn get_speech_settings(view: Webview) -> Result<SpeechSnapshot, String> {
    assert_page(&view, false)?;
    Ok(controls(view.app_handle())?.get_snapshot())
}
#[tauri::command]
pub(super) fn save_speech_config(
    view: Webview,
    config: SpeechConfig,
) -> Result<SpeechSnapshot, String> {
    assert_page(&view, true)?;
    controls(view.app_handle())?.save_config(config)
}
#[tauri::command]
pub(super) fn speech_action(view: Webview, action: SpeechAction) -> Result<SpeechSnapshot, String> {
    assert_page(&view, true)?;
    if action == SpeechAction::Stop {
        super::speech::stop(view.app_handle());
    }
    controls(view.app_handle())?.action(action)
}
#[tauri::command]
pub(super) fn get_speech_preferences(view: Webview) -> Result<SpeechPreferences, String> {
    assert_preferences(&view)?;
    Ok(controls(view.app_handle())?.get_preferences())
}
#[tauri::command]
pub(super) fn set_speech_preferences(
    view: Webview,
    patch: PreferencesPatch,
) -> Result<SpeechPreferences, String> {
    assert_preferences(&view)?;
    let p = controls(view.app_handle())?.set_preferences(patch)?;
    publish_preferences(view.app_handle(), &p);
    Ok(p)
}
#[tauri::command]
pub(super) async fn test_speech(
    view: Webview,
    request_id: String,
) -> Result<super::speech::SpeechReply, String> {
    assert_page(&view, true)?;
    crate::assistant_speech::validate_id(&request_id)?;
    view.app_handle()
        .state::<Arc<SpeechControls>>()
        .tests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(view.label().into(), request_id.clone());
    super::speech::generate(
        view,
        crate::assistant_speech::SpeechRequest {
            request_id,
            text: "你好呀，今天也要一起加油哦！".into(),
        },
        true,
    )
    .await
}
#[tauri::command]
pub(super) async fn cancel_speech_test(view: Webview, request_id: String) -> Result<(), String> {
    assert_page(&view, false)?;
    super::speech::cancel_for_view(&view, request_id).await
}
/// Native Back/close safety net. Only this settings view's audition ID is stopped.
pub(super) fn cancel_tests(app: &tauri::AppHandle, label: &str) {
    let Some(state) = app.try_state::<Arc<SpeechControls>>() else {
        return;
    };
    let id = state
        .tests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
    if let Some(id) = id {
        if let Some(bridge) = app.try_state::<Arc<crate::assistant_speech::SpeechBridge>>() {
            let _ = bridge.cancel(&id);
        }
        let _ = app.emit_to(
            label,
            "launcher-speech-stop",
            serde_json::json!({"request_id":id}),
        );
        let manager = state.manager().ok();
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(manager) = manager {
                let _ = manager.cancel_request(&id);
            }
            let _ = crate::assistant_speech::SpeechBridge::cancel_remote(&id);
        });
    }
}
pub(super) fn shutdown(app: &tauri::AppHandle) {
    if let Ok(manager) = controls(app) {
        manager.shutdown();
    }
}
