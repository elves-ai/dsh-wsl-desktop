//! Native-only live interaction broker. Browser credentials and Host correlation
//! identities never cross the pet IPC boundary. Hiding a surface does not settle
//! a waterfall or release its timed claim; disconnecting only withdraws deliveries.
use super::{notifications, Controller};
use crate::{
    assistant_transport::Client,
    pet_interactions::{self as model, Card, Reply},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview};

const PET: &str = "assistant-pet";
const MAX_PENDING: usize = 32;
static IDS: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub(super) struct Snapshot {
    revision: u64,
    connected: bool,
    items: Vec<Card>,
}

// Deliberately no Debug or Serialize: this is the native credential lifetime.
#[derive(Clone)]
struct Connection {
    generation: u64,
    origin: String,
    cookie: String,
    client_id: Option<String>,
    cancel: Arc<AtomicBool>,
}
struct Entry {
    card: Card,
    event_id: String,
    agent_id: String,
    submitting: bool,
    claim: Option<Arc<AtomicBool>>,
}
struct Data {
    revision: u64,
    generation: u64,
    connected: bool,
    connection: Option<Connection>,
    entries: BTreeMap<String, Entry>,
}
impl Data {
    fn disconnect(&mut self, generation: Option<u64>) -> bool {
        if generation.is_some_and(|g| self.connection.as_ref().is_none_or(|c| c.generation != g)) {
            return false;
        }
        if let Some(connection) = self.connection.take() {
            connection.cancel.store(true, Ordering::Release);
        }
        for entry in self.entries.values() {
            if let Some(claim) = &entry.claim {
                claim.store(true, Ordering::Release);
            }
        }
        let changed = self.connected || !self.entries.is_empty();
        self.connected = false;
        self.entries.clear();
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        changed
    }
    fn remove_event(&mut self, generation: u64, event_id: &str) -> bool {
        if self
            .connection
            .as_ref()
            .is_none_or(|c| c.generation != generation)
        {
            return false;
        }
        let id = self
            .entries
            .iter()
            .find(|(_, e)| e.event_id == event_id)
            .map(|(id, _)| id.clone());
        let Some(id) = id else {
            return false;
        };
        if let Some(entry) = self.entries.remove(&id) {
            if let Some(claim) = entry.claim {
                claim.store(true, Ordering::Release);
            }
        }
        self.revision = self.revision.saturating_add(1);
        true
    }
}
pub(super) struct PetInteractions {
    data: Mutex<Data>,
    changed: Condvar,
}
impl PetInteractions {
    pub(super) fn new() -> Self {
        Self {
            data: Mutex::new(Data {
                revision: 0,
                generation: 0,
                connected: false,
                connection: None,
                entries: BTreeMap::new(),
            }),
            changed: Condvar::new(),
        }
    }
    fn snapshot(&self) -> Snapshot {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        Snapshot {
            revision: data.revision,
            connected: data.connected,
            items: data.entries.values().map(|e| e.card.clone()).collect(),
        }
    }
    fn publish(&self, app: &AppHandle) {
        let snapshot = self.snapshot();
        self.update_focusable(app, true);
        let _ = app.emit_to(
            EventTarget::webview(PET),
            "pet-interactions-state",
            snapshot,
        );
    }
    fn update_focusable(&self, app: &AppHandle, active: bool) {
        let focusable = {
            let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            active && data.connected && !data.entries.is_empty()
        };
        // Never activate or resize the window. No state lock spans a window RPC.
        if let Some(window) = app.get_window(PET) {
            let _ = window.set_focusable(
                focusable
                    && super::pet_settings::pet_visible(app)
                    && super::pet_settings::interaction_enabled(app),
            );
        }
    }
    fn wait(&self, seconds: u64) {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        drop(
            self.changed
                .wait_timeout(data, Duration::from_secs(seconds)),
        );
    }
    fn invalidate(&self, app: &AppHandle, generation: Option<u64>) {
        let changed = {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            data.disconnect(generation)
        };
        if changed {
            self.publish(app);
        }
        self.changed.notify_all();
    }
    fn remove_event(&self, app: &AppHandle, generation: u64, event_id: &str) {
        let changed = {
            let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            data.remove_event(generation, event_id)
        };
        if changed {
            self.publish(app);
        }
    }
}

