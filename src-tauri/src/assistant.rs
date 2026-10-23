//! Pure desktop assistant projection. No RPC, workspace registration, or chat persistence.
//! Wire contracts verified against Harness session-controller/types.ts, session/types.ts,
//! llm/assistant-stream.ts and client/sessions/assistant-stream.ts (2026-10-23).
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub enabled: bool,
    pub phase: String,
    pub message: String,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub sessions: Vec<SessionRow>,
    pub messages: Vec<Message>,
    pub running: bool,
    pub waiting: bool,
    pub connected: bool,
    pub revision: u64,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            phase: "disabled".into(),
            message: String::new(),
            workspace_id: None,
            session_id: None,
            workspace_path: None,
            sessions: vec![],
            messages: vec![],
            running: false,
            waiting: false,
            connected: false,
            revision: 0,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackendIdentity {
    pub distribution: String,
    pub user: String,
    pub origin: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub backend: BackendIdentity,
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub workspace_path: String,
    #[serde(default)]
    pub session_pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectionError(pub String);
impl fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ProjectionError {}
type Result<T> = std::result::Result<T, ProjectionError>;
fn bad(s: impl Into<String>) -> ProjectionError {
    ProjectionError(s.into())
}
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(format!("missing string {k}")))
}
fn number(v: &Value, k: &str) -> Result<i64> {
    v.get(k)
        .and_then(Value::as_i64)
        .filter(|n| *n >= -1 && *n <= 9_007_199_254_740_991)
        .ok_or_else(|| bad(format!("invalid integer {k}")))
}
fn text(content: &Value) -> String {
    content
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}
#[derive(Clone, Debug, Default)]
struct Attempt {
    id: String,
    turn: i64,
    step: i64,
    next: i64,
    blocks: BTreeMap<i64, String>,
    settled: bool,
}
impl Attempt {
    fn chunk(&mut self, c: &Value) -> Result<()> {
        match c["type"].as_str() {
            Some("text-delta") => {
                let i = number(c, "index")?;
                self.blocks
                    .entry(i)
                    .or_default()
                    .push_str(string(c, "text")?);
            }
            // A completed block is the authoritative replacement, not an additional delta.
            Some("block-end") if c["block"]["type"] == "text" => {
                self.blocks
                    .insert(number(c, "index")?, string(&c["block"], "text")?.into());
            }
            _ => {} // Never expose reasoning, tool arguments, private metadata or raw JSON.
        }
        Ok(())
    }
    fn compact(&mut self, records: &Value) -> Result<()> {
        for r in records
            .as_array()
            .ok_or_else(|| bad("stream must be an array"))?
        {
            match string(r, "type")? {
                "text-chunks" => {
                    let i = number(r, "index")?;
                    for t in r["texts"]
                        .as_array()
                        .ok_or_else(|| bad("texts must be an array"))?
                    {
                        self.blocks
                            .entry(i)
                            .or_default()
                            .push_str(t.as_str().ok_or_else(|| bad("invalid text member"))?);
                    }
                }
                "chunk" => self.chunk(&r["chunk"])?,
                "reasoning-chunks" | "tool-call-chunks" => {}
                _ => return Err(bad("unknown compact stream record")),
            }
        }
        Ok(())
    }
    fn text(&self) -> String {
        self.blocks.values().cloned().collect::<Vec<_>>().join("")
    }
}
#[derive(Clone, Debug, Default)]
pub struct Projection {
    snapshot: Snapshot,
    backend: Option<BackendIdentity>,
    cursor: Option<i64>,
    stream_revision: Option<i64>,
    attempt: Option<Attempt>,
    rows: Vec<(i64, Message)>,
    surface: Vec<i64>,
    question_calls: BTreeSet<String>,
    tools: BTreeMap<String, String>,
    settlements: BTreeMap<i64, String>,
}
impl Projection {
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }
    pub fn cursor(&self) -> Option<i64> {
        self.cursor
    }
    fn changed(&mut self) {
        self.snapshot.revision = self.snapshot.revision.saturating_add(1);
    }
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.snapshot.enabled != enabled {
            self.snapshot.enabled = enabled;
            self.changed();
        }
    }
    pub fn set_operation(&mut self, phase: &str, message: &str) {
        if self.snapshot.phase != phase || self.snapshot.message != message {
            self.snapshot.phase = phase.into();
            self.snapshot.message = message.into();
            self.changed();
        }
    }
    pub fn set_connection(&mut self, connected: bool, phase: &str, message: &str) {
        if self.snapshot.connected != connected {
            self.snapshot.connected = connected;
            self.changed();
        }
        self.set_operation(phase, message);
    }
    pub fn set_running(&mut self, running: bool) {
        if self.snapshot.running != running {
            self.snapshot.running = running;
            self.changed();
        }
    }
    pub fn set_waiting(&mut self, waiting: bool) {
        if self.snapshot.waiting != waiting {
            self.snapshot.waiting = waiting;
            self.changed();
        }
    }
    pub fn set_sessions(&mut self, sessions: Vec<SessionRow>) {
        if self.snapshot.sessions != sessions {
            self.snapshot.sessions = sessions;
            self.changed();
        }
    }
    /// Clears transcript/cursors only, preserving enablement, connection metadata and monotonic revision.
    pub fn reset(&mut self) {
        self.cursor = None;
        self.stream_revision = None;
        self.attempt = None;
        self.rows.clear();
        self.surface.clear();
        self.question_calls.clear();
        self.tools.clear();
        self.settlements.clear();
        self.snapshot.messages.clear();
        self.snapshot.running = false;
        self.snapshot.waiting = false;
        self.changed();
    }
    pub fn set_binding(&mut self, binding: Option<&Binding>) {
        let workspace = binding.map(|b| b.workspace_id.clone());
        let session = binding.and_then(|b| b.session_id.clone());
        let path = binding.map(|b| b.workspace_path.clone());
        let backend = binding.map(|b| b.backend.clone());
        if self.backend != backend
            || self.snapshot.workspace_id != workspace
            || self.snapshot.session_id != session
            || self.snapshot.workspace_path != path
        {
            self.reset();
            self.backend = backend;
            self.snapshot.workspace_id = workspace;
            self.snapshot.session_id = session;
            self.snapshot.workspace_path = path;
        }
    }
    /// Accept decoded session/follow frames (not the Remote transport envelope).
    /// Errors are transactional: caller should reconnect for a fresh opening snapshot.
    /// Returns false for duplicate durable seq / stream revision, true for accepted frames.
    pub fn apply_frame(&mut self, frame: &Value) -> Result<bool> {
        let mut next = self.clone();
        let accepted = next.apply(frame)?;
        if accepted {
            next.refresh();
            next.changed();
            *self = next;
        }
        Ok(accepted)
    }
    fn refresh(&mut self) {
        self.snapshot.messages = self.rows.iter().map(|(_, m)| m.clone()).collect();
        if let Some(a) = &self.attempt {
            if !a.settled && !a.text().is_empty() {
                self.snapshot.messages.push(Message {
                    id: format!("stream:{}", a.id),
                    role: "assistant".into(),
                    text: a.text(),
                    status: Some("streaming".into()),
                    request_id: None,
                });
            }
        }
        self.snapshot.waiting = !self.question_calls.is_empty();
        if self.snapshot.waiting {
            self.snapshot.message = "请在 DSH 中回答待处理问题".into();
        } else if self.snapshot.message == "请在 DSH 中回答待处理问题" {
            self.snapshot.message.clear();
        }
    }
    fn apply(&mut self, f: &Value) -> Result<bool> {
        match string(f, "type")? {
            "snapshot" => {
                let cursor = number(f, "cursor")?;
                let id = string(&f["header"], "id")?;
                if self.snapshot.session_id.as_deref().is_some_and(|s| s != id) {
                    return Err(bad("snapshot session does not match binding"));
                }
                self.reset();
                self.snapshot.session_id = Some(id.into());
                if let Some(path) = f["header"]["cwd"].as_str() {
                    self.snapshot.workspace_path = Some(path.into());
                }
                let records = f["records"]
                    .as_array()
                    .ok_or_else(|| bad("records must be an array"))?;
                let mut previous = None;
                for r in records {
                    if r["type"] != "event" {
                        return Err(bad("invalid snapshot record"));
                    }
                    let seq = number(&r["event"], "seq")?;
                    if seq < 0 || seq > cursor || previous.is_some_and(|p| seq != p + 1) {
                        return Err(bad("snapshot records are not contiguous within cursor"));
                    }
                    self.event(&r["event"])?;
                    previous = Some(seq);
                }
                if previous.is_some_and(|p| p != cursor) {
                    return Err(bad("snapshot tail does not match cursor"));
                }
                self.cursor = Some(cursor);
                self.snapshot.connected = true;
                let values = &f["projections"]["values"];
                if let Some(boundary) = values.get("turnBoundary") {
                    self.snapshot.running = !boundary["openTurnStartSeq"].is_null();
                }
                if let Some(active) = values["userQuestions"]["active"].as_array() {
                    self.question_calls = active
                        .iter()
                        .filter_map(|q| q["callId"].as_str().map(str::to_owned))
                        .collect();
                }
                if let Some(b) = f.get("assistantStream") {
                    self.stream_revision = Some(number(b, "revision")?);
                    if let Some(a) = b.get("activeAttempt") {
                        let mut attempt = Attempt {
                            id: string(a, "attemptId")?.into(),
                            turn: number(a, "turn")?,
                            step: number(a, "step")?,
                            next: number(a, "nextIndex")?,
                            ..Default::default()
                        };
                        attempt.compact(&a["stream"])?;
                        self.attempt = Some(attempt);
                        self.snapshot.running = true;
                    }
                }
                Ok(true)
            }
            "event" => {
                let seq = number(&f["event"], "seq")?;
                let cursor = self
                    .cursor
                    .ok_or_else(|| bad("event before opening snapshot"))?;
                if seq <= cursor {
                    return Ok(false);
                }
                if seq != cursor + 1 {
                    return Err(bad(format!(
                        "durable sequence gap: expected {}, got {seq}",
                        cursor + 1
                    )));
                }
                self.event(&f["event"])?;
                self.cursor = Some(seq);
                Ok(true)
            }
            "assistant-stream" => self.stream(&f["frame"]),
            _ => Err(bad("unknown session follow frame")),
        }
    }
    fn event(&mut self, e: &Value) -> Result<()> {
        let seq = number(e, "seq")?;
        let kind = string(e, "type")?;
        let d = &e["data"];
        // Surface order differs from seq order after replacements. Include hidden system/developer
        // nodes so their endpoints can remove visible rows without leaking their contents.
        let mut insert_at = None;
        if e["surfaceOp"]["op"] == "replace" {
            let start = number(&e["surfaceOp"], "startSeq")?;
            let end = number(&e["surfaceOp"], "endSeq")?;
            let first = self.surface.iter().position(|s| *s == start);
            let last = self.surface.iter().position(|s| *s == end);
            // A message-aligned opening window may omit an endpoint in its older prefix.
            if first.is_some() || last.is_some() {
                let a = first.unwrap_or(0);
                let b = last.unwrap_or(self.surface.len() - 1);
                if a > b {
                    return Err(bad("reversed surface replacement"));
                }
                let removed: BTreeSet<_> = self.surface[a..=b].iter().copied().collect();
                insert_at = self.rows.iter().position(|(s, _)| removed.contains(s));
                self.rows.retain(|(s, _)| !removed.contains(s));
                self.surface.splice(a..=b, [seq]);
            } else {
                self.surface.push(seq);
            }
        } else if matches!(
            kind,
            "user/message"
                | "assistant/message"
                | "tool/result"
                | "developer/message"
                | "system/message"
        ) {
            self.surface.push(seq);
        }
        let mut row = None;
        match kind {
            "turn/start" | "step/start" => {
                self.snapshot.running = true;
            }
            "turn/end" => {
                self.snapshot.running = false;
                let reason = d["reason"]["kind"].as_str().unwrap_or("completed");
                self.snapshot.phase = reason.into();
                if let Some(a) = self.attempt.take() {
                    if !a.settled && !a.text().is_empty() {
                        self.rows.push((
                            seq,
                            Message {
                                id: format!("stream:{}", a.id),
                                role: "assistant".into(),
                                text: a.text(),
                                status: Some(reason.into()),
                                request_id: None,
                            },
                        ));
                    }
                }
                for (_, m) in &mut self.rows {
                    if m.status.as_deref() == Some("running") {
                        m.status = Some(reason.into());
                    }
                }
            }
            "user/message" => {
                if d["source"]["kind"] == "user-question-reply" {
                    if let Some(id) = d["source"]["callId"].as_str() {
                        self.question_calls.remove(id);
                    }
                }
                // Synthetic injected instructions are not human chat and can contain private context.
                if d["source"]["kind"] == "user" || d["source"]["kind"] == "user-question-reply" {
                    row = Some(Message {
                        id: string(d, "id")?.into(),
                        role: "user".into(),
                        text: text(&d["content"]),
                        status: None,
                        request_id: d["source"]["rpcId"].as_str().map(str::to_owned),
                    });
                }
            }
            "assistant/message" | "assistant/attempt" => {
                if let Some(a) = &mut self.attempt {
                    if a.turn == number(d, "turn")? && a.step == number(d, "step")? {
                        a.settled = true;
                        self.settlements.insert(seq, kind.into());
                    }
                }
                if kind == "assistant/message" {
                    let m = &d["message"];
                    row = Some(Message {
                        id: string(m, "id")?.into(),
                        role: "assistant".into(),
                        text: text(&m["content"]),
                        request_id: None,
                        status: Some(
                            if d["interrupted"] == true {
                                "interrupted"
                            } else {
                                "completed"
                            }
                            .into(),
                        ),
                    });
                }
            }
            "tool/call" => {
                let id = string(d, "callId")?.to_owned();
                self.tools.insert(id.clone(), string(d, "name")?.into());
                if d["name"] == "ask_user_question" {
                    self.question_calls.insert(id.clone());
                }
                row = Some(Message {
                    id: format!("tool:{id}"),
                    // Frontend AssistantMessage accepts user/assistant/system only.
                    role: "system".into(),
                    text: "工具执行中".into(),
                    status: Some("running".into()),
                    request_id: None,
                });
            }
            "tool/result" => {
                let m = &d["message"];
                let id = string(m, "toolCallId")?;
                let pending = serde_json::from_str::<Value>(&text(&m["content"]))
                    .ok()
                    .is_some_and(|p| p["pending"] == true)
                    || d["error"]["code"] == "TOOL_OUTCOME_UNKNOWN";
                if !pending {
                    self.question_calls.remove(id);
                }
                if let Some((_, r)) = self
                    .rows
                    .iter_mut()
                    .find(|(_, r)| r.id == format!("tool:{id}"))
                {
                    r.status = Some(
                        if pending {
                            "waiting"
                        } else if m["isError"] == true {
                            "failed"
                        } else {
                            "completed"
                        }
                        .into(),
                    );
                    r.text = if pending {
                        "请在 DSH 中处理待答问题"
                    } else {
                        "工具执行结束"
                    }
                    .into();
                }
            }
            "tool/ptc-dispatch" if d["name"] == "ask_user_question" => {
                let pending = serde_json::from_str::<Value>(&text(&d["content"]))
                    .ok()
                    .is_some_and(|p| p["pending"] == true);
                if pending && d["isError"] != true {
                    self.question_calls.insert(string(d, "subCallId")?.into());
                }
            }
            _ => {} // Merge-extensible durable events still advance the seq cursor.
        }
        if let Some(row) = row {
            if let Some(i) = self.rows.iter().position(|(_, r)| r.id == row.id) {
                self.rows[i] = (seq, row);
            } else if let Some(i) = insert_at {
                self.rows.insert(i, (seq, row));
            } else {
                self.rows.push((seq, row));
            }
        }
        Ok(())
    }
    fn stream(&mut self, f: &Value) -> Result<bool> {
        if self.cursor.is_none() {
            return Err(bad("stream before opening snapshot"));
        }
        let revision = number(f, "revision")?;
        let previous = self.stream_revision.unwrap_or(0);
        if revision <= previous {
            return Ok(false);
        }
        if revision != previous + 1 {
            return Err(bad(format!(
                "assistant revision gap: expected {}, got {revision}",
                previous + 1
            )));
        }
        let kind = string(f, "type")?;
        let id = string(f, "attemptId")?;
        match kind {
            "start" => {
                if self.attempt.is_some() {
                    return Err(bad("start while attempt active"));
                }
                if number(f, "startedAfterSeq")? > self.cursor.unwrap() {
                    return Err(bad("attempt ahead of durable cursor"));
                }
                self.attempt = Some(Attempt {
                    id: id.into(),
                    turn: number(f, "turn")?,
                    step: number(f, "step")?,
                    ..Default::default()
                });
                self.snapshot.running = true;
            }
            "chunk" | "end" => {
                if let Some(a) = self.attempt.as_mut().filter(|a| a.id == id) {
                    if number(f, "index")? != a.next {
                        return Err(bad("assistant chunk index gap"));
                    }
                    if kind == "chunk" {
                        a.chunk(&f["chunk"])?;
                        a.next += 1;
                    } else {
                        match string(&f["outcome"], "kind")? {
                            "committed" => {
                                let seq = number(&f["outcome"], "seq")?;
                                if self.settlements.get(&seq).map(String::as_str)
                                    != Some(string(&f["outcome"], "eventType")?)
                                {
                                    return Err(bad(
                                        "stream settlement missing matching durable event",
                                    ));
                                }
                            }
                            "abandoned" => {
                                if a.settled {
                                    return Err(bad("abandoned attempt already committed"));
                                }
                            }
                            _ => return Err(bad("unknown assistant outcome")),
                        }
                        self.attempt = None;
                    }
                } // Unknown transient suffix cannot reconstruct content; durable settlement remains authoritative.
            }
            _ => return Err(bad("unknown assistant stream frame")),
        }
        self.stream_revision = Some(revision);
        Ok(true)
    }
}

