//! Cross-platform notification policy. No native IPC or notification transport lives here.
use crate::assistant::{BackendIdentity, Binding};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const SETTINGS_LIMIT: u64 = 64 * 1024;
const TRACKER_LIMIT: usize = 4096;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationSnapshot {
    pub enabled: bool,
    pub notify_when_focused: bool,
    pub phase: String,
    pub message: String,
}

impl Default for NotificationSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            notify_when_focused: false,
            phase: "disabled".into(),
            message: "未启用系统通知。".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NotificationSettings {
    pub enabled: bool,
    #[serde(default)]
    pub notify_when_focused: bool,
}

impl NotificationSettings {
    /// Foreground notifications require an explicit opt-in; disabled always wins.
    pub fn should_notify(&self, foreground: bool) -> bool {
        self.enabled && (!foreground || self.notify_when_focused)
    }

    /// Missing settings are disabled. Invalid settings are an error, never opt-in.
    pub fn load(directory: &Path) -> Result<Self, String> {
        let path = directory.join("notifications.json");
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(_) => return Err("无法读取通知设置；系统通知保持关闭。".into()),
        };
        let mut bytes = Vec::new();
        file.take(SETTINGS_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取通知设置；系统通知保持关闭。")?;
        if bytes.len() as u64 > SETTINGS_LIMIT {
            return Err("通知设置过大；系统通知保持关闭。".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "通知设置损坏；系统通知保持关闭。".into())
    }

    /// The caller serializes saves and updates its in-memory state only after success.
    /// Same-directory rename replaces the destination on Unix and Windows; never
    /// truncate the live file. Sync the complete temporary file before replacement.
    pub fn save(&self, directory: &Path) -> Result<(), String> {
        fs::create_dir_all(directory).map_err(|_| "无法创建通知设置目录。")?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "无法序列化通知设置。")?;
        let (temporary, mut file) = create_temporary(directory)?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "无法写入通知设置；原设置未修改。")?;
            drop(file);
            fs::rename(&temporary.path, directory.join("notifications.json"))
                .map_err(|_| "无法替换通知设置；原设置未修改。")?;
            Ok(())
        })();
        // The guard removes only the uniquely created temporary path, including on
        // failure. After successful rename that path no longer exists.
        drop(temporary);
        result
    }
}

struct TemporarySettings {
    path: PathBuf,
}

impl Drop for TemporarySettings {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn create_temporary(directory: &Path) -> Result<(TemporarySettings, File), String> {
    for _ in 0..16 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(
            ".notifications-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((TemporarySettings { path }, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建通知设置临时文件；原设置未修改。".into()),
        }
    }
    Err("通知设置临时文件冲突；原设置未修改。".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub session_id: String,
    pub kind: NoticeKind,
    pub seq: i64,
}

/// Pet chat replies are not task completions. Apply after cursor consumption, before
/// any bubble, toast or sound delivery. Failures and questions keep their own policy.
pub fn is_silent_pet_completion(
    notice: &Notice,
    list: &Value,
    binding: Option<&Binding>,
    current: &BackendIdentity,
) -> bool {
    if notice.kind != NoticeKind::Completed {
        return false;
    }
    let session = list
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("sessionId").and_then(Value::as_str) == Some(&notice.session_id)
            })
        });
    // The preset identifies pet Sessions even after switching the selected chat.
    if session
        .and_then(|item| item.pointer("/projections/values/agentPreset"))
        .and_then(Value::as_str)
        == Some("desktop-pet")
    {
        return true;
    }
    // Legacy/non-memory chats use the default Agent. Trust only this backend's
    // native binding, and exact IDs/paths (never titles or directory prefixes).
    binding
        .filter(|binding| &binding.backend == current)
        .is_some_and(|binding| {
            binding.session_id.as_deref() == Some(notice.session_id.as_str())
                || (!binding.workspace_path.is_empty()
                    && session
                        .and_then(|item| item.get("cwd"))
                        .and_then(Value::as_str)
                        == Some(binding.workspace_path.as_str()))
        })
}

/// Add task identity using only session-list metadata, never history/question text.
/// Titles are ephemeral; do not put them in snapshots or launcher logs.
pub fn task_notice_title(list: &Value, session_id: &str) -> String {
    list.get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("sessionId").and_then(Value::as_str) == Some(session_id))
        })
        .and_then(|item| item.pointer("/projections/values/title"))
        .and_then(Value::as_str)
        .map(|title| compact_task_text(title, 72))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| {
            let id = compact_task_text(session_id, 8);
            if id.is_empty() {
                "未命名会话".into()
            } else {
                format!("未命名会话 · {id}")
            }
        })
}

pub fn task_notice_body(list: &Value, session_id: &str, description: &str) -> String {
    let title = task_notice_title(list, session_id);
    format!("任务：{title}\n{description}")
}

/// Construct only the configured loopback root + an encoded fragment. Session IDs
/// are data, never paths/URLs/JavaScript. A nonce makes repeated notices hash-change.
pub fn notification_session_url(
    port: u16,
    session_id: &str,
    nonce: u64,
) -> Result<url::Url, String> {
    if port == 0
        || session_id.trim().is_empty()
        || session_id.len() > 256
        || session_id.chars().any(char::is_control)
    {
        return Err("通知会话目标无效。".into());
    }
    let mut target = url::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|_| "通知会话目标无效。".to_owned())?;
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("session", session_id)
        .append_pair("notification", &nonce.to_string())
        .finish();
    target.set_fragment(Some(&fragment));
    Ok(target)
}