fn assert_pet(view: &Webview) -> Result<(), String> {
    super::assistant::assert_assistant(view)?;
    if view.label() != PET
        || view.window().label() != PET
        || view.url().map_err(|_| "无法验证宠物页面。")?.query() != Some("view=pet")
    {
        return Err("此页面无权处理宠物交互。".into());
    }
    Ok(())
}
fn credential(app: &AppHandle, controller: &Controller) -> Result<(String, String), String> {
    if controller.exiting.load(Ordering::Acquire)
        || controller.snapshot().state != "ready"
        || !super::pet_settings::interaction_enabled(app)
    {
        return Err("DSH 交互当前不可用，请在工作窗口处理。".into());
    }
    let origin = controller.backend()?.config.origin();
    let cookie = notifications::auth_cookie(app, &origin)?;
    if cookie.is_empty() {
        return Err("请先在 DSH 工作窗口完成登录。".into());
    }
    Ok((origin, cookie))
}
fn current(app: &AppHandle, connection: &Connection) -> Result<(), String> {
    let controller = app.state::<Arc<Controller>>();
    let (origin, cookie) = credential(app, &controller)?;
    if origin != connection.origin
        || cookie != connection.cookie
        || connection.cancel.load(Ordering::Acquire)
    {
        return Err("DSH 连接已变化，请重新核对当前问题。".into());
    }
    Ok(())
}
fn client(connection: &Connection) -> Result<Client, String> {
    Client::new(&connection.origin, connection.cookie.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(super) fn get_pet_interactions(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetInteractions>>,
) -> Result<Snapshot, String> {
    assert_pet(&view)?;
    if !super::pet_settings::interaction_enabled(&app) {
        state.invalidate(&app, None);
    }
    Ok(state.snapshot())
}

#[tauri::command]
pub(super) async fn submit_pet_interaction(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetInteractions>>,
    id: String,
    reply: Reply,
) -> Result<(), String> {
    assert_pet(&view)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !super::pet_settings::pet_visible(&app)
            || !super::pet_settings::interaction_enabled(&app)
        {
            return Err("宠物交互已隐藏或关闭，请在 DSH 处理。".into());
        }
        let (connection, event_id, value) = {
            let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            let connection = data
                .connection
                .clone()
                .filter(|_| data.connected)
                .ok_or("交互连接已断开，请在 DSH 核对。")?;
            let entry = data
                .entries
                .get_mut(&id)
                .ok_or("问题已失效或已在其它窗口处理。")?;
            if entry.submitting || !entry.card.answerable {
                return Err("此问题暂不可回答，请在 DSH 核对。".into());
            }
            let value = model::validate_reply(&entry.card, &reply)?;
            entry.submitting = true;
            entry.card.answerable = false;
            let event_id = entry.event_id.clone();
            data.revision = data.revision.saturating_add(1);
            (connection, event_id, value)
        };
        state.publish(&app);
        let result = (|| {
            current(&app, &connection)?;
            if !super::pet_settings::pet_visible(&app) {
                return Err("宠物交互已隐藏，未提交回答。".into());
            }
            {
                let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                if data
                    .connection
                    .as_ref()
                    .is_none_or(|c| c.generation != connection.generation)
                    || !data.entries.contains_key(&id)
                {
                    return Err("问题已失效，未提交回答。".into());
                }
            }
            let client_id = connection
                .client_id
                .as_deref()
                .ok_or("交互连接尚未建立。")?;
            client(&connection)?
                .interaction_result(client_id, &event_id, json!({"kind":"result","value":value}))
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                // ACK can also be an idempotent no-op: do not claim this UI won.
                state.remove_event(&app, connection.generation, &event_id);
                Ok(())
            }
            Err(error) => {
                {
                    let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(entry) = data.entries.get_mut(&id) {
                        entry.card.answerable = false;
                        entry.card.can_allow = false;
                        entry.card.warning =
                            Some("回答结果未确认；不会自动重发，请在 DSH 工作窗口核对。".into());
                        data.revision = data.revision.saturating_add(1);
                    }
                }
                state.publish(&app);
                // Read-only reconnect reconciles ambiguous delivery. It never
                // resends the answer: a still-pending event gets a new pet ID.
                state.invalidate(&app, Some(connection.generation));
                Err(error)
            }
        }
    })
    .await
    .map_err(|_| "处理交互的线程异常结束，请在 DSH 核对。".to_owned())?
}

