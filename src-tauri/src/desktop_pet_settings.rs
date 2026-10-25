//! Shared native pet visibility and durable preferences. No DSH/service commands.
use super::{assert_local, assistant};
use crate::pet_settings::{
    PetPreferences, PetSettingsPatch, PetSettingsSnapshot, PreferencesStore, TitlebarPetState,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};
use tauri::{Emitter, EventTarget, Manager, Webview};

struct Data {
    preferences: PetPreferences,
    visible: bool,
    always_on_top: bool,
    bubble_epoch: u64,
    bubble_was_active: bool,
    revision: u64,
    error: Option<String>,
}
pub(super) struct PetControls {
    store: PreferencesStore,
    data: Mutex<Data>,
    operation: Mutex<()>,
}
impl PetControls {
    pub(super) fn new(directory: PathBuf) -> Self {
        let store = PreferencesStore::new(directory.join("pet-settings.json"));
        let (preferences, error) = match store.load() {
            Ok(p) => (p, None),
            Err(e) => (PetPreferences::default(), Some(e)),
        };
        Self {
            store,
            data: Mutex::new(Data {
                preferences,
                visible: false,
                always_on_top: true,
                bubble_epoch: 0,
                bubble_was_active: false,
                revision: 0,
                error,
            }),
            operation: Mutex::new(()),
        }
    }
    fn snapshot(&self) -> PetSettingsSnapshot {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        PetSettingsSnapshot {
            visible: data.visible,
            always_on_top: data.always_on_top,
            startup_visible: data.preferences.startup_visible,
            roaming_enabled: data.preferences.roaming_enabled,
            bubble_notifications: data.preferences.bubble_notifications,
            revision: data.revision,
            message: data.error.clone().unwrap_or_default(),
        }
    }
    fn bubble_gate(&self) -> (bool, u64) {
        let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        let active = data.visible && data.preferences.bubble_notifications && data.error.is_none();
        if active != data.bubble_was_active {
            data.bubble_was_active = active;
            data.bubble_epoch = data.bubble_epoch.saturating_add(1);
        }
        (active, data.bubble_epoch)
    }
    fn notice(&self) -> TitlebarPetState {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        TitlebarPetState {
            visible: data.visible,
            revision: data.revision,
        }
    }
    fn publish(&self, app: &tauri::AppHandle) {
        let (active, _) = self.bubble_gate();
        if !active {
            super::pet_notifications::clear(app);
        }
        super::notifications::wake(app);
        super::pet_interactions::wake(app);
        let snapshot = self.snapshot();
        let notice = TitlebarPetState {
            visible: snapshot.visible,
            revision: snapshot.revision,
        };
        let _ = app.emit_to(
            EventTarget::webview("assistant-pet"),
            "pet-visibility",
            &notice,
        );
        for label in ["launcher-settings", "dsh-settings", "assistant-pet"] {
            let _ = app.emit_to(EventTarget::webview(label), "pet-settings-state", &snapshot);
        }
        for label in ["launcher-titlebar", "dsh-titlebar"] {
            let _ = app.emit_to(EventTarget::webview(label), "titlebar-pet-state", &notice);
        }
    }
    fn actual_visible(app: &tauri::AppHandle) -> Result<bool, String> {
        let Some(window) = app.get_window("assistant-pet") else {
            return Ok(false);
        };
        Ok(window.is_visible().map_err(|_| "无法读取宠物显隐状态。")?
            && !window
                .is_minimized()
                .map_err(|_| "无法读取宠物窗口状态。")?)
    }
    fn reconcile(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let visible = Self::actual_visible(app)?;
        let always_on_top = match app.get_window("assistant-pet") {
            Some(window) => window
                .is_always_on_top()
                .map_err(|_| "无法读取宠物置顶状态。")?,
            None => true,
        };
        let changed = {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            if data.visible == visible && data.always_on_top == always_on_top {
                false
            } else {
                data.visible = visible;
                data.always_on_top = always_on_top;
                data.revision = data.revision.saturating_add(1);
                true
            }
        };
        if changed {
            self.publish(app);
        }
        Ok(())
    }
    fn reload(&self, app: &tauri::AppHandle) -> Result<PetSettingsSnapshot, String> {
        let _lease = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.store.load();
        {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            match loaded {
                Ok(p) => {
                    if data.preferences != p || data.error.is_some() {
                        data.preferences = p;
                        data.error = None;
                        data.revision = data.revision.saturating_add(1);
                    }
                }
                Err(error) => {
                    if data.error.as_deref() != Some(&error) {
                        data.error = Some(error);
                        data.revision = data.revision.saturating_add(1);
                    }
                }
            }
        }
        self.reconcile(app)?;
        self.publish(app);
        Ok(self.snapshot())
    }
    fn set_preferences(
        &self,
        app: &tauri::AppHandle,
        patch: PetSettingsPatch,
    ) -> Result<PetSettingsSnapshot, String> {
        let _lease = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        // Merge against the durable latest state, not a stale form from another window.
        let mut next = self.store.load()?;
        if next.apply_patch(&patch) {
            self.store.save(&next)?;
        }
        {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            if data.preferences != next || data.error.is_some() {
                data.preferences = next;
                data.error = None;
                data.revision = data.revision.saturating_add(1);
            }
        }
        self.reconcile(app)?;
        self.publish(app);
        Ok(self.snapshot())
    }
    fn set_visible_locked(
        &self,
        app: &tauri::AppHandle,
        visible: bool,
    ) -> Result<PetSettingsSnapshot, String> {
        let result = (|| -> Result<(), String> {
            if visible {
                assistant::reveal_pet(app)?;
            } else {
                // Release typing before hiding, rather than waiting for broker wake.
                // Both this policy update and hide are ordered on the native UI thread.
                if let Some(interactions) =
                    app.try_state::<Arc<super::pet_interactions::PetInteractions>>()
                {
                    interactions.prepare_hide(app)?;
                }
                // Cancel native synthesis even if a hidden WebView cannot process JS immediately.
                super::speech::stop(app);
                if let Some(window) = app.get_window("assistant-pet") {
                    window.hide().map_err(|_| "无法隐藏桌面宠物。")?;
                }
                if let Some(chat) = app.get_window("assistant-chat") {
                    chat.hide()
                        .map_err(|_| "宠物已隐藏，但对话面板未能隐藏。")?;
                }
            }
            Ok(())
        })();
        // Even if a secondary operation failed, report the actual pet window state.
        self.reconcile(app)?;
        let snapshot = self.snapshot();
        self.publish(app);
        result?;
        Ok(snapshot)
    }
    fn set_topmost(
        &self,
        app: &tauri::AppHandle,
        always_on_top: bool,
    ) -> Result<PetSettingsSnapshot, String> {
        let _lease = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        let window = app
            .get_window("assistant-pet")
            .ok_or("桌面宠物窗口尚未创建。")?;
        let result = window
            .set_always_on_top(always_on_top)
            .map_err(|_| "无法切换宠物置顶状态。".to_owned());
        // Never publish the desired value as success: read back actual native state.
        self.reconcile(app)?;
        self.publish(app);
        result?;
        Ok(self.snapshot())
    }
    pub(super) fn set_visible(
        &self,
        app: &tauri::AppHandle,
        visible: bool,
    ) -> Result<PetSettingsSnapshot, String> {
        let _lease = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        self.set_visible_locked(app, visible)
    }
    pub(super) fn toggle(&self, app: &tauri::AppHandle) -> Result<TitlebarPetState, String> {
        let _lease = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        let target = !Self::actual_visible(app)?;
        self.set_visible_locked(app, target)?;
        Ok(self.notice())
    }
    pub(super) fn read_notice(&self, app: &tauri::AppHandle) -> Result<TitlebarPetState, String> {
        self.reconcile(app)?;
        Ok(self.notice())
    }
}

