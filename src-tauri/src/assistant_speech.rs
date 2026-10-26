//! Fixed-loopback Qwen speech transport and request admission. No GUI, files, or shell.
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::Read,
    sync::{Condvar, Mutex},
    time::Duration,
};

pub const VOICE_ID: &str = "pet-airhead-v1";
pub const PET_VIEW: &str = "assistant-pet"; // desktop_assistant::PET / native pet_window guard.
const ENDPOINT: &str = "http://127.0.0.1:18765";
const MAX_AUDIO: usize = 2 * 1024 * 1024;
const MAX_PCM: usize = 24_000 * 2 * 30;
const SHORT_TIMEOUT: Duration = Duration::from_secs(3);
const SYNTH_TIMEOUT: Duration = Duration::from_secs(210);
const HISTORY: usize = 256;
const CANCELLED: &str = "语音请求已取消或被新请求替换。";
const UNAVAILABLE: &str =
    "无法连接本机 Qwen 语音服务，请确认 WSL 内的 Q8 CUDA / ROCm 服务已在 127.0.0.1:18765 启动。";
const IDENTITY: &str =
    "本机 Qwen 语音服务身份或音色不匹配，请启动协议 1、pet-airhead-v1 音色的 dsh-pet-qwen 服务。";
const AUDIO_ERROR: &str =
    "Qwen 返回的音频无效，请检查服务是否输出不超过 30 秒的 24kHz 单声道 PCM16 WAV。";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechRequest {
    pub request_id: String,
    pub text: String,
}

/// Native wall-clock stages, in milliseconds (including fractional milliseconds).
#[derive(Debug, Serialize)]
pub(crate) struct SpeechTimings {
    pub readiness_ms: f64,
    /// Full bridge call: queueing, health, HTTP and WAV validation, not just GPU work.
    pub synthesis_ms: f64,
    pub encode_ms: f64,
    /// From generate entry through the final permission/cancellation checks.
    pub total_ms: f64,
}
impl SpeechTimings {
    pub(crate) fn from_durations(
        readiness: Duration,
        synthesis: Duration,
        encode: Duration,
        total: Duration,
    ) -> Self {
        Self {
            readiness_ms: readiness.as_secs_f64() * 1000.0,
            synthesis_ms: synthesis.as_secs_f64() * 1000.0,
            encode_ms: encode.as_secs_f64() * 1000.0,
            total_ms: total.as_secs_f64() * 1000.0,
        }
    }
}

pub fn validate_id(id: &str) -> Result<(), String> {
    if !(8..=80).contains(&id.len())
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("语音请求编号须为 8–80 位 ASCII 字母、数字、下划线或连字符。".into());
    }
    Ok(())
}
impl SpeechRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_id(&self.request_id)?;
        if self.text.trim().is_empty() || self.text.chars().count() > 80 || self.text.contains('\0')
        {
            return Err("每段语音文本须为 1–80 个 Unicode 字符，且不能包含空字符。".into());
        }
        Ok(())
    }
}

/// Additional exact pet guard, after the desktop wrapper's assert_assistant origin check.
pub fn pet_caller(view: &str, window: &str, url: &url::Url) -> bool {
    let packaged = ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
        && url.port().is_none();
    let dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    view == PET_VIEW
        && window == PET_VIEW
        && (packaged || dev)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.path() == "/assistant.html"
        && url.query() == Some("view=pet")
}

#[derive(Deserialize)]
struct Health {
    service: String,
    protocol: u32,
    voice_id: String,
}
fn validate_health(bytes: &[u8]) -> Result<(), String> {
    let health: Health = serde_json::from_slice(bytes).map_err(|_| IDENTITY.to_string())?;
    if health.service != "dsh-pet-qwen" || health.protocol != 1 || health.voice_id != VOICE_ID {
        return Err(IDENTITY.into());
    }
    Ok(())
}

fn bounded(mut response: Response, limit: usize, error: &str) -> Result<Vec<u8>, String> {
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        return Err(error.into());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error.to_string())?;
    if bytes.len() > limit {
        return Err(error.into());
    }
    Ok(bytes)
}