/// The on-disk format deliberately has no transcript or prompt field.
#[derive(Clone, Debug)]
pub struct BindingStore {
    path: PathBuf,
}
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
impl BindingStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn load(&self) -> io::Result<Option<Binding>> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn save(&self, binding: &Binding) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(binding).map_err(io::Error::other)?;
        if fs::read(&self.path).ok().as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        let parent = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let temp = parent.join(format!(
            ".assistant-binding-{}-{}.tmp",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            atomic_replace(&temp, &self.path)?;
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
    pub fn clear(&self) -> io::Result<()> {
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }
}
#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}
#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // REPLACE_EXISTING | WRITE_THROUGH: never delete the destination before renaming.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn event(seq: i64, kind: &str, data: Value) -> Value {
        json!({"type":"event","event":{"type":kind,"seq":seq,"time":10,"data":data,"surfaceOp":"append"}})
    }
    fn opening(records: Vec<Value>, cursor: i64) -> Value {
        json!({"type":"snapshot","header":{"id":"s1","version":4,"createdAt":1,"isSeeded":false,"cwd":"/work"},"cursor":cursor,"records":records,"hasMore":false,"projections":{"asOfSeq":cursor,"values":{}},"assistantStream":{"revision":0}})
    }
    fn stream(frame: Value) -> Value {
        json!({"type":"assistant-stream","frame":frame})
    }
    fn user(id: &str, t: &str) -> Value {
        json!({"id":id,"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":t}]})
    }
    fn assistant(id: &str, t: &str) -> Value {
        json!({"turn":1,"step":0,"message":{"id":id,"role":"assistant","source":{"kind":"model"},"content":[{"type":"text","text":t}]},"stream":[]})
    }
    fn start() -> Value {
        stream(
            json!({"type":"start","attemptId":"a1","revision":1,"startedAfterSeq":-1,"turn":1,"step":0}),
        )
    }
    fn chunk(revision: i64, index: i64, t: &str) -> Value {
        stream(
            json!({"type":"chunk","attemptId":"a1","revision":revision,"index":index,"time":12,"chunk":{"type":"text-delta","index":0,"text":t}}),
        )
    }
    #[test]
    fn opening_durable_replay_and_gap_are_transactional() {
        let mut p = Projection::default();
        let first = event(0, "user/message", user("u1", "你好"));
        p.apply_frame(&opening(vec![first.clone()], 0)).unwrap();
        let before = p.snapshot();
        assert!(!p.apply_frame(&first).unwrap());
        assert_eq!(p.snapshot(), before);
        assert!(p
            .apply_frame(&event(2, "turn/start", json!({"turn":1})))
            .is_err());
        assert_eq!(p.snapshot(), before);
        p.apply_frame(&event(1, "turn/start", json!({"turn":1})))
            .unwrap();
        assert!(p.snapshot().running);
        p.apply_frame(&event(2, "assistant/message", assistant("m1", "答复")))
            .unwrap();
        p.apply_frame(&event(
            3,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"completed"}}),
        ))
        .unwrap();
        assert!(!p.snapshot().running);
        assert_eq!(p.snapshot().messages.len(), 2);
    }
    #[test]
    fn stream_increment_block_replacement_and_durable_dedup() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        p.apply_frame(&start()).unwrap();
        p.apply_frame(&chunk(2, 0, "hel")).unwrap();
        p.apply_frame(&chunk(3, 1, "lo")).unwrap();
        assert_eq!(p.snapshot().messages[0].text, "hello");
        p.apply_frame(&stream(json!({"type":"chunk","attemptId":"a1","revision":4,"index":2,"time":12,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"hello!"}}}))).unwrap();
        assert_eq!(p.snapshot().messages[0].text, "hello!");
        p.apply_frame(&event(0, "assistant/message", assistant("m1", "hello!")))
            .unwrap();
        assert_eq!(p.snapshot().messages.len(), 1);
        assert_eq!(p.snapshot().messages[0].id, "m1");
        p.apply_frame(&stream(json!({"type":"end","attemptId":"a1","revision":5,"index":3,"outcome":{"kind":"committed","eventType":"assistant/message","seq":0}}))).unwrap();
        assert_eq!(p.snapshot().messages.len(), 1);
        assert!(p.snapshot().running);
        p.apply_frame(&event(
            1,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"completed"}}),
        ))
        .unwrap();
        assert!(!p.snapshot().running);
    }
    #[test]
    fn reconnect_compact_baseline_replaces_not_appends() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        p.apply_frame(&start()).unwrap();
        p.apply_frame(&chunk(2, 0, "old")).unwrap();
        let mut baseline = opening(vec![], -1);
        baseline["assistantStream"] = json!({"revision":9,"activeAttempt":{"attemptId":"a2","startedAfterSeq":-1,"turn":2,"step":0,"nextIndex":4,"stream":[{"type":"text-chunks","time0":1,"index":0,"dt":[1],"texts":["new"," text"]},{"type":"tool-call-chunks","time0":2,"index":1,"dt":[],"id":"tool1","name":"bash","args":["SECRET"]},{"type":"chunk","time":3,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"new text!"}}}]}});
        p.apply_frame(&baseline).unwrap();
        assert_eq!(p.snapshot().messages.len(), 1);
        assert_eq!(p.snapshot().messages[0].text, "new text!");
        p.apply_frame(&stream(json!({"type":"chunk","attemptId":"a2","revision":10,"index":4,"time":5,"chunk":{"type":"text-delta","index":2,"text":"more"}}))).unwrap();
        assert_eq!(p.snapshot().messages[0].text, "new text!more");
        p.apply_frame(&opening(vec![], -1)).unwrap();
        assert!(p.snapshot().messages.is_empty());
    }
    #[test]
    fn stream_gaps_and_missing_settlement_do_not_mutate() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        p.apply_frame(&start()).unwrap();
        let before = p.snapshot();
        assert!(p.apply_frame(&chunk(3, 0, "bad")).is_err());
        assert_eq!(before, p.snapshot());
        assert!(p.apply_frame(&chunk(2, 1, "bad")).is_err());
        assert_eq!(before, p.snapshot());
        assert!(p.apply_frame(&stream(json!({"type":"end","attemptId":"a1","revision":2,"index":0,"outcome":{"kind":"committed","eventType":"assistant/message","seq":0}}))).is_err());
        assert_eq!(before, p.snapshot());
        p.apply_frame(&chunk(2, 0, "ok")).unwrap();
        let before = p.snapshot();
        assert!(!p.apply_frame(&chunk(2, 0, "ok")).unwrap());
        assert_eq!(before, p.snapshot());
    }
    #[test]
    fn abandoned_and_failed_attempts_do_not_become_chat_messages() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        p.apply_frame(&start()).unwrap();
        p.apply_frame(&chunk(2, 0, "discard me")).unwrap();
        p.apply_frame(&stream(json!({"type":"end","attemptId":"a1","revision":3,"index":1,"outcome":{"kind":"abandoned"}}))).unwrap();
        assert!(p.snapshot().messages.is_empty());
        p.apply_frame(&event(
            0,
            "assistant/attempt",
            json!({"turn":1,"step":0,"stream":[]}),
        ))
        .unwrap();
        assert!(p.snapshot().messages.is_empty());
    }
    #[test]
    fn interrupted_message_and_turn_terminal_fixtures() {
        for reason in [
            "aborted",
            "error",
            "interrupted",
            "blocked",
            "max-tokens",
            "forked",
        ] {
            let mut p = Projection::default();
            p.apply_frame(&opening(vec![], -1)).unwrap();
            p.apply_frame(&start()).unwrap();
            p.apply_frame(&chunk(2, 0, "partial")).unwrap();
            let mut d = assistant("m1", "partial");
            d["interrupted"] = json!(true);
            p.apply_frame(&event(0, "assistant/message", d)).unwrap();
            p.apply_frame(&stream(json!({"type":"end","attemptId":"a1","revision":3,"index":1,"outcome":{"kind":"committed","eventType":"assistant/message","seq":0}}))).unwrap();
            p.apply_frame(&event(
                1,
                "turn/end",
                json!({"turn":1,"reason":{"kind":reason}}),
            ))
            .unwrap();
            assert!(!p.snapshot().running);
            assert_eq!(p.snapshot().phase, reason);
            assert_eq!(
                p.snapshot().messages[0].status.as_deref(),
                Some("interrupted")
            );
        }
    }
    /// Cross-language regression: feed REAL serialized Rust snapshots to the actual
    /// TypeScript mergeSnapshot consumer, not a second Rust imitation of its validator.
    #[test]
    fn projected_roles_are_accepted_by_actual_frontend_consumer() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        let mut snapshots = vec![p.snapshot()];
        for frame in [
            event(0, "user/message", user("u1", "hello")),
            event(1, "assistant/message", assistant("a1", "checking")),
            event(
                2,
                "tool/call",
                json!({"turn":1,"step":0,"callId":"c1","name":"bash","arguments":"SECRET"}),
            ),
            event(
                3,
                "tool/result",
                json!({"turn":1,"step":0,"message":{"toolCallId":"c1","isError":false,"content":[{"type":"text","text":"SECRET RESULT"}]}}),
            ),
            event(
                4,
                "tool/call",
                json!({"turn":1,"step":1,"callId":"c2","name":"ask_user_question","arguments":"SECRET QUESTION"}),
            ),
            event(
                5,
                "tool/result",
                json!({"turn":1,"step":1,"message":{"toolCallId":"c2","isError":false,"content":[{"type":"text","text":"{\"pending\":true}"}]}}),
            ),
            event(
                6,
                "turn/end",
                json!({"turn":1,"reason":{"kind":"completed"}}),
            ),
        ] {
            p.apply_frame(&frame).unwrap();
            snapshots.push(p.snapshot());
        }
        for snapshot in &snapshots {
            assert!(snapshot
                .messages
                .iter()
                .all(|message| matches!(message.role.as_str(), "user" | "assistant" | "system")));
        }
        let script = r#"
            import assert from 'node:assert/strict';
            import { pathToFileURL } from 'node:url';
            const {mergeSnapshot,initialSnapshot}=await import(pathToFileURL(process.argv[1]).href);
            let state=initialSnapshot();
            for (const snapshot of JSON.parse(process.argv[2])) {
                state=mergeSnapshot(state,snapshot);
                assert.equal(state.revision,snapshot.revision,'actual frontend rejected a projected snapshot');
                assert.deepEqual(state.messages,snapshot.messages);
            }
            assert.ok(state.messages.some(message=>message.role==='system'));
            assert.ok(!JSON.stringify(state).includes('SECRET'));
        "#;
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/assistant-model.ts");
        let output = std::process::Command::new("node")
            .args([
                "--experimental-strip-types",
                "--input-type=module",
                "-e",
                script,
            ])
            .arg(source)
            .arg(serde_json::to_string(&snapshots).unwrap())
            .output()
            .expect("cross-language contract test requires the project's Node.js toolchain");
        assert!(
            output.status.success(),
            "actual frontend contract failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn tools_are_redacted_and_waiting_survives_pending_result() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        p.apply_frame(&event(0,"tool/call",json!({"turn":1,"step":0,"callId":"c1","name":"ask_user_question","arguments":"SECRET_ARGS"}))).unwrap();
        assert!(p.snapshot().waiting);
        p.apply_frame(&event(1,"tool/result",json!({"turn":1,"step":0,"message":{"toolCallId":"c1","isError":false,"content":[{"type":"text","text":"{\"pending\":true}"}]},"meta":{"token":"SECRET_META"}}))).unwrap();
        assert!(p.snapshot().waiting);
        p.apply_frame(&event(
            2,
            "turn/end",
            json!({"turn":1,"reason":{"kind":"completed"}}),
        ))
        .unwrap();
        assert!(p.snapshot().waiting);
        assert!(!p.snapshot().running);
        let mut reply = user("u2", "回答");
        reply["source"] = json!({"kind":"user-question-reply","callId":"c1"});
        p.apply_frame(&event(3, "user/message", reply)).unwrap();
        assert!(!p.snapshot().waiting);
        assert!(!serde_json::to_string(&p.snapshot())
            .unwrap()
            .contains("SECRET"));
    }
    #[test]
    fn snapshot_projections_are_authoritative_even_for_truncated_window() {
        let mut p = Projection::default();
        let mut f = opening(vec![event(8, "step/end", json!({"turn":1,"step":0}))], 8);
        f["hasMore"] = json!(true);
        f["projections"]["values"] = json!({"turnBoundary":{"openTurnStartSeq":2},"userQuestions":{"active":[{"callId":"q1","questions":[{"question":"SECRET"}]}],"settled":[]}});
        p.apply_frame(&f).unwrap();
        assert!(p.snapshot().waiting);
        assert!(p.snapshot().running);
        assert!(p.snapshot().messages.is_empty());
    }
    #[test]
    fn disconnect_and_binding_reset_keep_revision_monotonic() {
        let mut p = Projection::default();
        let mut b = binding();
        p.set_binding(Some(&b));
        p.set_enabled(true);
        p.apply_frame(&opening(
            vec![event(0, "user/message", user("u1", "chat"))],
            0,
        ))
        .unwrap();
        let old = p.snapshot();
        p.set_connection(false, "disconnected", "offline");
        assert_eq!(old.messages, p.snapshot().messages);
        assert!(p.snapshot().revision > old.revision);
        let rev = p.snapshot().revision;
        p.set_binding(Some(&b));
        assert_eq!(p.snapshot().revision, rev);
        b.backend.user = "another".into();
        p.set_binding(Some(&b));
        assert!(p.snapshot().messages.is_empty());
        assert!(p.snapshot().revision > rev);
        let rev = p.snapshot().revision;
        p.reset();
        assert!(p.snapshot().revision > rev);
    }
    fn binding() -> Binding {
        Binding {
            backend: BackendIdentity {
                distribution: "Ubuntu".into(),
                user: "alice".into(),
                origin: "http://127.0.0.1:3080".into(),
            },
            workspace_id: "w1".into(),
            session_id: Some("s1".into()),
            workspace_path: "/work".into(),
            session_pending: true,
        }
    }
    #[test]
    fn surface_replacements_follow_surface_order_including_hidden_nodes() {
        let mut p = Projection::default();
        p.apply_frame(&opening(
            vec![
                event(0, "user/message", user("u0", "first")),
                event(1, "assistant/message", assistant("m1", "second")),
                event(2, "user/message", user("u2", "third")),
            ],
            2,
        ))
        .unwrap();
        let mut replacement = event(3, "user/message", user("u3", "replacement"));
        replacement["event"]["surfaceOp"] = json!({"op":"replace","startSeq":0,"endSeq":0});
        p.apply_frame(&replacement).unwrap();
        // Current surface is [3,1,2], not sorted numeric seq order.
        let mut replacement = event(4, "user/message", user("u4", "all"));
        replacement["event"]["surfaceOp"] = json!({"op":"replace","startSeq":3,"endSeq":2});
        p.apply_frame(&replacement).unwrap();
        assert_eq!(p.snapshot().messages.len(), 1);
        assert_eq!(p.snapshot().messages[0].text, "all");
        p.apply_frame(&event(5,"developer/message",json!({"turn":1,"step":0,"message":{"id":"hidden","content":[{"type":"text","text":"SECRET"}]}}))).unwrap();
        p.apply_frame(&event(6, "user/message", user("u6", "visible")))
            .unwrap();
        let mut replacement = event(7, "user/message", user("u7", "new"));
        replacement["event"]["surfaceOp"] = json!({"op":"replace","startSeq":5,"endSeq":6});
        p.apply_frame(&replacement).unwrap();
        assert_eq!(
            p.snapshot()
                .messages
                .iter()
                .map(|m| m.text.as_str())
                .collect::<Vec<_>>(),
            ["all", "new"]
        );
    }
    #[test]
    fn invalid_opening_is_transactional_and_empty_opening_connects() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        assert!(p.snapshot().connected);
        let before = p.snapshot();
        assert!(p
            .apply_frame(&opening(
                vec![
                    event(0, "turn/start", json!({"turn":1})),
                    event(2, "step/start", json!({"turn":1,"step":0}))
                ],
                2
            ))
            .is_err());
        assert_eq!(p.snapshot(), before);
        let mut wrong = opening(vec![], -1);
        wrong["header"]["id"] = json!("other-session");
        assert!(p.apply_frame(&wrong).is_err());
        assert_eq!(p.snapshot(), before);
    }
    #[test]
    fn user_confirmation_uses_exact_rpc_id_not_matching_text() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        let mut first = user("u1", "same text");
        first["source"]["rpcId"] = json!("from-other-ui");
        let mut second = user("u2", "same text");
        second["source"]["rpcId"] = json!("local-request-1");
        p.apply_frame(&event(0, "user/message", first)).unwrap();
        p.apply_frame(&event(1, "user/message", second)).unwrap();
        assert_eq!(
            p.snapshot().messages[0].request_id.as_deref(),
            Some("from-other-ui")
        );
        assert_eq!(
            p.snapshot().messages[1].request_id.as_deref(),
            Some("local-request-1")
        );
        let value = serde_json::to_value(&p.snapshot()).unwrap();
        assert_eq!(value["messages"][1]["request_id"], "local-request-1");
    }
    #[test]
    fn ordinary_streaming_does_not_overwrite_send_operation_status() {
        let mut p = Projection::default();
        p.apply_frame(&opening(vec![], -1)).unwrap();
        p.set_operation("uncertain", "结果未知，勿重复发送");
        p.apply_frame(&start()).unwrap();
        p.apply_frame(&chunk(2, 0, "reply")).unwrap();
        assert_eq!(p.snapshot().phase, "uncertain");
        assert_eq!(p.snapshot().message, "结果未知，勿重复发送");
    }
    #[test]
    fn binding_store_roundtrip_idempotent_atomic_replace_and_no_chat() {
        let dir = std::env::temp_dir().join(format!(
            "assistant-test-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let store = BindingStore::new(dir.join("binding.json"));
        assert_eq!(store.load().unwrap(), None);
        let mut b = binding();
        store.save(&b).unwrap();
        assert_eq!(store.load().unwrap(), Some(b.clone()));
        let modified = fs::metadata(&store.path).unwrap().modified().unwrap();
        store.save(&b).unwrap();
        assert_eq!(
            modified,
            fs::metadata(&store.path).unwrap().modified().unwrap()
        );
        b.session_pending = false;
        b.session_id = Some("s2".into());
        store.save(&b).unwrap();
        assert_eq!(store.load().unwrap(), Some(b.clone()));
        let value: Value = serde_json::from_slice(&fs::read(&store.path).unwrap()).unwrap();
        assert!(value.get("messages").is_none());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let mut legacy = serde_json::to_value(&b).unwrap();
        legacy.as_object_mut().unwrap().remove("session_pending");
        assert!(
            !serde_json::from_value::<Binding>(legacy)
                .unwrap()
                .session_pending
        );
        fs::write(&store.path, b"malformed").unwrap();
        assert_eq!(store.load().unwrap_err().kind(), io::ErrorKind::InvalidData);
        store.clear().unwrap();
        store.clear().unwrap();
        fs::remove_dir(&dir).unwrap();
    }
}
