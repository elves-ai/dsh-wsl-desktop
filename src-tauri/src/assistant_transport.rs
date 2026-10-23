//! Credential-safe, explicitly allowlisted native assistant transport.
//!
//! Unary RPCs use blocking HTTP. Current Harness streams are *not* HTTP/NDJSON:
//! they use /api/remote.mux WebSocket. session_follow opens only session/follow
//! and does not become a UI answerer. Explicit interaction_events opens $events
//! and grants this client the ability to answer pending interactive waterfalls.
//! Closing it withdraws this delivery, not the tool or Turn. No results are replayed.
//! Reconnect callers must replace their state from the new opening snapshot;
//! follow has no resume cursor in the current protocol. No prompts are retried.
//! Following an ordinary persisted Session can promote its Agent after opening;
//! callers should subscribe only to their dedicated assistant Session.

use reqwest::header::{HeaderValue, CONTENT_TYPE, COOKIE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message, WebSocket};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT: usize = 1024 * 1024;
const POLL: Duration = Duration::from_millis(250);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Deliberately contains no URL, cookie, response body or remote error message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidOrigin,
    InvalidCookie,
    InvalidArgument,
    Transport,
    Authentication,
    Http(u16),
    Protocol,
    TooLarge,
    Rpc,
    Cancelled,
    UnexpectedEnd,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidOrigin => "助手服务地址未通过安全校验。",
            Self::InvalidCookie => "助手认证信息未通过安全校验。",
            Self::InvalidArgument => "助手请求参数无效。",
            Self::Transport => "助手连接失败或超时。",
            Self::Authentication => "助手认证已失效，请在 DSH 工作窗口重新登录。",
            Self::Http(_) => "助手服务未返回成功状态。",
            Self::Protocol => "助手服务响应协议无效。",
            Self::TooLarge => "助手服务响应或帧超过大小限制。",
            Self::Rpc => "助手服务未能完成请求。",
            Self::Cancelled => "助手订阅已取消。",
            Self::UnexpectedEnd => "助手订阅意外断开，请重新连接。",
        })
    }
}
impl std::error::Error for Error {}

// No Debug: credentials must never be printed by accident.
pub struct Client {
    http: reqwest::blocking::Client,
    origin: String,
    port: u16,
    cookie: Option<HeaderValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "rpcId")]
    rpc_id: String,
    result: Value,
}

