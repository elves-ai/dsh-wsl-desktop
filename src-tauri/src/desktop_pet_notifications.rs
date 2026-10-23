//! Windows pet-only notification adapter. Native targets never cross the IPC boundary.
#![cfg(windows)]

use crate::pet_notifications::{valid_id, valid_target, BubbleKind, Inbox, Payload};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview};
use url::Url;

const PET: &str = "assistant-pet";
static IDS: AtomicU64 = AtomicU64::new(0);

pub(super) struct PetNotifications {
    inbox: Mutex<Inbox<Url>>,
    started: Instant,
}

impl PetNotifications {
    pub(super) fn new() -> Self {
        Self {
            inbox: Mutex::new(Inbox::new()),
            started: Instant::now(),
        }
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }

    fn clear(&self) {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

pub(super) fn suppress_waiting(app: &AppHandle, key: &str) {
    let Some(state) = app.try_state::<Arc<PetNotifications>>() else {
        return;
    };
    let ids = state
        .inbox
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .suppress_key(state.now_ms(), key);
    if !ids.is_empty() {
        let _ = app.emit_to(
            EventTarget::webview(PET),
            "pet-notification",
            serde_json::json!({"type":"withdraw","ids":ids}),
        );
    }
}
/// Returns true once admitted to the inbox, even if the page is not listening yet.
/// The pet subscribes and then pulls the same inbox to recover that first event.
pub(super) fn emit(
    app: &AppHandle,
    target: Url,
    kind: BubbleKind,
    title: &str,
    body: &str,
    key: &str,
) -> bool {
    // This query can perform window RPC: never hold the inbox mutex across it.
    if !super::pet_settings::bubble_active(app) {
        clear(app);
        return false;
    }
    if !valid_target(&target) {
        return false;
    }
    let Some(state) = app.try_state::<Arc<PetNotifications>>() else {
        return false;
    };
    let id = format!("pet-{:016x}", IDS.fetch_add(1, Ordering::Relaxed));
    let payload = {
        let mut inbox = state.inbox.lock().unwrap_or_else(|e| e.into_inner());
        inbox.insert(state.now_ms(), &id, target, kind, title, body, key)
    };
    let Some(payload) = payload else {
        return false;
    };
    // The pet may have been hidden/disabled while the source worker was processing.
    if !super::pet_settings::bubble_active(app) {
        state.clear();
        return false;
    }
    let _ = app.emit_to(EventTarget::webview(PET), "pet-notification", &payload);
    true
}

pub(super) fn clear(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<PetNotifications>>() {
        state.clear();
    }
}

/// Origin/path/query validation is done by assert_assistant at every command entry.
/// Also pin both native labels and literal pet query; the chat surface is not allowed.
fn assert_pet(view: &Webview) -> Result<(), String> {
    if view.label() != PET
        || view.window().label() != PET
        || view.url().map_err(|_| "无法验证宠物页面。")?.query() != Some("view=pet")
    {
        return Err("此页面无权访问宠物通知。".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) fn get_pet_notifications(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetNotifications>>,
) -> Result<Vec<Payload>, String> {
    super::assistant::assert_assistant(&view)?;
    assert_pet(&view)?;
    if !super::pet_settings::bubble_active(&app) {
        state.clear();
        return Ok(Vec::new());
    }
    let pending = {
        let mut inbox = state.inbox.lock().unwrap_or_else(|e| e.into_inner());
        inbox.pending(state.now_ms())
    };
    if !super::pet_settings::bubble_active(&app) {
        state.clear();
        return Ok(Vec::new());
    }
    Ok(pending)
}

#[tauri::command]
pub(super) async fn open_pet_notification(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetNotifications>>,
    id: String,
) -> Result<(), String> {
    super::assistant::assert_assistant(&view)?;
    assert_pet(&view)?;
    if !valid_id(&id) {
        return Err("宠物通知标识无效。".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !super::pet_settings::bubble_active(&app) {
            state.clear();
            return Err("宠物通知已关闭或隐藏。".into());
        }
        let target = {
            let mut inbox = state.inbox.lock().unwrap_or_else(|e| e.into_inner());
            inbox.target(state.now_ms(), &id).cloned()
        }
        .ok_or_else(|| "宠物通知已过期或已处理。".to_owned())?;
        if !valid_target(&target) {
            return Err("宠物通知目标无效。".into());
        }
        // Reuses current-server origin verification and the existing DSH window.
        // No inbox lock during navigation, focus changes or any other window RPC.
        super::notifications::open_notified_session(&app, &target)?;
        // A failed navigation returns above without ack: the original ID is retryable.
        state
            .inbox
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .ack(state.now_ms(), &id);
        Ok(())
    })
    .await
    .map_err(|_| "无法处理宠物通知，请重试。".to_owned())?
}

#[tauri::command]
pub(super) fn dismiss_pet_notification(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetNotifications>>,
    id: String,
) -> Result<(), String> {
    super::assistant::assert_assistant(&view)?;
    assert_pet(&view)?;
    if !valid_id(&id) {
        return Err("宠物通知标识无效。".into());
    }
    if !super::pet_settings::bubble_active(&app) {
        state.clear();
        return Ok(());
    }
    let acknowledged = {
        let mut inbox = state.inbox.lock().unwrap_or_else(|e| e.into_inner());
        inbox.ack(state.now_ms(), &id)
    };
    if acknowledged {
        Ok(())
    } else {
        Err("宠物通知已过期或已处理。".into())
    }
}