#[tauri::command]
pub(super) async fn open_pet_interaction(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetInteractions>>,
    id: String,
) -> Result<(), String> {
    assert_pet(&view)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (connection, agent_id) = {
            let data = state.data.lock().unwrap_or_else(|e| e.into_inner());
            let connection = data
                .connection
                .clone()
                .ok_or("交互连接已变化，请打开 DSH 工作窗口。")?;
            let entry = data
                .entries
                .get(&id)
                .ok_or("此问题已失效，请打开 DSH 工作窗口。")?;
            (connection, entry.agent_id.clone())
        };
        current(&app, &connection)?;
        let port = app.state::<Arc<Controller>>().backend()?.config.port;
        let target = crate::notifications::notification_session_url(
            port,
            &agent_id,
            IDS.fetch_add(1, Ordering::Relaxed),
        )?;
        notifications::open_notified_session(&app, &target)
    })
    .await
    .map_err(|_| "无法打开原会话，请打开 DSH 工作窗口。".to_owned())?
}

#[tauri::command]
pub(super) fn set_pet_interaction_surface(
    view: Webview,
    app: AppHandle,
    state: State<'_, Arc<PetInteractions>>,
    active: bool,
) -> Result<(), String> {
    assert_pet(&view)?;
    state.update_focusable(&app, active);
    Ok(())
}

pub(super) fn wake(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<PetInteractions>>() {
        if !super::pet_settings::interaction_enabled(app) {
            state.invalidate(app, None);
        }
        state.changed.notify_all();
        state.update_focusable(app, true);
    }
}

fn decline_delivery(connection: Connection, event_id: String) {
    thread::spawn(move || {
        // Delegation is not a business rejection. Never retry after ambiguity.
        if let (Some(client_id), Ok(rpc)) = (connection.client_id.as_deref(), client(&connection)) {
            if !connection.cancel.load(Ordering::Acquire) {
                let _ = rpc.interaction_result(client_id, &event_id, json!({"kind":"next"}));
            }
        }
    });
}

fn approval_details(
    rpc: &Client,
    agent_id: &str,
    call_id: &str,
    tool_name: &str,
) -> Option<String> {
    let list = rpc.session_list().ok()?;
    let row = list["items"]
        .as_array()?
        .iter()
        .find(|r| r["sessionId"].as_str() == Some(agent_id))?;
    // Only live sequenced hints share the active Session's sequence space.
    if row["projections"]["kind"] != "sequenced" {
        return None;
    }
    let through = row["projections"]["asOfSeq"].as_i64()?;
    let page = rpc.session_page(agent_id, through, None, 100).ok()?;
    model::tool_details(&page, call_id, tool_name)
}