/// The endpoint is never accepted from JS, configuration, or environment variables.
struct Transport {
    client: Client,
    endpoint: String,
}
impl Transport {
    fn new() -> Result<Self, String> {
        Self::build(ENDPOINT.to_string())
    }
    fn build(endpoint: String) -> Result<Self, String> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(SHORT_TIMEOUT)
            .timeout(SYNTH_TIMEOUT)
            .build()
            .map_err(|_| UNAVAILABLE.to_string())?;
        Ok(Self { client, endpoint })
    }
    #[cfg(test)]
    fn for_test(address: std::net::SocketAddr) -> Self {
        assert!(address.ip().is_loopback());
        Self::build(format!("http://{address}")).unwrap()
    }
    fn health(&self) -> Result<(), String> {
        let response = self
            .client
            .get(format!("{}/health", self.endpoint))
            .timeout(SHORT_TIMEOUT)
            .send()
            .map_err(|_| UNAVAILABLE.to_string())?;
        validate_health(&bounded(response, 4096, IDENTITY)?)
    }
    fn synthesize(&self, request: &SpeechRequest) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .post(format!("{}/v1/synthesize", self.endpoint))
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(request).map_err(|_| "无法编码语音请求。".to_string())?)
            .timeout(SYNTH_TIMEOUT)
            .send()
            .map_err(|_| "Qwen 语音合成失败或超过 210 秒，请检查本机服务后重试。".to_string())?;
        if !response.status().is_success() {
            // Status-only diagnosis: never read or reflect untrusted service error bodies.
            return Err(match response.status().as_u16() {
                409 => CANCELLED,
                429 => "Qwen 语音服务繁忙，请稍后重试。",
                503 => "Qwen 模型尚未就绪或合成超过服务期限，请检查本机语音服务后重试。",
                500 => "Qwen 合成引擎运行失败，请检查本机服务日志、模型及依赖后重试。",
                _ => "Qwen 语音服务拒绝了合成请求，请检查本机服务后重试。",
            }
            .to_string());
        }
        let bytes = bounded(response, MAX_AUDIO, AUDIO_ERROR)?;
        validate_wav(&bytes)?;
        Ok(bytes)
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let response = self
            .client
            .post(format!("{}/v1/cancel", self.endpoint))
            .header("Content-Type", "application/json")
            .body(serde_json::json!({"request_id":id}).to_string())
            .timeout(SHORT_TIMEOUT)
            .send()
            .map_err(|_| UNAVAILABLE.to_string())?;
        let bytes = bounded(response, 4096, "Qwen 取消请求失败，请检查本机语音服务。")?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Qwen 取消响应无效，请检查本机语音服务。".to_string())?;
        if !value.is_object() {
            return Err("Qwen 取消响应无效，请检查本机语音服务。".into());
        }
        Ok(())
    }
}

/// Strict RIFF boundaries, padded chunks, one PCM format and one complete frame payload.
pub fn validate_wav(bytes: &[u8]) -> Result<(), String> {
    let invalid = || AUDIO_ERROR.to_string();
    let u16_at = |p: usize| u16::from_le_bytes([bytes[p], bytes[p + 1]]);
    let u32_at =
        |p: usize| u32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]);
    if bytes.len() < 44
        || bytes.len() > MAX_AUDIO
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || u32_at(4) as u64 + 8 != bytes.len() as u64
    {
        return Err(invalid());
    }
    let (mut pos, mut format, mut data) = (12usize, false, false);
    while pos < bytes.len() {
        if bytes.len() - pos < 8 {
            return Err(invalid());
        }
        let length = u32_at(pos + 4) as usize;
        let start = pos + 8;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        match &bytes[pos..pos + 4] {
            b"fmt " => {
                if format
                    || !(length == 16 || (length == 18 && u16_at(start + 16) == 0))
                    || u16_at(start) != 1
                    || u16_at(start + 2) != 1
                    || u32_at(start + 4) != 24_000
                    || u32_at(start + 8) != 48_000
                    || u16_at(start + 12) != 2
                    || u16_at(start + 14) != 16
                {
                    return Err(invalid());
                }
                format = true;
            }
            b"data" => {
                if data || !format || length == 0 || length > MAX_PCM || length % 2 != 0 {
                    return Err(invalid());
                }
                data = true;
            }
            _ => {}
        }
        pos = end
            .checked_add(length % 2)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
    }
    if !format || !data {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Clone)]