/// Bound by Unicode characters (not bytes); keep task names on one plain-text line.
fn compact_task_text(text: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut length = 0;
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = !output.is_empty();
            continue;
        }
        if ch.is_control()
            || matches!(ch, '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        {
            continue;
        }
        let needed = 1 + usize::from(pending_space);
        if length + needed > limit {
            output.push('…');
            break;
        }
        if pending_space {
            output.push(' ');
        }
        output.push(ch);
        length += needed;
        pending_space = false;
    }
    output
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadRequest {
    pub session_id: String,
    /// Inclusive asOfSeq cut to pass to the last-page transport.
    pub cursor: i64,
    /// Successfully consumed cut, or -1 for a newly observed Session.
    pub previous: i64,
    /// Timed user questions remain answerable even after a completed turn.
    pub suppress_completed: bool,
    generation: u64,
    epoch: u64,
}

#[derive(Debug, Clone)]
struct Cursor {
    acknowledged: i64,
    observed: i64,
    epoch: u64,
}

/// Cursor state is connection-local and intentionally never persisted.
/// Call reset on disconnection/reconnection or disable/re-enable. The first
/// successful scan after reset is a silent baseline, not a history replay.
#[derive(Debug)]
pub struct CursorTracker {
    since: u64,
    initialized: bool,
    generation: u64,
    cursors: BTreeMap<String, Cursor>,
}

impl CursorTracker {
    pub fn new(since: u64) -> Self {
        Self {
            since,
            initialized: false,
            generation: 0,
            cursors: BTreeMap::new(),
        }
    }

    pub fn reset(&mut self, since: u64) {
        self.since = since;
        self.initialized = false;
        self.generation = self.generation.wrapping_add(1);
        self.cursors.clear();
    }

    /// Reads list.items. Only live/sequenced root Session hints are comparable.
    /// Running Sessions retain their old acknowledgment, so a short turn finishing
    /// entirely between polls is detected just like one whose running state was seen.
    /// A failed scan never partially advances the baseline.
    pub fn scan(&mut self, list: &Value) -> Result<Vec<ReadRequest>, String> {
        let items = list
            .get("items")
            .and_then(Value::as_array)
            .ok_or("通知会话列表格式无效。")?;
        let mut cursors = self.cursors.clone();
        let mut seen = BTreeSet::new();
        let mut reads = Vec::new();
        for item in items {
            let item = item.as_object().ok_or("通知会话列表项目格式无效。")?;
            if item.get("agentAvailable").and_then(Value::as_bool) != Some(true)
                || item.get("origin").and_then(Value::as_str) == Some("subagent")
            {
                continue;
            }
            let Some(projections) = item.get("projections") else {
                continue;
            };
            if projections.get("kind").and_then(Value::as_str) != Some("sequenced") {
                continue;
            }
            let id = item
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| {
                    !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control)
                })
                .ok_or("通知会话标识无效。")?;
            if !seen.insert(id) {
                return Err("通知会话列表包含重复标识。".into());
            }
            let running = item
                .get("running")
                .and_then(Value::as_bool)
                .ok_or("通知会话运行状态无效。")?;
            let seq = cursor_value(projections.get("asOfSeq"))?;
            if !cursors.contains_key(id) && cursors.len() >= TRACKER_LIMIT {
                return Err("通知会话数量超过安全上限；请重新连接。".into());
            }
            let cursor = cursors.entry(id.to_owned()).or_insert(Cursor {
                acknowledged: if self.initialized { -1 } else { seq },
                observed: seq,
                epoch: 0,
            });
            if seq < cursor.observed {
                cursor.acknowledged = seq;
                cursor.observed = seq;
                cursor.epoch = cursor.epoch.wrapping_add(1);
                continue;
            }
            cursor.observed = seq;
            if self.initialized && !running && seq > cursor.acknowledged {
                reads.push(ReadRequest {
                    session_id: id.to_owned(),
                    cursor: seq,
                    previous: cursor.acknowledged,
                    suppress_completed: active_questions(projections)?,
                    generation: self.generation,
                    epoch: cursor.epoch,
                });
            }
        }
        self.cursors = cursors;
        self.initialized = true;
        Ok(reads)
    }

    /// Validate one successful last-page read and acknowledge its whole cut even
    /// when no notice is eligible. The adapter must call this before foreground
    /// suppression or OS delivery, so focus changes and delivery failures cannot
    /// repeatedly replay the same completed turn.
    pub fn consume(
        &mut self,
        request: &ReadRequest,
        page: &Value,
    ) -> Result<Option<Notice>, String> {
        if request.generation != self.generation {
            return Err("通知读取属于旧连接。".into());
        }
        let cursor = self
            .cursors
            .get(&request.session_id)
            .ok_or("通知读取缺少会话基线。")?;
        if request.epoch != cursor.epoch {
            return Err("通知读取属于已重建的会话基线。".into());
        }
        if cursor.acknowledged >= request.cursor {
            return Ok(None);
        }
        if request.previous != cursor.acknowledged
            || request.cursor > cursor.observed
            || request.cursor <= request.previous
        {
            return Err("通知读取游标与会话基线不一致。".into());
        }
        let records = page
            .get("records")
            .and_then(Value::as_array)
            .ok_or("通知事件页格式无效。")?;
        let mut latest: Option<(i64, u64, &Value)> = None;
        let mut last_seq = None;
        for record in records {
            if record.get("type").and_then(Value::as_str) != Some("event") {
                return Err("通知事件记录格式无效。".into());
            }
            let event = record.get("event").ok_or("通知事件记录缺少事件。")?;
            let seq = cursor_value(event.get("seq"))?;
            if seq < 0 || seq > request.cursor || last_seq.is_some_and(|last| seq <= last) {
                return Err("通知事件序号无效或未按顺序排列。".into());
            }
            last_seq = Some(seq);
            let time = event
                .get("time")
                .and_then(Value::as_u64)
                .filter(|time| *time <= MAX_SAFE_INTEGER as u64)
                .ok_or("通知事件时间无效。")?;
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .ok_or("通知事件类型无效。")?;
            if kind == "session/end-seed" {
                // A fork or restored lifecycle can inherit a very recent terminal
                // event. Its timestamp alone cannot distinguish seed from live work.
                latest = None;
            } else if seq > request.previous && kind == "turn/end" {
                let reason = event
                    .get("data")
                    .and_then(|data| data.get("reason"))
                    .filter(|reason| reason.get("kind").and_then(Value::as_str).is_some())
                    .ok_or("通知回合结束原因无效。")?;
                latest = Some((seq, time, reason));
            }
        }
        // A last-page read at an inclusive throughSeq cut always includes that
        // exact final event. Empty/truncated success responses must not lose events
        // by acknowledging a cut that was never actually read.
        if request.cursor >= 0 && last_seq != Some(request.cursor) {
            return Err("通知事件页未覆盖请求游标；尚未消费此页。".into());
        }
        // Select the latest turn/end FIRST. A later cancellation/block must not
        // accidentally fall back to a previous completed turn on the same page.
        let notice = latest.and_then(|(seq, time, reason)| {
            if time < self.since {
                return None;
            }
            let kind = match reason.get("kind").and_then(Value::as_str) {
                Some("completed") if !request.suppress_completed => NoticeKind::Completed,
                Some("error") => NoticeKind::Failed,
                _ => return None,
            };
            Some(Notice {
                session_id: request.session_id.clone(),
                kind,
                seq,
            })
        });
        self.cursors
            .get_mut(&request.session_id)
            .expect("validated cursor remains present")
            .acknowledged = request.cursor;
        Ok(notice)
    }
}