fn dispatch(app: &AppHandle, state: &Arc<PetInteractions>, connection: &Connection, frame: Value) {
    let Some(event_id) = frame["eventId"].as_str().map(str::to_owned) else {
        return;
    };
    let Some(event) = frame["event"].as_str().map(str::to_owned) else {
        return;
    };
    let Some(agent_id) = frame["agentId"].as_str().map(str::to_owned) else {
        return;
    };
    if !matches!(
        event.as_str(),
        "approval/request" | "user-questions/request"
    ) {
        decline_delivery(connection.clone(), event_id);
        return;
    }
    let id = format!(
        "pet-interaction-{:020}",
        IDS.fetch_add(1, Ordering::Relaxed)
    );
    let request = frame["request"].clone();
    let mut card = match model::project(&id, &event, &agent_id, &request, None) {
        Ok(card) => card,
        Err(_) => {
            decline_delivery(connection.clone(), event_id);
            return;
        }
    };
    let timed = request["wait"]["timed"] == true;
    let call_id = request["wait"]["callId"].as_str().map(str::to_owned);
    if timed && call_id.is_none() {
        decline_delivery(connection.clone(), event_id);
        return;
    }
    let claim = timed.then(|| Arc::new(AtomicBool::new(false)));
    if timed {
        card.answerable = false;
    }
    let accepted = {
        let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
        if data
            .connection
            .as_ref()
            .is_none_or(|c| c.generation != connection.generation)
            || data.entries.len() >= MAX_PENDING
        {
            false
        } else {
            data.entries.insert(
                id.clone(),
                Entry {
                    card,
                    event_id: event_id.clone(),
                    agent_id: agent_id.clone(),
                    submitting: false,
                    claim: claim.clone(),
                },
            );
            data.revision = data.revision.saturating_add(1);
            true
        }
    };
    if !accepted {
        decline_delivery(connection.clone(), event_id);
        return;
    }
    if event == "user-questions/request" {
        let mut calls = std::collections::BTreeSet::new();
        if let Some(call) = request["wait"]["callId"].as_str() {
            calls.insert(call);
        }
        if let Some(questions) = request["questions"].as_array() {
            for question in questions {
                if let Some(call) = question["intent"]["callId"].as_str() {
                    calls.insert(call);
                }
            }
        }
        for call in calls {
            super::pet_notifications::suppress_waiting(app, &format!("waiting:{agent_id}:{call}"));
        }
    }
    state.publish(app);
    if let (Some(claim), Some(call_id)) = (claim, call_id) {
        let app = app.clone();
        let state = state.clone();
        let connection = connection.clone();
        let claim_id = id.clone();
        let claim_event = event_id.clone();
        let claim_agent = agent_id.clone();
        thread::spawn(move || {
            if let Ok(rpc) = client(&connection) {
                let _ = rpc.interaction_wait(&claim_agent, &call_id, &claim, |_| {
                    if claim.load(Ordering::Acquire) || connection.cancel.load(Ordering::Acquire) {
                        return false;
                    }
                    {
                        let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                        if data
                            .connection
                            .as_ref()
                            .is_none_or(|c| c.generation != connection.generation)
                        {
                            return false;
                        }
                        let Some(entry) = data.entries.get_mut(&claim_id) else {
                            return false;
                        };
                        if !entry.submitting {
                            entry.card.answerable = true;
                        }
                        data.revision = data.revision.saturating_add(1);
                    }
                    state.publish(&app);
                    true
                });
            }
            // Continued/expired questions must be handled in DSH, not reauthorized.
            state.remove_event(&app, connection.generation, &claim_event);
        });
    }
    if event == "approval/request" {
        let app = app.clone();
        let state = state.clone();
        let connection = connection.clone();
        thread::spawn(move || {
            let details = request["callId"]
                .as_str()
                .zip(request["toolName"].as_str())
                .and_then(|(call_id, tool)| {
                    client(&connection)
                        .ok()
                        .and_then(|rpc| approval_details(&rpc, &agent_id, call_id, tool))
                });
            let Ok(card) = model::project(&id, &event, &agent_id, &request, details.as_deref())
            else {
                return;
            };
            {
                let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                if data
                    .connection
                    .as_ref()
                    .is_none_or(|c| c.generation != connection.generation)
                {
                    return;
                }
                let Some(entry) = data.entries.get_mut(&id) else {
                    return;
                };
                if entry.submitting {
                    return;
                }
                entry.card = card;
                data.revision = data.revision.saturating_add(1);
            }
            state.publish(&app);
        });
    }
}