impl Client {
    pub fn new(origin: &str, cookie: String) -> Result<Self, Error> {
        // Validate spelling before URL parsing can normalize userinfo, encoded
        // paths, alternate IPv4 syntax, DNS names or whitespace.
        let root = origin.strip_suffix('/').unwrap_or(origin);
        let text = root
            .strip_prefix("http://127.0.0.1:")
            .ok_or(Error::InvalidOrigin)?;
        if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::InvalidOrigin);
        }
        let port: u16 = text.parse().map_err(|_| Error::InvalidOrigin)?;
        if port == 0 || port.to_string() != text {
            return Err(Error::InvalidOrigin);
        }
        if cookie.len() > 16 * 1024
            || cookie
                .bytes()
                .any(|b| b < 0x20 || b == 0x7f || !b.is_ascii())
        {
            return Err(Error::InvalidCookie);
        }
        let cookie = if cookie.is_empty() {
            None
        } else {
            let mut header = HeaderValue::from_str(&cookie).map_err(|_| Error::InvalidCookie)?;
            header.set_sensitive(true);
            Some(header)
        };
        let http = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| Error::Transport)?;
        Ok(Self {
            http,
            origin: root.to_owned(),
            port,
            cookie,
        })
    }

    /// The current protocol has no workspace/list: take workspace/follow's
    /// opening baseline.value, then cancel. Returns {items, archivedSessionIds,
    /// pinnedSessionIds}. The opening baseline must arrive within 3 seconds.
    pub fn workspace_list(&self) -> Result<Value, Error> {
        let cancel = AtomicBool::new(false);
        let mut baseline = None;
        self.stream(
            "workspace/follow",
            json!({}),
            &cancel,
            Some(Duration::from_secs(3)),
            |v| {
                baseline = Some(v);
                false
            },
        )?;
        let frame = baseline.ok_or(Error::Protocol)?;
        if frame["type"] != "baseline"
            || !frame["value"]["items"].is_array()
            || !frame["value"]["archivedSessionIds"].is_array()
            || !frame["value"]["pinnedSessionIds"].is_array()
        {
            return Err(Error::Protocol);
        }
        Ok(frame["value"].clone())
    }
    pub fn workspace_create(&self, path: &str) -> Result<Value, Error> {
        valid_text(path, 32768)?;
        self.call("workspace/create", json!({"request":{"path":path}}))
    }
    pub fn workspace_rename(&self, id: &str, title: &str) -> Result<Value, Error> {
        valid_id(id)?;
        valid_text(title, 1024)?;
        self.call(
            "workspace/rename",
            json!({"request":{"workspaceId":id,"title":title}}),
        )
    }
    pub fn session_list(&self) -> Result<Value, Error> {
        self.call("session/list", json!({"_request":{}}))
    }
    pub fn session_create(
        &self,
        workspace_id: &str,
        session_id: Option<&str>,
    ) -> Result<Value, Error> {
        valid_id(workspace_id)?;
        let mut request = json!({"workspaceId":workspace_id});
        if let Some(id) = session_id {
            valid_id(id)?;
            request["sessionId"] = json!(id);
        }
        self.call("session/create", json!({"request":request}))
    }
    pub fn session_page(
        &self,
        id: &str,
        through_seq: i64,
        before_seq: Option<i64>,
        max_messages: u32,
    ) -> Result<Value, Error> {
        valid_id(id)?;
        if !(-1..=9_007_199_254_740_990).contains(&through_seq)
            || before_seq.is_some_and(|s| s < 0 || s > through_seq + 1)
            || !(1..=1000).contains(&max_messages)
        {
            return Err(Error::InvalidArgument);
        }
        let mut request = json!({"address":{"kind":"session","sessionId":id},"throughSeq":through_seq,"maxMessages":max_messages});
        if let Some(seq) = before_seq {
            request["beforeSeq"] = json!(seq);
        }
        self.call("session/page", json!({"request":request}))
    }
    /// Text-only queue admission. request_id is minted by the caller and must
    /// remain stable for reconciliation. This operation is never auto-retried.
    pub fn session_prompt(
        &self,
        id: &str,
        request_id: &str,
        text: &str,
        client_time_zone: Option<&str>,
    ) -> Result<Value, Error> {
        valid_id(id)?;
        valid_id(request_id)?;
        if text.trim().is_empty() || text.len() > MAX_PROMPT || text.contains('\0') {
            return Err(Error::InvalidArgument);
        }
        let mut request = json!({"sessionId":id,"requestId":request_id,"mode":"queue","content":[{"type":"text","text":text}]});
        if let Some(zone) = client_time_zone {
            valid_text(zone, 128)?;
            request["clientTimeZone"] = json!(zone);
        }
        self.call("session/prompt", json!({"request":request}))
    }
    pub fn session_cancel(&self, id: &str) -> Result<Value, Error> {
        valid_id(id)?;
        self.call("session/cancel", json!({"request":{"sessionId":id}}))
    }
    /// Blocking, incremental follow. Call on a worker thread. Callback receives
    /// snapshot/event/assistant-stream business frames (not mux envelopes).
    /// Return false to stop successfully. External cancellation returns
    /// Error::Cancelled, observed within 250ms while idle (connect/handshake
    /// bounded at 3s). Idle timeouts are NOT EOF. Each new connection starts
    /// with a replacement snapshot; no automatic replay or prompt retries.
    pub fn session_follow(
        &self,
        id: &str,
        cancel: &AtomicBool,
        on_frame: impl FnMut(Value) -> bool,
    ) -> Result<(), Error> {
        valid_id(id)?;
        self.stream("session/follow", json!({"request":{"address":{"kind":"session","sessionId":id},"assistantStream":true,"maxMessages":100}}), cancel, None, on_frame)
    }

    /// Explicit answer-capable event subscription. Frames include ready, emit,
    /// waterfall and cancel. The caller must retain clientId from ready and stop
    /// presenting a request on cancel. Hiding a window need not close this stream.
    pub fn interaction_events(
        &self,
        cancel: &AtomicBool,
        on_frame: impl FnMut(Value) -> bool,
    ) -> Result<(), Error> {
        self.stream("$events", json!({}), cancel, None, on_frame)
    }

    /// Submit one event outcome over independent HTTP, never auto-retried.
    /// An empty success ACK returns null; it does not prove this UI won a race.
    /// Approval denial is result.value="rejected", not outcome.kind="rejected".
    pub fn interaction_result(
        &self,
        client_id: &str,
        event_id: &str,
        outcome: Value,
    ) -> Result<Value, Error> {
        valid_id(client_id)?;
        valid_id(event_id)?;
        validate_interaction_outcome(&outcome)?;
        self.call_response(
            "$events/result",
            json!({"clientId":client_id,"eventId":event_id,"outcome":outcome}),
            true,
        )
    }

    /// Hold a timed question wait until settlement or explicit claim cancellation.
    /// Multiple UIs may hold claims. Closing the last can resume the Host timeout.
    pub fn interaction_wait(
        &self,
        agent_id: &str,
        call_id: &str,
        cancel: &AtomicBool,
        on_frame: impl FnMut(Value) -> bool,
    ) -> Result<(), Error> {
        valid_id(agent_id)?;
        valid_id(call_id)?;
        self.stream(
            "userQuestions/attachWait",
            json!({"agentId":agent_id,"callId":call_id}),
            cancel,
            None,
            on_frame,
        )
    }

    /// Answer only a continued question, not a live waterfall. True means queued
    /// for admission, false means no longer continued. Never automatically retry.
    pub fn interaction_late_answer(
        &self,
        agent_id: &str,
        call_id: &str,
        answer: Value,
    ) -> Result<Value, Error> {
        valid_id(agent_id)?;
        valid_id(call_id)?;
        validate_question_answer(&answer)?;
        let value = self.call(
            "userQuestions/answer",
            json!({"agentId":agent_id,"callId":call_id,"answer":answer}),
        )?;
        if !value.is_boolean() {
            return Err(Error::Protocol);
        }
        Ok(value)
    }

    // Private dispatch means the frontend cannot select routes or methods.
    fn call(&self, method: &str, args: Value) -> Result<Value, Error> {
        self.call_response(method, args, false)
    }

    fn call_response(&self, method: &str, args: Value, allow_void: bool) -> Result<Value, Error> {
        let rpc_id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
        let body = serde_json::to_vec(&json!({"type":"client-request","rpcId":rpc_id,"method":method,"payload":{"args":args}})).map_err(|_| Error::Protocol)?;
        if body.len() > MAX_BYTES {
            return Err(Error::TooLarge);
        }
        let mut request = self
            .http
            .post(format!("{}/api/{method}", self.origin))
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(cookie) = &self.cookie {
            request = request.header(COOKIE, cookie);
        }
        let response = request.send().map_err(|_| Error::Transport)?;
        check_status(response.status().as_u16())?;
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err(Error::TooLarge);
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Transport)?;
        if bytes.len() > MAX_BYTES {
            return Err(Error::TooLarge);
        }
        decode_response_with_void(&bytes, &rpc_id, allow_void)
    }

    fn connect_stream(&self) -> Result<WebSocket<TcpStream>, Error> {
        // Numeric loopback address, no DNS, proxy, redirect or TLS fallback.
        let address = SocketAddr::from(([127, 0, 0, 1], self.port));
        let socket = TcpStream::connect_timeout(&address, Duration::from_secs(2))
            .map_err(|_| Error::Transport)?;
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|_| Error::Transport)?;
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|_| Error::Transport)?;
        let mut request = format!("ws://127.0.0.1:{}/api/remote.mux", self.port)
            .into_client_request()
            .map_err(|_| Error::Protocol)?;
        if let Some(cookie) = &self.cookie {
            request.headers_mut().insert(COOKIE, cookie.clone());
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_BYTES))
            .max_frame_size(Some(MAX_BYTES));
        let (ws, _) = tungstenite::client::client_with_config(request, socket, Some(config))
            .map_err(|e| match e {
                tungstenite::HandshakeError::Failure(e) => ws_error(e),
                tungstenite::HandshakeError::Interrupted(_) => Error::Transport,
            })?;
        ws.get_ref()
            .set_read_timeout(Some(POLL))
            .map_err(|_| Error::Transport)?;
        Ok(ws)
    }

    fn stream(
        &self,
        endpoint: &str,
        args: Value,
        cancel: &AtomicBool,
        deadline: Option<Duration>,
        mut on_frame: impl FnMut(Value) -> bool,
    ) -> Result<(), Error> {
        if cancel.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        let mut ws = self.connect_stream()?;
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
        ws.send(Message::text(
            json!({"type":"open","streamId":id,"endpoint":endpoint,"payload":{"args":args}})
                .to_string(),
        ))
        .map_err(ws_error)?;
        let start = Instant::now();
        let mut opened = false;
        loop {
            if cancel.load(Ordering::Acquire) {
                stop_stream(&mut ws, &id);
                return Err(Error::Cancelled);
            }
            if deadline.is_some_and(|d| start.elapsed() >= d) {
                stop_stream(&mut ws, &id);
                return Err(Error::Transport);
            }
            let message = match ws.read() {
                Ok(m) => m,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(e) => return Err(ws_error(e)),
            };
            match message {
                Message::Ping(_) => {
                    ws.flush().map_err(ws_error)?;
                }
                Message::Pong(_) => {}
                Message::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).map_err(|_| Error::Protocol)?;
                    let object = frame.as_object().ok_or(Error::Protocol)?;
                    if frame["streamId"].as_str() != Some(id.as_str()) {
                        return Err(Error::Protocol);
                    }
                    match frame["type"].as_str() {
                        Some("item") if object.len() == 3 && object.contains_key("value") => {
                            let value = frame["value"].clone();
                            if endpoint == "session/follow" {
                                validate_follow(&value, &mut opened)?;
                                if value["type"] == "snapshot"
                                    && value["header"]["id"]
                                        != args["request"]["address"]["sessionId"]
                                {
                                    return Err(Error::Protocol);
                                }
                            }
                            if endpoint == "$events" {
                                validate_interaction_frame(&value, &mut opened)?;
                            }
                            if endpoint == "userQuestions/attachWait" {
                                let remaining =
                                    value["remainingMs"].as_u64().ok_or(Error::Protocol)?;
                                if opened
                                    || value.as_object().is_none_or(|o| o.len() != 1)
                                    || remaining > 2_147_483_647
                                {
                                    return Err(Error::Protocol);
                                }
                                opened = true;
                            }
                            if !on_frame(value) {
                                stop_stream(&mut ws, &id);
                                return Ok(());
                            }
                        }
                        Some("error") if object.len() == 3 => {
                            validate_failure(&frame["error"])?;
                            return Err(Error::Rpc);
                        }
                        Some("end") if object.len() == 2 => {
                            return if endpoint == "userQuestions/attachWait"
                                || (opened && endpoint != "$events")
                            {
                                Ok(())
                            } else {
                                Err(Error::UnexpectedEnd)
                            }
                        }
                        _ => return Err(Error::Protocol),
                    }
                }
                Message::Close(_) => return Err(Error::UnexpectedEnd),
                _ => return Err(Error::Protocol),
            }
        }
    }
}
fn valid_id(id: &str) -> Result<(), Error> {
    valid_text(id, 256)
}
fn valid_text(text: &str, max: usize) -> Result<(), Error> {
    if text.trim().is_empty() || text.len() > max || text.chars().any(char::is_control) {
        Err(Error::InvalidArgument)
    } else {
        Ok(())
    }
}
fn check_status(status: u16) -> Result<(), Error> {
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err(Error::Authentication),
        n => Err(Error::Http(n)),
    }
}
#[cfg(test)]
fn decode_response(bytes: &[u8], id: &str) -> Result<Value, Error> {
    decode_response_with_void(bytes, id, false)
}
fn decode_response_with_void(bytes: &[u8], id: &str, allow_void: bool) -> Result<Value, Error> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| Error::Protocol)?;
    if envelope.kind != "server-response" || envelope.rpc_id != id {
        return Err(Error::Protocol);
    }
    let result = envelope.result.as_object().ok_or(Error::Protocol)?;
    if allow_void && result.len() == 1 && result.get("ok") == Some(&Value::Bool(true)) {
        return Ok(Value::Null);
    }
    if result.len() != 2 {
        return Err(Error::Protocol);
    }
    match result.get("ok").and_then(Value::as_bool) {
        Some(true) => result.get("value").cloned().ok_or(Error::Protocol),
        Some(false) => {
            validate_failure(result.get("error").ok_or(Error::Protocol)?)?;
            Err(Error::Rpc)
        }
        _ => Err(Error::Protocol),
    }
}
fn validate_failure(value: &Value) -> Result<(), Error> {
    if value.as_object().is_some_and(|o| o.len() == 3)
        && value["code"].is_string()
        && value["message"].is_string()
        && value["details"].is_object()
    {
        Ok(())
    } else {
        Err(Error::Protocol)
    }
}
fn validate_interaction_outcome(value: &Value) -> Result<(), Error> {
    let object = value.as_object().ok_or(Error::InvalidArgument)?;
    let valid = match value["kind"].as_str() {
        Some("next") => object.len() == 1,
        Some("result") => object.len() == 1 || (object.len() == 2 && object.contains_key("value")),
        Some("rejected") if object.len() == 2 => value["error"].as_object().is_some_and(|e| {
            e.keys()
                .all(|k| matches!(k.as_str(), "name" | "message" | "code" | "details"))
                && e.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                && e.get("message").is_some_and(Value::is_string)
                && e.get("code").is_none_or(Value::is_string)
        }),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidArgument)
    }
}
fn validate_question_answer(value: &Value) -> Result<(), Error> {
    let valid = value.as_object().is_some_and(|o| o.len() == 1)
        && value["answers"].as_array().is_some_and(|answers| {
            answers.iter().all(|a| {
                a.as_object().is_some_and(|o| {
                    o.keys()
                        .all(|k| matches!(k.as_str(), "id" | "selected" | "custom"))
                        && a["id"].is_string()
                        && a["selected"]
                            .as_array()
                            .is_some_and(|s| s.iter().all(Value::is_string))
                        && o.get("custom").is_none_or(Value::is_string)
                })
            })
        });
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidArgument)
    }
}
fn validate_interaction_frame(value: &Value, opened: &mut bool) -> Result<(), Error> {
    let object = value.as_object().ok_or(Error::Protocol)?;
    let nonempty = |key: &str| value[key].as_str().is_some_and(|s| !s.is_empty());
    if !*opened {
        if object.len() != 3
            || value["type"] != "ready"
            || !nonempty("clientId")
            || !value["host"]["home"].is_string()
        {
            return Err(Error::Protocol);
        }
        *opened = true;
        return Ok(());
    }
    let valid = match value["type"].as_str() {
        Some("emit") => object.len() == 3 && nonempty("event") && value["args"].is_array(),
        Some("waterfall") => {
            object.len() == 5
                && nonempty("event")
                && nonempty("eventId")
                && nonempty("agentId")
                && value["request"].is_object()
        }
        Some("cancel") => object.len() == 2 && nonempty("eventId"),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(Error::Protocol)
    }
}
fn validate_follow(value: &Value, opened: &mut bool) -> Result<(), Error> {
    let kind = value["type"].as_str().ok_or(Error::Protocol)?;
    if !*opened {
        if kind != "snapshot"
            || !value["header"].is_object()
            || value["cursor"].as_i64().is_none()
            || !value["records"].is_array()
            || !value["hasMore"].is_boolean()
            || !value["projections"].is_object()
        {
            return Err(Error::Protocol);
        }
        *opened = true;
    } else {
        match kind {
            "event" if value["event"].is_object() => {}
            "assistant-stream" if value["frame"].is_object() => {}
            _ => return Err(Error::Protocol),
        }
    }
    Ok(())
}
fn stop_stream(ws: &mut WebSocket<TcpStream>, id: &str) {
    let _ = ws.send(Message::text(
        json!({"type":"cancel","streamId":id}).to_string(),
    ));
    let _ = ws.close(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::TcpListener,
        sync::{mpsc, Arc},
        thread,
    };
    fn listener() -> (TcpListener, String) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", l.local_addr().unwrap());
        (l, origin)
    }
    fn read_http(s: &mut TcpStream) -> (String, Value) {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut h = Vec::new();
        while !h.ends_with(b"\r\n\r\n") {
            let mut b = [0];
            s.read_exact(&mut b).unwrap();
            h.push(b[0]);
            assert!(h.len() < 65536);
        }
        let h = String::from_utf8(h).unwrap();
        let n: usize = h
            .lines()
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse().unwrap())
            })
            .unwrap();
        let mut body = vec![0; n];
        s.read_exact(&mut body).unwrap();
        (h, serde_json::from_slice(&body).unwrap())
    }
    fn snapshot() -> Value {
        json!({"type":"snapshot","header":{"version":1,"id":"s","createdAt":0},"cursor":-1,"records":[],"hasMore":false,"projections":{"asOfSeq":-1,"values":{}},"assistantStream":{"revision":0}})
    }
    fn item(ws: &mut WebSocket<TcpStream>, id: &Value, value: Value) {
        ws.send(Message::text(
            json!({"type":"item","streamId":id,"value":value}).to_string(),
        ))
        .unwrap();
    }
    fn open(l: TcpListener) -> (WebSocket<TcpStream>, Value) {
        let (s, _) = l.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_secs(7))).unwrap();
        let mut ws = tungstenite::accept_hdr(
            s,
            |r: &tungstenite::handshake::server::Request, response| {
                assert_eq!(r.uri().path(), "/api/remote.mux");
                assert_eq!(r.headers()["cookie"], "auth=secret");
                assert!(!r.headers().contains_key("origin"));
                Ok(response)
            },
        )
        .unwrap();
        let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(v["type"], "open");
        assert!(matches!(
            v["endpoint"].as_str(),
            Some("session/follow" | "workspace/follow" | "$events" | "userQuestions/attachWait")
        ));
        (ws, v)
    }
    #[test]
    fn interaction_stream_and_independent_http_ack() {
        let (l, origin) = listener();
        let rpc_listener = l.try_clone().unwrap();
        let server = thread::spawn(move || {
            let (mut ws, v) = open(l);
            assert_eq!(v["endpoint"], "$events");
            assert_eq!(v["payload"], json!({"args":{}}));
            item(
                &mut ws,
                &v["streamId"],
                json!({"type":"ready","clientId":"c","host":{"home":"/mock"}}),
            );
            item(
                &mut ws,
                &v["streamId"],
                json!({"type":"waterfall","event":"approval/request","eventId":"e","agentId":"s","request":{"toolName":"mock"}}),
            );
            let (mut s, _) = rpc_listener.accept().unwrap();
            let (h, body) = read_http(&mut s);
            assert!(h.starts_with("POST /api/$events/result HTTP/1.1"));
            assert!(h.to_ascii_lowercase().contains("cookie: auth=secret"));
            assert_eq!(body["method"], "$events/result");
            assert_eq!(
                body["payload"],
                json!({"args":{"clientId":"c","eventId":"e","outcome":{"kind":"result","value":"rejected"}}})
            );
            let response =
                json!({"type":"server-response","rpcId":body["rpcId"],"result":{"ok":true}})
                    .to_string();
            write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
            item(
                &mut ws,
                &v["streamId"],
                json!({"type":"cancel","eventId":"e"}),
            );
            let cancel: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(cancel["type"], "cancel");
        });
        let c = Client::new(&origin, "auth=secret".into()).unwrap();
        let mut count = 0;
        c.interaction_events(&AtomicBool::new(false), |v| {
            count += 1;
            if v["type"] == "waterfall" {
                assert_eq!(
                    c.interaction_result("c", "e", json!({"kind":"result","value":"rejected"})),
                    Ok(Value::Null)
                );
            }
            v["type"] != "cancel"
        })
        .unwrap();
        assert_eq!(count, 3);
        server.join().unwrap();
    }
    #[test]
    fn interaction_wait_and_late_reply_exact_routes() {
        for has_wait in [true, false] {
            let (l, origin) = listener();
            let server = thread::spawn(move || {
                let (mut ws, v) = open(l);
                assert_eq!(v["endpoint"], "userQuestions/attachWait");
                assert_eq!(v["payload"], json!({"args":{"agentId":"s","callId":"q"}}));
                if has_wait {
                    item(&mut ws, &v["streamId"], json!({"remainingMs":12}));
                }
                ws.send(Message::text(
                    json!({"type":"end","streamId":v["streamId"]}).to_string(),
                ))
                .unwrap();
            });
            let mut count = 0;
            Client::new(&origin, "auth=secret".into())
                .unwrap()
                .interaction_wait("s", "q", &AtomicBool::new(false), |_| {
                    count += 1;
                    true
                })
                .unwrap();
            assert_eq!(count, usize::from(has_wait));
            server.join().unwrap();
        }
        let (l, origin) = listener();
        let server = thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let (h, body) = read_http(&mut s);
            assert!(h.starts_with("POST /api/userQuestions/answer HTTP/1.1"));
            assert_eq!(
                body["payload"],
                json!({"args":{"agentId":"s","callId":"q","answer":{"answers":[{"id":"i","selected":["yes"]}]}}})
            );
            let response = json!({"type":"server-response","rpcId":body["rpcId"],"result":{"ok":true,"value":true}}).to_string();
            write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });
        assert_eq!(
            Client::new(&origin, "auth=secret".into())
                .unwrap()
                .interaction_late_answer(
                    "s",
                    "q",
                    json!({"answers":[{"id":"i","selected":["yes"]}]})
                ),
            Ok(json!(true))
        );
        server.join().unwrap();
    }
    #[test]
    fn interaction_validation_and_explicit_cancellation() {
        let c = Client::new("http://127.0.0.1:1", String::new()).unwrap();
        for outcome in [
            json!({"kind":"allow"}),
            json!({"kind":"next","value":1}),
            json!({"kind":"result","route":"evil"}),
            json!({"kind":"rejected","error":{"name":"","message":"x"}}),
        ] {
            assert_eq!(
                c.interaction_result("c", "e", outcome),
                Err(Error::InvalidArgument)
            );
        }
        for outcome in [
            json!({"kind":"next"}),
            json!({"kind":"result"}),
            json!({"kind":"rejected","error":{"name":"Error","message":"x","code":"ASK_TIMED_OUT"}}),
        ] {
            assert_eq!(validate_interaction_outcome(&outcome), Ok(()));
        }
        assert_eq!(
            c.interaction_events(&AtomicBool::new(true), |_| panic!()),
            Err(Error::Cancelled)
        );
        assert_eq!(
            c.interaction_wait("s", "q", &AtomicBool::new(true), |_| panic!()),
            Err(Error::Cancelled)
        );
        assert_eq!(
            c.interaction_late_answer("s", "q", json!({"answers":[{"id":"i","selected":"yes"}]})),
            Err(Error::InvalidArgument)
        );
        for frame in [
            json!({"type":"cancel","eventId":"e"}),
            json!({"type":"ready","clientId":"","host":{"home":"x"}}),
        ] {
            assert_eq!(
                validate_interaction_frame(&frame, &mut false),
                Err(Error::Protocol)
            );
        }
        let ack = json!({"type":"server-response","rpcId":"r","result":{"ok":true}}).to_string();
        assert_eq!(
            decode_response_with_void(ack.as_bytes(), "r", true),
            Ok(Value::Null)
        );
        assert_eq!(
            decode_response_with_void(ack.as_bytes(), "r", false),
            Err(Error::Protocol)
        );
    }
    #[test]
    fn strict_origin_and_cookie() {
        for origin in [
            "https://127.0.0.1:3",
            "http://localhost:3",
            "http://127.1:3",
            "http://127.0.0.1:03",
            "http://127.0.0.1:0",
            "http://127.0.0.1:3/a",
            "http://127.0.0.1:3/?a",
            "http://127.0.0.1:3//",
            " http://127.0.0.1:3",
            "http://u@127.0.0.1:3",
            "http://127.0.0.1:65536",
        ] {
            assert!(
                matches!(
                    Client::new(origin, String::new()),
                    Err(Error::InvalidOrigin)
                ),
                "{origin}"
            );
        }
        for cookie in [
            "a=x\r\nHost: evil".to_owned(),
            "a=\tsecret".to_owned(),
            "a=中文".to_owned(),
            "x".repeat(16385),
        ] {
            assert!(matches!(
                Client::new("http://127.0.0.1:3", cookie),
                Err(Error::InvalidCookie)
            ));
        }
        assert!(Client::new("http://127.0.0.1:3/", String::new()).is_ok());
    }
    #[test]
    fn rejects_invalid_inputs_before_network() {
        let c = Client::new("http://127.0.0.1:1", String::new()).unwrap();
        assert_eq!(
            c.session_page("s", i64::MAX, Some(2), 100),
            Err(Error::InvalidArgument)
        );
        assert_eq!(
            c.session_page("s", -2, None, 100),
            Err(Error::InvalidArgument)
        );
        assert_eq!(c.session_page("s", 1, None, 0), Err(Error::InvalidArgument));
        assert_eq!(
            c.session_prompt("s", "r", " ", None),
            Err(Error::InvalidArgument)
        );
        assert_eq!(c.workspace_rename("w", "\n"), Err(Error::InvalidArgument));
        assert_eq!(
            c.session_follow("s", &AtomicBool::new(true), |_| panic!()),
            Err(Error::Cancelled)
        );
    }
    #[test]
    fn strict_unary_envelopes_and_redacted_errors() {
        let ok = json!({"type":"server-response","rpcId":"r","result":{"ok":true,"value":null}});
        assert_eq!(
            decode_response(ok.to_string().as_bytes(), "r"),
            Ok(Value::Null)
        );
        for bad in [
            json!({"type":"server-response","rpcId":"wrong","result":{"ok":true,"value":1}}),
            json!({"type":"server-response","rpcId":"r","result":{"ok":true}}),
            json!({"type":"server-response","rpcId":"r","result":{"ok":false,"error":null}}),
            json!({"type":"server-response","rpcId":"r","result":{"ok":true,"value":1,"error":{}}}),
        ] {
            assert_eq!(
                decode_response(bad.to_string().as_bytes(), "r"),
                Err(Error::Protocol)
            );
        }
        let failure = json!({"type":"server-response","rpcId":"r","result":{"ok":false,"error":{"code":"bad","message":"auth=secret","details":{}}}});
        let e = decode_response(failure.to_string().as_bytes(), "r").unwrap_err();
        assert_eq!(e, Error::Rpc);
        assert!(!e.to_string().contains("secret"));
    }
    #[test]
    fn exact_whitelisted_http_requests() {
        let (l, origin) = listener();
        let server = thread::spawn(move || {
            let expected = [
                ("workspace/create", json!({"request":{"path":"/test/only"}})),
                (
                    "workspace/rename",
                    json!({"request":{"workspaceId":"w","title":"Title"}}),
                ),
                ("session/list", json!({"_request":{}})),
                (
                    "session/create",
                    json!({"request":{"workspaceId":"w","sessionId":"s"}}),
                ),
                (
                    "session/page",
                    json!({"request":{"address":{"kind":"session","sessionId":"s"},"throughSeq":10,"beforeSeq":9,"maxMessages":100}}),
                ),
                (
                    "session/prompt",
                    json!({"request":{"sessionId":"s","requestId":"r","mode":"queue","content":[{"type":"text","text":"mock only"}],"clientTimeZone":"Asia/Shanghai"}}),
                ),
                ("session/cancel", json!({"request":{"sessionId":"s"}})),
            ];
            for (method, args) in expected {
                let (mut s, _) = l.accept().unwrap();
                let (h, v) = read_http(&mut s);
                assert!(h.starts_with(&format!("POST /api/{method} HTTP/1.1")));
                assert!(h.to_ascii_lowercase().contains("cookie: auth=secret"));
                assert!(!h.to_ascii_lowercase().contains("origin:"));
                assert_eq!(v["type"], "client-request");
                assert_eq!(v["method"], method);
                assert_eq!(v["payload"]["args"], args);
                let response = json!({"type":"server-response","rpcId":v["rpcId"],"result":{"ok":true,"value":{"accepted":true}}}).to_string();
                write!(s,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        let c = Client::new(&origin, "auth=secret".into()).unwrap();
        c.workspace_create("/test/only").unwrap();
        c.workspace_rename("w", "Title").unwrap();
        c.session_list().unwrap();
        c.session_create("w", Some("s")).unwrap();
        c.session_page("s", 10, Some(9), 100).unwrap();
        c.session_prompt("s", "r", "mock only", Some("Asia/Shanghai"))
            .unwrap();
        c.session_cancel("s").unwrap();
        server.join().unwrap();
    }
    #[test]
    fn http_auth_redirect_and_size_limits() {
        for (status, extra, expected) in [
            (401, "", Error::Authentication),
            (403, "", Error::Authentication),
            (
                302,
                "Location: http://example.invalid/\r\n",
                Error::Http(302),
            ),
            (200, "", Error::TooLarge),
        ] {
            let (l, origin) = listener();
            let server = thread::spawn(move || {
                let (mut s, _) = l.accept().unwrap();
                read_http(&mut s);
                let n = if status == 200 { MAX_BYTES + 1 } else { 0 };
                write!(s,"HTTP/1.1 {status} Test\r\n{extra}Content-Length: {n}\r\nConnection: close\r\n\r\n").unwrap();
            });
            assert_eq!(
                Client::new(&origin, "auth=secret".into())
                    .unwrap()
                    .session_list(),
                Err(expected)
            );
            server.join().unwrap();
        }
    }
    #[test]
    fn workspace_list_uses_baseline_and_cancels() {
        let (l, origin) = listener();
        let server = thread::spawn(move || {
            let (mut ws, v) = open(l);
            assert_eq!(v["endpoint"], "workspace/follow");
            assert_eq!(v["payload"], json!({"args":{}}));
            item(
                &mut ws,
                &v["streamId"],
                json!({"type":"baseline","value":{"items":[],"archivedSessionIds":[],"pinnedSessionIds":[]}}),
            );
            let cancel: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(cancel["type"], "cancel");
        });
        assert_eq!(
            Client::new(&origin, "auth=secret".into())
                .unwrap()
                .workspace_list()
                .unwrap()["items"],
            json!([])
        );
        server.join().unwrap();
    }
    fn assistant_frames() -> [Value; 3] {
        [
            json!({"type":"assistant-stream","frame":{"type":"start","attemptId":"a","revision":1,"startedAfterSeq":-1,"turn":0,"step":0}}),
            json!({"type":"assistant-stream","frame":{"type":"chunk","attemptId":"a","revision":2,"index":0,"time":123,"chunk":{"type":"text-delta","text":"hi"}}}),
            json!({"type":"assistant-stream","frame":{"type":"end","attemptId":"a","revision":3,"index":1,"outcome":{"kind":"committed","eventType":"assistant/message","seq":0}}}),
        ]
    }
    #[test]
    fn follow_is_incremental_survives_idle_and_answers_ping() {
        let (l, origin) = listener();
        let (tx, rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut ws, v) = open(l);
            assert_eq!(v["endpoint"], "session/follow");
            assert_eq!(v["payload"]["args"]["request"]["assistantStream"], true);
            item(&mut ws, &v["streamId"], snapshot());
            rx.recv_timeout(Duration::from_secs(2)).unwrap();
            thread::sleep(Duration::from_millis(3200));
            ws.send(Message::Ping(vec![1, 2].into())).unwrap();
            assert!(matches!(ws.read().unwrap(), Message::Pong(_)));
            for frame in assistant_frames() {
                item(&mut ws, &v["streamId"], frame);
            }
            let cancel: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(cancel["type"], "cancel");
        });
        let mut count = 0;
        Client::new(&origin, "auth=secret".into())
            .unwrap()
            .session_follow("s", &AtomicBool::new(false), |v| {
                count += 1;
                if count == 1 {
                    assert_eq!(v["type"], "snapshot");
                    tx.send(()).unwrap();
                } else {
                    assert_eq!(v, assistant_frames()[count - 2]);
                }
                count < 4
            })
            .unwrap();
        assert_eq!(count, 4);
        server.join().unwrap();
    }
    #[test]
    fn idle_follow_cancellation_is_bounded() {
        let (l, origin) = listener();
        let (tx, rx) = mpsc::channel();
        let flag = Arc::new(AtomicBool::new(false));
        let set = flag.clone();
        let server = thread::spawn(move || {
            let (mut ws, v) = open(l);
            item(&mut ws, &v["streamId"], snapshot());
            tx.send(()).unwrap();
            let cancel: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(cancel["type"], "cancel");
        });
        let worker = thread::spawn(move || {
            Client::new(&origin, "auth=secret".into())
                .unwrap()
                .session_follow("s", &flag, |_| true)
        });
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        thread::sleep(Duration::from_millis(300));
        let start = Instant::now();
        set.store(true, Ordering::Release);
        assert_eq!(worker.join().unwrap(), Err(Error::Cancelled));
        assert!(start.elapsed() < Duration::from_secs(2));
        server.join().unwrap();
    }
    #[test]
    fn partial_frame_survives_read_timeout() {
        let (l, origin) = listener();
        let server = thread::spawn(move || {
            let (mut ws, v) = open(l);
            let body = json!({"type":"item","streamId":v["streamId"],"value":snapshot()})
                .to_string()
                .into_bytes();
            assert!(body.len() > 125 && body.len() < 65536);
            let mut wire = vec![0x81, 126];
            wire.extend_from_slice(&(body.len() as u16).to_be_bytes());
            wire.extend_from_slice(&body);
            ws.get_mut().write_all(&wire[..12]).unwrap();
            thread::sleep(Duration::from_millis(600));
            ws.get_mut().write_all(&wire[12..]).unwrap();
            let cancel: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(cancel["type"], "cancel");
        });
        let mut got = false;
        Client::new(&origin, "auth=secret".into())
            .unwrap()
            .session_follow("s", &AtomicBool::new(false), |_| {
                got = true;
                false
            })
            .unwrap();
        assert!(got);
        server.join().unwrap();
    }
    #[test]
    fn rejects_oversized_frame_before_allocating_payload() {
        let (l, origin) = listener();
        let server = thread::spawn(move || {
            let (mut ws, _) = open(l);
            let mut header = vec![0x81, 127];
            header.extend_from_slice(&((MAX_BYTES + 1) as u64).to_be_bytes());
            ws.get_mut().write_all(&header).unwrap();
        });
        assert_eq!(
            Client::new(&origin, "auth=secret".into())
                .unwrap()
                .session_follow("s", &AtomicBool::new(false), |_| true),
            Err(Error::TooLarge)
        );
        server.join().unwrap();
    }
    #[test]
    fn websocket_auth_failure_is_redacted() {
        let (l, origin) = listener();
        let server = thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut h = vec![];
            while !h.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                s.read_exact(&mut b).unwrap();
                h.push(b[0]);
            }
            s.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        assert_eq!(
            Client::new(&origin, "auth=secret".into())
                .unwrap()
                .session_follow("s", &AtomicBool::new(false), |_| true),
            Err(Error::Authentication)
        );
        server.join().unwrap();
    }
    #[test]
    fn rejects_wrong_id_invalid_order_binary_and_remote_failures() {
        for case in 0..5 {
            let (l, origin) = listener();
            let server = thread::spawn(move || {
                let (mut ws, v) = open(l);
                match case {
                    0 => item(&mut ws, &json!("wrong"), snapshot()),
                    1 => item(&mut ws, &v["streamId"], json!({"type":"event","event":{}})),
                    2 => {
                        ws.send(Message::Binary(vec![1].into())).unwrap();
                    }
                    3 => {
                        ws.send(Message::text(json!({"type":"error","streamId":v["streamId"],"error":{"code":"bad","message":"secret","details":{}}}).to_string())).unwrap();
                    }
                    _ => {
                        ws.close(None).unwrap();
                    }
                }
            });
            let result = Client::new(&origin, "auth=secret".into())
                .unwrap()
                .session_follow("s", &AtomicBool::new(false), |_| true);
            assert_eq!(
                result,
                Err(match case {
                    3 => Error::Rpc,
                    4 => Error::UnexpectedEnd,
                    _ => Error::Protocol,
                })
            );
            server.join().unwrap();
        }
    }
}

fn ws_error(error: tungstenite::Error) -> Error {
    match error {
        tungstenite::Error::Http(response) => check_status(response.status().as_u16())
            .err()
            .unwrap_or(Error::Protocol),
        tungstenite::Error::Capacity(_) => Error::TooLarge,
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            Error::UnexpectedEnd
        }
        tungstenite::Error::Protocol(_) | tungstenite::Error::Utf8 => Error::Protocol,
        _ => Error::Transport,
    }
}