pub(super) fn assert_settings(view: &Webview) -> Result<(), String> {
    assert_local(view)?;
    if !matches!(view.label(), "launcher-settings" | "dsh-settings") {
        return Err("请在设置页中操作桌面宠物。".into());
    }
    Ok(())
}
#[tauri::command]
pub(super) async fn get_pet_settings(
    view: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<PetControls>>,
) -> Result<PetSettingsSnapshot, String> {
    assert_settings(&view)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.reload(&app))
        .await
        .map_err(|_| "读取宠物设置的线程异常结束。".to_owned())?
}
#[tauri::command]
pub(super) async fn set_pet_settings(
    view: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<PetControls>>,
    patch: PetSettingsPatch,
) -> Result<PetSettingsSnapshot, String> {
    assert_settings(&view)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.set_preferences(&app, patch))
        .await
        .map_err(|_| "保存宠物设置的线程异常结束。".to_owned())?
}
#[tauri::command]
pub(super) async fn set_pet_visibility(
    view: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<PetControls>>,
    visible: bool,
) -> Result<PetSettingsSnapshot, String> {
    assert_settings(&view)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.set_visible(&app, visible))
        .await
        .map_err(|_| "切换宠物显隐的线程异常结束。".to_owned())?
}
#[tauri::command]
pub(super) async fn set_pet_topmost(
    view: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<PetControls>>,
    always_on_top: bool,
) -> Result<PetSettingsSnapshot, String> {
    assistant::assert_assistant(&view)?;
    if view.label() != "assistant-pet" {
        return Err("只有桌宠页面可以修改宠物置顶状态。".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.set_topmost(&app, always_on_top))
        .await
        .map_err(|_| "切换宠物置顶的线程异常结束。".to_owned())?
}
#[tauri::command]
pub(super) fn get_pet_preferences(
    view: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<PetControls>>,
) -> Result<PetSettingsSnapshot, String> {
    assistant::assert_assistant(&view)?;
    if view.label() != "assistant-pet" {
        return Err("只有桌宠页面可以读取宠物偏好。".into());
    }
    state.reconcile(&app)?;
    Ok(state.snapshot())
}
pub(super) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "assistant-pet" {
        return;
    }
    let Some(state) = window.app_handle().try_state::<Arc<PetControls>>() else {
        return;
    };
    if matches!(event, tauri::WindowEvent::Destroyed) {
        {
            let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            if data.visible {
                data.visible = false;
                data.revision = data.revision.saturating_add(1);
            }
        }
        state.publish(window.app_handle());
    } else if matches!(
        event,
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)
    ) {
        let _ = state.reconcile(window.app_handle());
    }
}
pub(super) fn bubble_gate(app: &tauri::AppHandle) -> (bool, u64) {
    app.try_state::<Arc<PetControls>>()
        .map(|state| state.bubble_gate())
        .unwrap_or((false, 0))
}
pub(super) fn pet_visible(app: &tauri::AppHandle) -> bool {
    PetControls::actual_visible(app).unwrap_or_else(|_| {
        app.try_state::<Arc<PetControls>>()
            .map(|state| state.snapshot().visible)
            .unwrap_or(false)
    })
}
pub(super) fn interaction_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<Arc<PetControls>>().is_some_and(|state| {
        let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
        data.preferences.bubble_notifications && data.error.is_none()
    })
}
pub(super) fn bubble_active(app: &tauri::AppHandle) -> bool {
    bubble_gate(app).0 && pet_visible(app)
}
pub(super) fn restore(app: tauri::AppHandle) {
    thread::spawn(move || {
        let state = app.state::<Arc<PetControls>>();
        let _lease = state.operation.lock().unwrap_or_else(|e| e.into_inner());
        let startup = {
            let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            data.preferences.startup_visible && data.error.is_none() && data.revision == 0
        };
        if startup {
            // A delayed startup restore must never undo a newer user toggle or preference change.
            let _ = state.set_visible_locked(&app, true);
        }
    });
}