pub(super) fn start(app: AppHandle, controller: Arc<Controller>, state: Arc<PetInteractions>) {
    let watch_app = app.clone();
    let watch_controller = controller.clone();
    let watch_state = state.clone();
    thread::spawn(move || loop {
        let connection = watch_state
            .data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .connection
            .clone();
        if let Some(connection) = connection {
            let valid = credential(&watch_app, &watch_controller).is_ok_and(|(origin, cookie)| {
                origin == connection.origin && cookie == connection.cookie
            });
            if !valid {
                watch_state.invalidate(&watch_app, Some(connection.generation));
            }
        }
        if watch_controller.exiting.load(Ordering::Acquire) {
            watch_state.invalidate(&watch_app, None);
            break;
        }
        watch_state.wait(1);
    });
    thread::spawn(move || {
        let mut activated = false;
        while !controller.exiting.load(Ordering::Acquire) {
            if !super::pet_settings::interaction_enabled(&app) {
                activated = false;
                state.wait(1);
                continue;
            }
            if !activated {
                if !super::pet_settings::pet_visible(&app) {
                    state.wait(1);
                    continue;
                }
                activated = true;
            }
            let Ok((origin, cookie)) = credential(&app, &controller) else {
                state.wait(3);
                continue;
            };
            let connection = {
                let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                data.generation = data.generation.saturating_add(1);
                let connection = Connection {
                    generation: data.generation,
                    origin,
                    cookie,
                    client_id: None,
                    cancel: Arc::new(AtomicBool::new(false)),
                };
                data.connection = Some(connection.clone());
                connection
            };
            if let Ok(rpc) = client(&connection) {
                let _ = rpc.interaction_events(&connection.cancel, |frame| {
                    if connection.cancel.load(Ordering::Acquire) {
                        return false;
                    }
                    match frame["type"].as_str() {
                        Some("ready") => {
                            let mut data = state.data.lock().unwrap_or_else(|e| e.into_inner());
                            if data
                                .connection
                                .as_ref()
                                .is_none_or(|c| c.generation != connection.generation)
                            {
                                return false;
                            }
                            if let Some(active) = data.connection.as_mut() {
                                active.client_id = frame["clientId"].as_str().map(str::to_owned);
                            }
                            data.connected = true;
                            data.revision = data.revision.saturating_add(1);
                            drop(data);
                            state.publish(&app);
                        }
                        Some("waterfall") => {
                            let active = state
                                .data
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .connection
                                .clone();
                            if let Some(active) = active {
                                dispatch(&app, &state, &active, frame);
                            }
                        }
                        Some("cancel") => {
                            if let Some(event_id) = frame["eventId"].as_str() {
                                state.remove_event(&app, connection.generation, event_id);
                            }
                        }
                        _ => {} // Broadcast notifications never own a response.
                    }
                    true
                });
            }
            state.invalidate(&app, Some(connection.generation));
            state.wait(3);
        }
        state.invalidate(&app, None);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared() -> (PetInteractions, Arc<AtomicBool>, Arc<AtomicBool>) {
        let state = PetInteractions::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let claim = Arc::new(AtomicBool::new(false));
        {
            let mut data = state.data.lock().unwrap();
            data.generation = 7;
            data.connected = true;
            data.connection = Some(Connection {
                generation: 7,
                origin: "http://127.0.0.1:1".into(),
                cookie: "secret-cookie".into(),
                client_id: Some("secret-client".into()),
                cancel: cancel.clone(),
            });
            let card = model::project(
                "opaque-card",
                "user-questions/request",
                "public-session",
                &json!({"questions":[{"id":"q","question":"Mock only"}]}),
                None,
            )
            .unwrap();
            data.entries.insert(
                "opaque-card".into(),
                Entry {
                    card,
                    event_id: "secret-event".into(),
                    agent_id: "private-native-agent".into(),
                    submitting: false,
                    claim: Some(claim.clone()),
                },
            );
        }
        (state, cancel, claim)
    }

    #[test]
    fn disconnect_clears_cards_releases_claims_and_rejects_old_generations() {
        let (state, cancel, claim) = prepared();
        let mut data = state.data.lock().unwrap();
        assert!(!data.disconnect(Some(6)));
        assert!(data.connected);
        assert!(!cancel.load(Ordering::Acquire));
        assert!(!claim.load(Ordering::Acquire));
        assert!(data.disconnect(Some(7)));
        assert!(!data.connected);
        assert!(data.entries.is_empty());
        assert!(cancel.load(Ordering::Acquire));
        assert!(claim.load(Ordering::Acquire));
        assert_eq!(data.revision, 1);
        assert!(!data.disconnect(None));
        assert_eq!(data.revision, 1);
    }

    #[test]
    fn cancel_removes_only_delivered_event_and_releases_its_claim() {
        let (state, cancel, claim) = prepared();
        let mut data = state.data.lock().unwrap();
        assert!(!data.remove_event(6, "secret-event"));
        assert!(!data.remove_event(7, "other-event"));
        assert_eq!(data.entries.len(), 1);
        assert!(!claim.load(Ordering::Acquire));
        assert!(data.remove_event(7, "secret-event"));
        assert!(claim.load(Ordering::Acquire));
        assert!(!cancel.load(Ordering::Acquire));
        assert!(data.connected);
        assert!(!data.remove_event(7, "secret-event"));
        assert_eq!(data.revision, 1);
    }

    #[test]
    fn public_snapshot_never_contains_credential_or_host_correlation() {
        let (state, _, _) = prepared();
        let first = serde_json::to_value(state.snapshot()).unwrap();
        let second = serde_json::to_value(state.snapshot()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["items"][0]["id"], "opaque-card");
        let text = first.to_string();
        for secret in [
            "secret-cookie",
            "secret-client",
            "secret-event",
            "private-native-agent",
            "127.0.0.1",
        ] {
            assert!(!text.contains(secret));
        }
        assert_eq!(first.as_object().unwrap().len(), 3);
    }
}