pub struct Ticket {
    id: String,
    generation: u64,
}
#[derive(Default)]
struct Requests {
    next: u64,
    current: Option<Ticket>,
    active: Option<Ticket>,
    pending: Option<Ticket>,
    // Cancel-before-start tombstones, and completed IDs: bounded, never clear on unrelated cancel.
    history: VecDeque<String>,
}
impl Requests {
    fn remember(&mut self, id: &str) {
        if !self.history.iter().any(|old| old == id) {
            self.history.push_back(id.to_string());
        }
        while self.history.len() > HISTORY {
            self.history.pop_front();
        }
    }
    fn current(&self, ticket: &Ticket) -> bool {
        self.current
            .as_ref()
            .is_some_and(|t| t.generation == ticket.generation && t.id == ticket.id)
    }
}
#[derive(Default)]
pub struct SpeechBridge {
    requests: Mutex<Requests>,
    wake: Condvar,
}
impl SpeechBridge {
    /// Called before spawning, so cancellation/supersession cannot be reordered by worker scheduling.
    pub fn begin(&self, request: &SpeechRequest) -> Result<(Ticket, Vec<String>), String> {
        self.begin_after(request, None)
    }
    /// A background continuation may only replace its own still-current predecessor.
    /// Check and admission share one lock: a delayed WebView stop cannot let an old
    /// narration reclaim ownership from a newer user-initiated request in another window.
    pub fn begin_after(
        &self,
        request: &SpeechRequest,
        previous_request_id: Option<&str>,
    ) -> Result<(Ticket, Vec<String>), String> {
        request.validate()?;
        if let Some(previous) = previous_request_id {
            validate_id(previous)?;
        }
        let mut state = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if previous_request_id.is_some_and(|previous| {
            !state
                .current
                .as_ref()
                .is_some_and(|ticket| ticket.id == previous)
        }) {
            return Err(CANCELLED.into());
        }
        if state.history.contains(&request.request_id)
            || [&state.active, &state.pending, &state.current]
                .iter()
                .any(|t| t.as_ref().is_some_and(|t| t.id == request.request_id))
        {
            return Err("语音请求编号已使用或已取消，请使用新的唯一编号。".into());
        }
        let mut cancelled = Vec::new();
        if let Some(old) = state.current.take() {
            cancelled.push(old.id.clone());
            state.remember(&old.id);
        }
        if let Some(old) = state.pending.take() {
            state.remember(&old.id);
        }
        state.next = state
            .next
            .checked_add(1)
            .ok_or("语音请求计数已满，请重启应用。")?;
        let ticket = Ticket {
            id: request.request_id.clone(),
            generation: state.next,
        };
        state.current = Some(ticket.clone());
        state.pending = Some(ticket.clone());
        self.wake.notify_all();
        Ok((ticket, cancelled))
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut state = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        state.remember(id);
        if state.current.as_ref().is_some_and(|t| t.id == id) {
            state.current = None;
        }
        if state.pending.as_ref().is_some_and(|t| t.id == id) {
            state.pending = None;
        }
        self.wake.notify_all();
        Ok(())
    }
    pub fn invalidate(&self) -> Vec<String> {
        let mut state = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids = Vec::new();
        for t in [
            state.current.take(),
            state.pending.take(),
            state.active.clone(),
        ]
        .into_iter()
        .flatten()
        {
            if !ids.contains(&t.id) {
                ids.push(t.id.clone());
            }
            state.remember(&t.id);
        }
        self.wake.notify_all();
        ids
    }
    pub fn is_current(&self, ticket: &Ticket) -> bool {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .current(ticket)
    }
    fn acquire(&self, ticket: &Ticket) -> Result<(), String> {
        let mut state = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !state.current(ticket) {
                return Err(CANCELLED.into());
            }
            if state.active.is_none() {
                state.pending = None;
                state.active = Some(ticket.clone());
                return Ok(());
            }
            state = self.wake.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
    fn release(&self, ticket: &Ticket) {
        let mut state = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .active
            .as_ref()
            .is_some_and(|t| t.generation == ticket.generation)
        {
            state.active = None;
        }
        state.remember(&ticket.id);
        self.wake.notify_all();
    }
    /// Must run on a blocking worker. No state mutex spans client creation, health, HTTP or audio validation.
    pub fn synthesize(
        &self,
        ticket: &Ticket,
        request: &SpeechRequest,
        superseded: &[String],
    ) -> Result<Vec<u8>, String> {
        self.synthesize_with(ticket, request, superseded, Transport::new)
    }
    fn synthesize_with(
        &self,
        ticket: &Ticket,
        request: &SpeechRequest,
        superseded: &[String],
        transport: impl FnOnce() -> Result<Transport, String>,
    ) -> Result<Vec<u8>, String> {
        // Send superseded cancellations before waiting for the active network slot.
        // Service tombstones also close the check-before-send race.
        let transport = transport()?;
        if !superseded.is_empty() {
            transport.health()?;
        }
        for id in superseded {
            let _ = transport.cancel(id);
        }
        self.acquire(ticket)?;
        let result = (|| {
            if !self.is_current(ticket) {
                return Err(CANCELLED.into());
            }
            transport.health()?;
            if !self.is_current(ticket) {
                return Err(CANCELLED.into());
            }
            let wav = transport.synthesize(request)?;
            if !self.is_current(ticket) {
                return Err(CANCELLED.into());
            }
            Ok(wav)
        })();
        self.release(ticket);
        result
    }
    pub fn cancel_remote(id: &str) -> Result<(), String> {
        validate_id(id)?;
        let transport = Transport::new()?;
        transport.health()?;
        transport.cancel(id)
    }
    pub fn cancelled_error() -> String {
        CANCELLED.into()
    }
}

#[cfg(test)]
#[path = "assistant_speech_tests.rs"]
mod tests;