fn active_questions(projections: &Value) -> Result<bool, String> {
    let Some(questions) = projections
        .get("values")
        .and_then(|values| values.get("userQuestions"))
    else {
        return Ok(false);
    };
    questions
        .get("active")
        .and_then(Value::as_array)
        .map(|active| !active.is_empty())
        .ok_or_else(|| "通知待答问题投影格式无效。".into())
}

fn cursor_value(value: Option<&Value>) -> Result<i64, String> {
    value
        .and_then(Value::as_i64)
        .filter(|seq| (-1..=MAX_SAFE_INTEGER).contains(seq))
        .ok_or_else(|| "通知会话游标无效。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, seq: i64, running: bool) -> Value {
        json!({"sessionId":id,"running":running,"agentAvailable":true,
            "projections":{"kind":"sequenced","asOfSeq":seq}})
    }

    fn list(rows: Vec<Value>) -> Value {
        json!({"items":rows})
    }

    fn end(seq: i64, time: u64, reason: &str) -> Value {
        json!({"type":"event","event":{"type":"turn/end","seq":seq,
            "time":time,"data":{"reason":{"kind":reason}}}})
    }

    fn tail(seq: i64, time: u64) -> Value {
        json!({"type":"event","event":{"type":"plugin:test/tail","seq":seq,
            "time":time,"data":{},"ignorable":true}})
    }

    fn page(events: Vec<Value>) -> Value {
        json!({"records":events})
    }

    fn changed(tracker: &mut CursorTracker, seq: i64) -> ReadRequest {
        tracker
            .scan(&list(vec![row("root", seq, false)]))
            .unwrap()
            .pop()
            .unwrap()
    }

    fn tracker() -> CursorTracker {
        let mut tracker = CursorTracker::new(1000);
        assert!(tracker
            .scan(&list(vec![row("root", 10, false)]))
            .unwrap()
            .is_empty());
        tracker
    }

    #[test]
    fn notification_links_encode_session_as_fragment_data_on_configured_loopback() {
        for port in [1, 80, 3080, u16::MAX] {
            for id in [
                "normal-session",
                "会话 🚀",
                "//evil.invalid/path?token=x#fragment&session=other+%2F",
            ] {
                let url = notification_session_url(port, id, 42).unwrap();
                assert_eq!(url.scheme(), "http");
                assert_eq!(url.host_str(), Some("127.0.0.1"));
                assert_eq!(url.port_or_known_default(), Some(port));
                assert_eq!(url.path(), "/");
                assert_eq!(url.query(), None);
                assert!(url.username().is_empty());
                assert_eq!(url.password(), None);
                let pairs: Vec<_> = url::form_urlencoded::parse(url.fragment().unwrap().as_bytes())
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect();
                assert_eq!(
                    pairs,
                    vec![
                        ("session".into(), id.into()),
                        ("notification".into(), "42".into())
                    ]
                );
            }
        }
    }

    #[test]
    fn notification_links_reject_invalid_ids_and_force_repeated_click_hash_changes() {
        for id in [
            "",
            "  ",
            "bad\nvalue",
            "bad\u{0}value",
            &"x".repeat(257),
            &"测".repeat(86),
        ] {
            assert!(notification_session_url(3080, id, 0).is_err());
        }
        assert!(notification_session_url(0, "valid", 0).is_err());
        assert_ne!(
            notification_session_url(3080, "same-session", 1)
                .unwrap()
                .fragment(),
            notification_session_url(3080, "same-session", 2)
                .unwrap()
                .fragment()
        );
    }

    fn pet_binding() -> Binding {
        Binding {
            backend: BackendIdentity {
                distribution: "Ubuntu".into(),
                user: "pet-user".into(),
                origin: "http://127.0.0.1:3080".into(),
            },
            workspace_id: "pet-workspace".into(),
            session_id: Some("selected-pet".into()),
            workspace_path: "/home/pet-user/pet".into(),
            session_pending: false,
        }
    }

    #[test]
    fn pet_completions_are_silent_for_preset_selected_and_previous_chats() {
        let binding = pet_binding();
        for (id, cwd, preset) in [
            ("preset-pet", "/other", "desktop-pet"),
            ("selected-pet", "/other", "standard"),
            ("previous-pet", "/home/pet-user/pet", "standard"),
        ] {
            let rows = list(vec![json!({"sessionId":id,"cwd":cwd,
                "projections":{"values":{"agentPreset":preset}}})]);
            for kind in [NoticeKind::Completed, NoticeKind::Failed] {
                let notice = Notice {
                    session_id: id.into(),
                    kind,
                    seq: 15,
                };
                assert_eq!(
                    is_silent_pet_completion(&notice, &rows, Some(&binding), &binding.backend),
                    kind == NoticeKind::Completed,
                    "{id}: {kind:?}",
                );
            }
        }
        let notice = Notice {
            session_id: "preset-pet".into(),
            kind: NoticeKind::Completed,
            seq: 15,
        };
        assert!(is_silent_pet_completion(
            &notice,
            &list(vec![json!({
                "sessionId":"preset-pet","projections":{"values":{"agentPreset":"desktop-pet"}}
            })]),
            None,
            &binding.backend
        ));
    }

    #[test]
    fn ordinary_tasks_and_similar_names_paths_or_presets_are_not_silenced() {
        let binding = pet_binding();
        let notice = Notice {
            session_id: "task".into(),
            kind: NoticeKind::Completed,
            seq: 15,
        };
        for cwd in [
            "/home/pet-user/pet-project",
            "/home/pet-user/pet/subdir",
            "/work",
        ] {
            let rows = list(vec![
                json!({"sessionId":"task","cwd":cwd,
                "projections":{"values":{"title":"desktop-pet 宠物对话", "agentPreset":"desktop-pet-copy"}}}),
                json!({"sessionId":"another-pet","projections":{"values":{"agentPreset":"desktop-pet"}}}),
            ]);
            assert!(!is_silent_pet_completion(
                &notice,
                &rows,
                Some(&binding),
                &binding.backend
            ));
        }
        for rows in [
            json!({}),
            json!({"items":null}),
            list(vec![json!({"sessionId":"task"})]),
        ] {
            assert!(!is_silent_pet_completion(
                &notice,
                &rows,
                None,
                &binding.backend
            ));
        }
    }

    #[test]
    fn pet_binding_from_another_backend_does_not_silence_tasks() {
        let binding = pet_binding();
        for field in ["distribution", "user", "origin"] {
            let mut current = binding.backend.clone();
            match field {
                "distribution" => current.distribution = "other".into(),
                "user" => current.user = "other".into(),
                _ => current.origin = "http://127.0.0.1:4000".into(),
            }
            for id in ["selected-pet", "previous-pet"] {
                let notice = Notice {
                    session_id: id.into(),
                    kind: NoticeKind::Completed,
                    seq: 15,
                };
                let rows = list(vec![json!({"sessionId":id,"cwd":binding.workspace_path})]);
                assert!(!is_silent_pet_completion(
                    &notice,
                    &rows,
                    Some(&binding),
                    &current
                ));
            }
        }
    }

    #[test]
    fn silent_pet_completion_is_consumed_without_replay_and_next_task_still_notifies() {
        let binding = pet_binding();
        let mut tracker = tracker();
        let mut pet = row("root", 15, false);
        pet["projections"]["values"] = json!({"agentPreset":"desktop-pet"});
        let rows = list(vec![pet]);
        let request = tracker.scan(&rows).unwrap().pop().unwrap();
        let notice = tracker
            .consume(&request, &page(vec![end(15, 1001, "completed")]))
            .unwrap()
            .unwrap();
        assert!(is_silent_pet_completion(
            &notice,
            &rows,
            None,
            &binding.backend
        ));
        // Switching chat/preset cannot replay the already acknowledged completion.
        assert!(tracker
            .scan(&list(vec![row("root", 15, false)]))
            .unwrap()
            .is_empty());
        let request = changed(&mut tracker, 16);
        let notice = tracker
            .consume(&request, &page(vec![end(16, 1002, "completed")]))
            .unwrap()
            .unwrap();
        assert!(!is_silent_pet_completion(
            &notice,
            &list(vec![row("root", 16, false)]),
            None,
            &binding.backend
        ));
    }

    #[test]
    fn task_notice_title_is_separate_from_description() {
        let rows = list(vec![
            json!({"sessionId":"root", "projections":{"values":{"title":"宠物的对话目录展示到设置里"}}}),
        ]);
        assert_eq!(
            task_notice_title(&rows, "root"),
            "宠物的对话目录展示到设置里"
        );
        assert_eq!(task_notice_title(&rows, ""), "未命名会话");
    }

    #[test]
    fn task_notice_uses_matching_session_title_projection() {
        let rows = list(vec![
            json!({"sessionId":"other", "projections":{"values":{"title":"其他任务"}}}),
            json!({"sessionId":"root", "title":"错误的顶层标题", "name":"错误的名称",
                "cwd":"/private/workspace", "projections":{"kind":"sequenced",
                    "asOfSeq":12, "values":{"title":"修复登录页面"}}}),
        ]);
        for description in ["本轮执行已结束。", "本轮执行失败。", "需要你回答。"]
        {
            assert_eq!(
                task_notice_body(&rows, "root", description),
                format!("任务：修复登录页面\n{description}")
            );
        }
        assert_eq!(
            task_notice_body(&rows, "other", "需要你回答。"),
            "任务：其他任务\n需要你回答。"
        );
    }

    #[test]
    fn task_notice_missing_or_invalid_title_uses_short_session_id() {
        for title in [
            Value::Null,
            json!(""),
            json!(" \r\n\t"),
            json!(23),
            json!({"title":"不是标题字符串"}),
            json!(["不是标题字符串"]),
        ] {
            let rows = list(vec![json!({"sessionId":"a1b2c3d4-5678",
                "projections":{"values":{"title":title}}})]);
            assert_eq!(
                task_notice_body(&rows, "a1b2c3d4-5678", "查看结果。"),
                "任务：未命名会话 · a1b2c3d4…\n查看结果。"
            );
        }
        for rows in [
            json!({}),
            json!({"items":null}),
            list(vec![]),
            list(vec![json!({"sessionId":"abcd"})]),
        ] {
            assert_eq!(
                task_notice_body(&rows, "abcd", "查看结果。"),
                "任务：未命名会话 · abcd\n查看结果。"
            );
        }
        assert_ne!(
            task_notice_body(&list(vec![]), "sessionA", "查看结果。"),
            task_notice_body(&list(vec![]), "sessionB", "查看结果。")
        );
    }

    #[test]
    fn task_notice_never_falls_back_to_history_questions_paths_or_credentials() {
        let rows = list(vec![json!({"sessionId":"root", "cwd":"/private/project",
            "title":"顶层非协议标题", "token":"secret-token", "cookie":"secret-cookie",
            "messages":[{"text":"secret-conversation"}],
            "projections":{"values":{"userQuestions":{"active":[{"question":"secret-question"}]}}}})]);
        assert_eq!(
            task_notice_body(&rows, "root", "查看结果。"),
            "任务：未命名会话 · root\n查看结果。"
        );
    }

    #[test]
    fn task_notice_normalizes_whitespace_controls_and_direction_markers() {
        let rows = list(vec![json!({"sessionId":"root", "projections":{"values":{
            "title":" \r\n 修复\t登录\u{0000}页面\u{202e}  🚀\u{2066}  "}}})]);
        assert_eq!(
            task_notice_body(&rows, "root", "查看结果。"),
            "任务：修复 登录页面 🚀\n查看结果。"
        );
    }

    #[test]
    fn task_notice_truncates_unicode_titles_without_splitting_utf8() {
        for ch in ['测', '🚀'] {
            let title = ch.to_string().repeat(72);
            let rows = |title: String| {
                list(vec![json!({"sessionId":"root",
                "projections":{"values":{"title":title}}})])
            };
            assert_eq!(
                task_notice_body(&rows(format!("{title}  ")), "root", "查看结果。"),
                format!("任务：{title}\n查看结果。")
            );
            assert_eq!(
                task_notice_body(&rows(format!("{title}{ch}")), "root", "查看结果。"),
                format!("任务：{title}…\n查看结果。")
            );
        }
    }

    #[test]
    fn task_notice_uses_latest_title_and_handles_empty_or_unicode_fallback_ids() {
        let mut rows = list(vec![json!({"sessionId":"root",
            "projections":{"values":{"title":"旧任务名"}}})]);
        assert!(task_notice_body(&rows, "root", "查看结果。").contains("旧任务名"));
        rows["items"][0]["projections"]["values"]["title"] = json!("新任务名");
        assert!(task_notice_body(&rows, "root", "查看结果。").contains("新任务名"));
        assert_eq!(
            task_notice_body(&rows, "", "查看结果。"),
            "任务：未命名会话\n查看结果。"
        );
        assert_eq!(
            task_notice_body(&rows, "会话🧪", "查看结果。"),
            "任务：未命名会话 · 会话🧪\n查看结果。"
        );
    }

    #[test]
    fn defaults_are_disabled_and_first_scan_is_silent() {
        assert!(!NotificationSettings::default().enabled);
        assert_eq!(NotificationSnapshot::default().phase, "disabled");
        assert!(!NotificationSnapshot::default().enabled);
        let mut tracker = tracker();
        assert!(tracker
            .scan(&list(vec![row("root", 10, false)]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn short_turn_between_polls_is_not_missed_and_duplicate_is_consumed() {
        let mut tracker = tracker();
        let request = changed(&mut tracker, 14);
        let events = page(vec![end(13, 1001, "completed"), tail(14, 1001)]);
        let notice = tracker.consume(&request, &events).unwrap().unwrap();
        assert_eq!(notice.kind, NoticeKind::Completed);
        assert_eq!(notice.seq, 13);
        assert_eq!(request.previous, 10);
        assert!(tracker.consume(&request, &events).unwrap().is_none());
        assert!(tracker
            .scan(&list(vec![row("root", 14, false)]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn running_session_keeps_previous_cursor_until_stopped() {
        let mut tracker = tracker();
        assert!(tracker
            .scan(&list(vec![row("root", 15, true)]))
            .unwrap()
            .is_empty());
        let request = changed(&mut tracker, 17);
        assert_eq!(request.previous, 10);
        assert!(tracker
            .consume(
                &request,
                &page(vec![end(16, 1100, "completed"), tail(17, 1100)])
            )
            .unwrap()
            .is_some());
    }

    #[test]
    fn new_sessions_are_read_but_historical_cold_sessions_do_not_notify() {
        let mut tracker = tracker();
        let requests = tracker
            .scan(&list(vec![row("old", 20, false), row("new", 3, false)]))
            .unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|request| request.previous == -1));
        assert!(tracker
            .consume(&requests[0], &page(vec![end(20, 999, "completed")]))
            .unwrap()
            .is_none());
        assert_eq!(
            tracker
                .consume(&requests[1], &page(vec![end(3, 1000, "completed")]))
                .unwrap()
                .unwrap()
                .kind,
            NoticeKind::Completed
        );
    }

    #[test]
    fn new_running_session_is_read_after_completion() {
        let mut tracker = tracker();
        assert!(tracker
            .scan(&list(vec![row("new", 0, true)]))
            .unwrap()
            .is_empty());
        let request = tracker
            .scan(&list(vec![row("new", 2, false)]))
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(request.previous, -1);
        assert!(tracker
            .consume(&request, &page(vec![end(2, 1001, "completed")]))
            .unwrap()
            .is_some());
    }

    #[test]
    fn recent_seed_history_is_silent_but_post_seed_work_notifies() {
        for live in [false, true] {
            let mut tracker = tracker();
            let cut = if live { 3 } else { 2 };
            let mut fork = row("fork", cut, false);
            fork["parentSessionId"] = json!("root");
            let request = tracker
                .scan(&list(vec![row("root", 10, false), fork]))
                .unwrap()
                .pop()
                .unwrap();
            let mut records = vec![
                end(1, 1001, "completed"),
                json!({"type":"event","event":{"type":"session/end-seed",
                    "seq":2,"time":1002,"data":{"inherited":true}}}),
            ];
            if live {
                records.push(end(3, 1003, "completed"));
            }
            let notice = tracker.consume(&request, &page(records)).unwrap();
            assert_eq!(
                notice.map(|notice| notice.kind),
                live.then_some(NoticeKind::Completed)
            );
        }
        let mut tracker = tracker();
        let request = changed(&mut tracker, 12);
        assert!(tracker
            .consume(
                &request,
                &page(vec![
                    end(11, 1001, "error"),
                    json!({"type":"event","event":{"type":"session/end-seed",
                "seq":12,"time":1002,"data":{}}})
                ])
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn only_completed_and_error_are_notices() {
        for (reason, expected) in [
            ("completed", Some(NoticeKind::Completed)),
            ("error", Some(NoticeKind::Failed)),
            ("aborted", None),
            ("blocked", None),
            ("interrupted", None),
            ("max-tokens", None),
            ("forked", None),
            ("plugin/new-reason", None),
        ] {
            let mut tracker = tracker();
            let request = changed(&mut tracker, 12);
            assert_eq!(
                tracker
                    .consume(&request, &page(vec![end(12, 1001, reason)]))
                    .unwrap()
                    .map(|notice| notice.kind),
                expected
            );
            assert!(tracker
                .scan(&list(vec![row("root", 12, false)]))
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn latest_turn_end_wins_even_when_cancelled_or_blocked() {
        for reason in ["aborted", "blocked"] {
            let mut tracker = tracker();
            let request = changed(&mut tracker, 15);
            assert!(tracker
                .consume(
                    &request,
                    &page(vec![
                        end(11, 1001, "completed"),
                        end(14, 1002, reason),
                        tail(15, 1002)
                    ])
                )
                .unwrap()
                .is_none());
        }
        let mut tracker = tracker();
        let request = changed(&mut tracker, 15);
        assert_eq!(
            tracker
                .consume(
                    &request,
                    &page(vec![
                        end(11, 1001, "completed"),
                        end(14, 1002, "error"),
                        tail(15, 1002)
                    ])
                )
                .unwrap()
                .unwrap()
                .kind,
            NoticeKind::Failed
        );
    }

    #[test]
    fn subagents_unavailable_and_cached_sessions_are_ignored() {
        let mut tracker = tracker();
        let mut origin = row("child1", 2, false);
        origin["origin"] = json!("subagent");
        let mut cached = row("cold", 2, false);
        cached["projections"]["kind"] = json!("cached");
        let mut unavailable = row("no-agent", 2, false);
        unavailable["agentAvailable"] = json!(false);
        let mut missing_agent = row("missing-agent", 2, false);
        missing_agent
            .as_object_mut()
            .unwrap()
            .remove("agentAvailable");
        assert!(tracker
            .scan(&list(vec![origin, cached, unavailable, missing_agent]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn ordinary_fork_is_supported_but_inherited_old_events_are_silent() {
        let mut tracker = tracker();
        let mut fork = row("fork", 15, false);
        fork["parentSessionId"] = json!("root");
        let request = tracker
            .scan(&list(vec![fork.clone()]))
            .unwrap()
            .pop()
            .unwrap();
        assert!(tracker
            .consume(
                &request,
                &page(vec![end(14, 999, "completed"), tail(15, 999)])
            )
            .unwrap()
            .is_none());
        fork["projections"]["asOfSeq"] = json!(17);
        let request = tracker.scan(&list(vec![fork])).unwrap().pop().unwrap();
        assert_eq!(
            tracker
                .consume(
                    &request,
                    &page(vec![end(14, 999, "completed"), end(17, 1001, "completed")])
                )
                .unwrap()
                .unwrap()
                .kind,
            NoticeKind::Completed
        );
    }

    #[test]
    fn timed_questions_suppress_completed_but_do_not_hide_failures() {
        for (reason, expected) in [("completed", None), ("error", Some(NoticeKind::Failed))] {
            let mut tracker = tracker();
            let mut waiting = row("root", 15, false);
            waiting["projections"]["values"] =
                json!({"userQuestions":{"active":[{"callId":"question"}],"settled":[]}});
            let request = tracker.scan(&list(vec![waiting])).unwrap().pop().unwrap();
            assert!(request.suppress_completed);
            assert_eq!(
                tracker
                    .consume(&request, &page(vec![end(15, 1001, reason)]))
                    .unwrap()
                    .map(|notice| notice.kind),
                expected
            );
            // Settling the question without a new event must not replay completion.
            assert!(tracker
                .scan(&list(vec![row("root", 15, false)]))
                .unwrap()
                .is_empty());
        }
        let mut tracker = tracker();
        let mut settled = row("root", 15, false);
        settled["projections"]["values"] =
            json!({"userQuestions":{"active":[],"settled":[{"callId":"old"}]}});
        let request = tracker.scan(&list(vec![settled])).unwrap().pop().unwrap();
        assert!(!request.suppress_completed);
        assert!(tracker
            .consume(&request, &page(vec![end(15, 1001, "completed")]))
            .unwrap()
            .is_some());
    }

    #[test]
    fn malformed_question_projection_does_not_advance_ack() {
        let mut tracker = tracker();
        let mut malformed = row("root", 15, false);
        malformed["projections"]["values"] = json!({"userQuestions":{"active":"invalid"}});
        assert!(tracker.scan(&list(vec![malformed])).is_err());
        assert_eq!(changed(&mut tracker, 15).previous, 10);
    }

    #[test]
    fn disconnect_reset_rebaselines_and_rejects_inflight_old_page() {
        let mut tracker = tracker();
        let pending = changed(&mut tracker, 15);
        tracker.reset(2000);
        assert!(tracker
            .scan(&list(vec![row("root", 20, false)]))
            .unwrap()
            .is_empty());
        assert!(tracker
            .consume(&pending, &page(vec![end(15, 1500, "completed")]))
            .is_err());
        let request = changed(&mut tracker, 22);
        assert!(tracker
            .consume(&request, &page(vec![end(22, 1999, "completed")]))
            .unwrap()
            .is_none());
    }

    #[test]
    fn truncated_successful_page_does_not_ack_or_notify() {
        let mut tracker = tracker();
        let request = changed(&mut tracker, 14);
        assert!(tracker
            .consume(&request, &page(vec![end(13, 1001, "completed")]))
            .is_err());
        assert_eq!(changed(&mut tracker, 14).previous, 10);
        let notice = tracker
            .consume(
                &request,
                &page(vec![end(13, 1001, "completed"), tail(14, 1001)]),
            )
            .unwrap()
            .unwrap();
        assert_eq!(notice.seq, 13);
        assert!(tracker
            .scan(&list(vec![row("root", 14, false)]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn malformed_page_does_not_ack_and_foreground_suppression_still_does() {
        let mut tracker = tracker();
        let request = changed(&mut tracker, 14);
        assert!(tracker
            .consume(&request, &json!({"records":"broken"}))
            .is_err());
        assert_eq!(changed(&mut tracker, 14).previous, 10);
        // The adapter may discard this notice because the window is foreground.
        let _ = tracker
            .consume(&request, &page(vec![end(14, 1001, "completed")]))
            .unwrap();
        assert!(tracker
            .scan(&list(vec![row("root", 14, false)]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn malformed_cursors_fail_without_partial_updates_and_regression_rebaselines() {
        let mut tracker = tracker();
        assert!(tracker
            .scan(&list(vec![row("root", 11, true), row("other", -2, false)]))
            .is_err());
        // If the failed scan had partially advanced observed, 10 would regress.
        assert!(tracker
            .scan(&list(vec![row("root", 10, false)]))
            .unwrap()
            .is_empty());
        let pending = changed(&mut tracker, 15);
        assert!(tracker
            .scan(&list(vec![row("root", 14, false)]))
            .unwrap()
            .is_empty());
        assert!(tracker
            .consume(&pending, &page(vec![end(15, 1001, "completed")]))
            .is_err());
        let mut request = changed(&mut tracker, 15);
        assert_eq!(request.previous, 14);
        request.cursor = 16;
        assert!(tracker.consume(&request, &page(vec![])).is_err());
    }

    #[test]
    fn empty_session_cursor_is_supported_but_empty_nonempty_cut_is_rejected() {
        let mut tracker = CursorTracker::new(1000);
        assert!(tracker
            .scan(&list(vec![row("empty", -1, false)]))
            .unwrap()
            .is_empty());
        let request = tracker
            .scan(&list(vec![row("empty", 0, false)]))
            .unwrap()
            .pop()
            .unwrap();
        assert!(tracker.consume(&request, &page(vec![])).is_err());
        assert_eq!(
            tracker.scan(&list(vec![row("empty", 0, false)])).unwrap()[0].previous,
            -1
        );
        assert!(tracker
            .consume(&request, &page(vec![tail(0, 1001)]))
            .unwrap()
            .is_none());
        assert!(tracker
            .scan(&list(vec![row("empty", 0, false)]))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn tracker_capacity_is_an_explicit_error_not_silent_eviction() {
        let mut tracker = CursorTracker::new(1000);
        let rows = (0..TRACKER_LIMIT)
            .map(|i| row(&format!("s{i}"), 0, false))
            .collect();
        assert!(tracker.scan(&list(rows)).unwrap().is_empty());
        assert!(tracker
            .scan(&list(vec![row("overflow", 0, false)]))
            .is_err());
        assert_eq!(tracker.cursors.len(), TRACKER_LIMIT);
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "dsh-notifications-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn notification_defaults_do_not_opt_into_foreground_delivery() {
        let snapshot = NotificationSnapshot::default();
        assert!(!snapshot.enabled);
        assert!(!snapshot.notify_when_focused);
        assert_eq!(
            serde_json::to_value(snapshot).unwrap()["notify_when_focused"],
            json!(false)
        );
        let settings = NotificationSettings::default();
        assert!(!settings.enabled);
        assert!(!settings.notify_when_focused);
        assert!(!settings.should_notify(false));
        assert!(!settings.should_notify(true));
    }

    #[test]
    fn notification_policy_covers_enabled_focus_and_opt_in_matrix() {
        for (enabled, notify_when_focused, foreground, expected) in [
            (false, false, false, false),
            (false, false, true, false),
            (false, true, false, false),
            (false, true, true, false),
            (true, false, false, true),
            (true, false, true, false),
            (true, true, false, true),
            (true, true, true, true),
        ] {
            let settings = NotificationSettings {
                enabled,
                notify_when_focused,
            };
            assert_eq!(
                settings.should_notify(foreground),
                expected,
                "enabled={enabled}, notify_when_focused={notify_when_focused}, foreground={foreground}"
            );
        }
    }

    #[test]
    fn old_settings_default_to_background_only_without_rewriting_file() {
        let directory = TestDirectory::new();
        let path = directory.0.join("notifications.json");
        for enabled in [false, true] {
            let bytes = serde_json::to_vec(&json!({ "enabled": enabled })).unwrap();
            fs::write(&path, &bytes).unwrap();
            let settings = NotificationSettings::load(&directory.0).unwrap();
            assert_eq!(settings.enabled, enabled);
            assert!(!settings.notify_when_focused);
            assert_eq!(settings.should_notify(false), enabled);
            assert!(!settings.should_notify(true));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn settings_persist_both_flags_including_disabled_foreground_preference() {
        let directory = TestDirectory::new();
        for enabled in [false, true] {
            for notify_when_focused in [true, false] {
                let settings = NotificationSettings {
                    enabled,
                    notify_when_focused,
                };
                settings.save(&directory.0).unwrap();
                assert_eq!(NotificationSettings::load(&directory.0).unwrap(), settings);
                let persisted: Value = serde_json::from_slice(
                    &fs::read(directory.0.join("notifications.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(
                    persisted,
                    json!({ "enabled": enabled, "notify_when_focused": notify_when_focused })
                );
            }
        }
    }

    #[test]
    fn settings_reject_non_boolean_foreground_preference() {
        let directory = TestDirectory::new();
        for enabled in [false, true] {
            for invalid in [
                json!("true"),
                json!(1),
                json!(0),
                Value::Null,
                json!([]),
                json!({}),
            ] {
                let bytes = serde_json::to_vec(&json!({
                    "enabled": enabled,
                    "notify_when_focused": invalid,
                }))
                .unwrap();
                assert!(serde_json::from_slice::<NotificationSettings>(&bytes).is_err());
                fs::write(directory.0.join("notifications.json"), bytes).unwrap();
                assert!(NotificationSettings::load(&directory.0).is_err());
            }
        }
    }

    #[test]
    fn settings_missing_default_and_roundtrip_never_modify_main_config() {
        let directory = TestDirectory::new();
        assert_eq!(
            NotificationSettings::load(&directory.0).unwrap(),
            NotificationSettings::default()
        );
        fs::write(directory.0.join("config.json"), b"keep launcher config").unwrap();
        NotificationSettings {
            enabled: true,
            ..NotificationSettings::default()
        }
        .save(&directory.0)
        .unwrap();
        assert!(NotificationSettings::load(&directory.0).unwrap().enabled);
        NotificationSettings::default().save(&directory.0).unwrap();
        assert!(!NotificationSettings::load(&directory.0).unwrap().enabled);
        assert_eq!(
            fs::read(directory.0.join("config.json")).unwrap(),
            b"keep launcher config"
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn settings_corruption_and_oversize_fail_closed() {
        let directory = TestDirectory::new();
        for bytes in [
            b"broken".as_slice(),
            br#"{}"#,
            br#"{"enabled":"yes"}"#,
            br#"{"enabled":true,"extra":1}"#,
        ] {
            fs::write(directory.0.join("notifications.json"), bytes).unwrap();
            assert!(NotificationSettings::load(&directory.0).is_err());
        }
        fs::write(
            directory.0.join("notifications.json"),
            vec![b' '; SETTINGS_LIMIT as usize + 1],
        )
        .unwrap();
        assert!(NotificationSettings::load(&directory.0).is_err());
    }

    #[test]
    fn settings_failed_replacement_preserves_destination_and_cleans_temp() {
        let directory = TestDirectory::new();
        let destination = directory.0.join("notifications.json");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old"), b"keep").unwrap();
        assert!(NotificationSettings {
            enabled: true,
            ..NotificationSettings::default()
        }
        .save(&directory.0)
        .is_err());
        assert_eq!(fs::read(destination.join("old")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
