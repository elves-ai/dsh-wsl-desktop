//! Bounded, credential-safe access to the two read-only notification RPCs.

use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, CONTENT_TYPE, COOKIE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const MAX_COOKIE_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const INVALID_ORIGIN: &str = "通知服务地址未通过安全校验。";
const INVALID_COOKIE: &str = "通知认证信息未通过安全校验。";
const INVALID_PAGE: &str = "通知会话参数未通过安全校验。";
const TRANSPORT_ERROR: &str = "通知服务请求失败或超时。";
const HTTP_ERROR: &str = "通知服务未返回成功状态。";
const AUTH_ERROR: &str = "通知服务认证已失效或无权访问，请重新打开 DSH 工作窗口完成登录。";
const RESPONSE_TOO_LARGE: &str = "通知服务响应超过 8 MiB 限制。";
const INVALID_RESPONSE: &str = "通知服务响应协议无效。";
const RPC_ERROR: &str = "通知服务未能完成请求。";
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);

// Deliberately no Debug: neither the client nor its credentials belong in logs.
pub struct RpcClient {
    client: Client,
    origin: String,
    cookie: Option<HeaderValue>,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "type")]
    response_type: String,
    #[serde(rename = "rpcId")]
    rpc_id: String,
    result: Value,
}

impl RpcClient {
    pub fn new(origin: &str, cookie: String) -> Result<Self, String> {
        // Validate spelling before any URL parser can normalize alternate IPs,
        // userinfo, dot segments, whitespace, or encoded separators.
        let root = origin.strip_suffix('/').unwrap_or(origin);
        let port_text = root
            .strip_prefix("http://127.0.0.1:")
            .ok_or_else(|| INVALID_ORIGIN.to_owned())?;
        if port_text.is_empty()
            || port_text.len() > 5
            || !port_text.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(INVALID_ORIGIN.into());
        }
        let port: u16 = port_text.parse().map_err(|_| INVALID_ORIGIN.to_owned())?;
        if port == 0 || port.to_string() != port_text {
            return Err(INVALID_ORIGIN.into());
        }
        if cookie.len() > MAX_COOKIE_BYTES {
            return Err(INVALID_COOKIE.into());
        }
        let cookie = if cookie.is_empty() {
            None
        } else {
            let mut header =
                HeaderValue::from_str(&cookie).map_err(|_| INVALID_COOKIE.to_owned())?;
            header.set_sensitive(true);
            Some(header)
        };
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| TRANSPORT_ERROR.to_owned())?;
        Ok(Self {
            client,
            origin: root.to_owned(),
            cookie,
        })
    }

    pub fn list(&self) -> Result<Value, String> {
        // Generated descriptor preserves the source parameter name _request.
        self.call("session/list", json!({"_request": {}}))
    }

    pub fn page(&self, session_id: &str, cursor: i64) -> Result<Value, String> {
        if session_id.is_empty()
            || session_id.len() > 256
            || session_id.chars().any(char::is_control)
            || cursor < -1
        {
            return Err(INVALID_PAGE.into());
        }
        self.call(
            "session/page",
            json!({"request": {
                "address": {"kind": "session", "sessionId": session_id},
                "throughSeq": cursor,
                "maxMessages": 1
            }}),
        )
    }

    // Private: callers cannot select arbitrary RPCs or routes.
    fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        let rpc_id = NEXT_RPC_ID.fetch_add(1, Ordering::Relaxed).to_string();
        let body = serde_json::to_vec(&json!({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": method,
            "payload": {"args": args}
        }))
        .map_err(|_| TRANSPORT_ERROR.to_owned())?;
        let mut request = self
            .client
            .post(format!("{}/api/{method}", self.origin))
            .header(CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(cookie) = &self.cookie {
            request = request.header(COOKIE, cookie);
        }
        // No Origin is necessary for the native client; never send Sec-Fetch-*.
        let response = request.send().map_err(|_| TRANSPORT_ERROR.to_owned())?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(AUTH_ERROR.into());
        }
        if !response.status().is_success() {
            return Err(HTTP_ERROR.into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES)
        {
            return Err(RESPONSE_TOO_LARGE.into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| TRANSPORT_ERROR.to_owned())?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(RESPONSE_TOO_LARGE.into());
        }
        let envelope: Envelope =
            serde_json::from_slice(&bytes).map_err(|_| INVALID_RESPONSE.to_owned())?;
        if envelope.response_type != "server-response" || envelope.rpc_id != rpc_id {
            return Err(INVALID_RESPONSE.into());
        }
        let result = envelope
            .result
            .as_object()
            .ok_or_else(|| INVALID_RESPONSE.to_owned())?;
        match result.get("ok").and_then(Value::as_bool) {
            Some(true) => result
                .get("value")
                .cloned()
                .ok_or_else(|| INVALID_RESPONSE.to_owned()),
            Some(false) if result.contains_key("error") => Err(RPC_ERROR.into()),
            _ => Err(INVALID_RESPONSE.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};

    struct Request {
        line: String,
        headers: HashMap<String, String>,
        body: Value,
    }

    fn read_request(stream: &mut TcpStream) -> Request {
        stream
            .set_read_timeout(Some(Duration::from_secs(6)))
            .unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 64 * 1024);
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let header = String::from_utf8(bytes).unwrap();
        let mut lines = header.split("\r\n");
        let line = lines.next().unwrap().to_owned();
        let headers: HashMap<_, _> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        let length = headers["content-length"].parse::<usize>().unwrap();
        assert!(length < 64 * 1024);
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        Request {
            line,
            headers,
            body: serde_json::from_slice(&body).unwrap(),
        }
    }

    fn server<F>(respond: F) -> (String, JoinHandle<()>)
    where
        F: FnOnce(Request, &mut TcpStream) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(6)))
                .unwrap();
            let request = read_request(&mut stream);
            respond(request, &mut stream);
        });
        (origin, handle)
    }

    fn reply(stream: &mut TcpStream, status: &str, body: &[u8]) {
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).unwrap();
        let _ = stream.write_all(body);
    }

    fn success(request: &Request, value: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "server-response", "rpcId": request.body["rpcId"],
            "result": {"ok": true, "value": value}
        }))
        .unwrap()
    }

    #[test]
    fn list_posts_exact_headers_and_descriptor_and_returns_value() {
        let (origin, handle) = server(|request, stream| {
            assert_eq!(request.line, "POST /api/session/list HTTP/1.1");
            assert_eq!(request.headers["content-type"], "application/json");
            assert_eq!(request.headers["cookie"], "dsh-auth-test=secret");
            assert!(!request.headers.contains_key("origin"));
            assert!(!request
                .headers
                .keys()
                .any(|key| key.starts_with("sec-fetch-")));
            assert_eq!(request.body["type"], "client-request");
            assert_eq!(request.body["method"], "session/list");
            assert_eq!(request.body["payload"], json!({"args": {"_request": {}}}));
            assert!(!request.body["rpcId"].as_str().unwrap().is_empty());
            reply(
                stream,
                "200 OK",
                &success(&request, json!({"sessions": []})),
            );
        });
        let client = RpcClient::new(&format!("{origin}/"), "dsh-auth-test=secret".into()).unwrap();
        assert_eq!(client.list().unwrap(), json!({"sessions": []}));
        handle.join().unwrap();
    }

    #[test]
    fn page_posts_exact_request_without_cookie_and_accepts_null_value() {
        let (origin, handle) = server(|request, stream| {
            assert_eq!(request.line, "POST /api/session/page HTTP/1.1");
            assert!(!request.headers.contains_key("cookie"));
            assert_eq!(request.body["method"], "session/page");
            assert_eq!(
                request.body["payload"],
                json!({"args": {"request": {
                    "address": {"kind": "session", "sessionId": "session-1"},
                    "throughSeq": -1, "maxMessages": 1
                }}})
            );
            reply(stream, "200 OK", &success(&request, Value::Null));
        });
        assert_eq!(
            RpcClient::new(&origin, String::new())
                .unwrap()
                .page("session-1", -1)
                .unwrap(),
            Value::Null
        );
        handle.join().unwrap();
    }

    #[test]
    fn rpc_ids_are_unique_across_clients() {
        let mut ids = Vec::new();
        for _ in 0..2 {
            let (send, receive) = mpsc::channel();
            let (origin, handle) = server(move |request, stream| {
                send.send(
                    request.body["rpcId"]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap(),
                )
                .unwrap();
                reply(stream, "200 OK", &success(&request, json!([])));
            });
            RpcClient::new(&origin, String::new())
                .unwrap()
                .list()
                .unwrap();
            handle.join().unwrap();
            ids.push(receive.recv().unwrap());
        }
        assert!(ids[1] > ids[0]);
    }

    #[test]
    fn rejects_noncanonical_origins_before_connecting() {
        for origin in [
            "http://localhost:3080",
            "http://127.1:3080",
            "http://2130706433:3080",
            "http://0177.0.0.1:3080",
            "http://0x7f000001:3080",
            "http://127.0.0.2:3080",
            "http://[::1]:3080",
            "https://127.0.0.1:3080",
            "HTTP://127.0.0.1:3080",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:03080",
            "http://127.0.0.1:+3080",
            "http://127.0.0.1:3080//",
            "http://127.0.0.1:3080/path",
            "http://127.0.0.1:3080/../",
            "http://127.0.0.1:3080/%2e/",
            "http://user:secret@127.0.0.1:3080",
            "http://@127.0.0.1:3080",
            "http://127.0.0.1:3080?secret",
            "http://127.0.0.1:3080/#secret",
            " http://127.0.0.1:3080",
            "http://127.0.0.1:3080/\n",
            "http://127.0.0.1:3080/\\evil",
        ] {
            assert_eq!(
                RpcClient::new(origin, String::new()).err().unwrap(),
                INVALID_ORIGIN
            );
        }
        for origin in ["http://127.0.0.1:80", "http://127.0.0.1:65535/"] {
            assert!(RpcClient::new(origin, String::new()).is_ok());
        }
    }

    #[test]
    fn validates_cookie_size_and_header_bytes_without_echoing_them() {
        for cookie in [
            "secret\r\nInjected: value".to_owned(),
            "secret\0".into(),
            "x".repeat(MAX_COOKIE_BYTES + 1),
        ] {
            assert_eq!(
                RpcClient::new("http://127.0.0.1:1", cookie).err().unwrap(),
                INVALID_COOKIE
            );
        }
        let client = RpcClient::new("http://127.0.0.1:1", "x".repeat(MAX_COOKIE_BYTES)).unwrap();
        assert!(client.cookie.as_ref().unwrap().is_sensitive());
    }

    #[test]
    fn validates_page_boundaries_before_connecting() {
        let client = RpcClient::new("http://127.0.0.1:1", String::new()).unwrap();
        for id in [
            String::new(),
            "a".repeat(257),
            "x\ny".into(),
            "x\0y".into(),
            "x\u{7f}y".into(),
            "x\u{85}y".into(),
        ] {
            assert_eq!(client.page(&id, -1).unwrap_err(), INVALID_PAGE);
        }
        assert_eq!(client.page("valid", -2).unwrap_err(), INVALID_PAGE);
        let (origin, handle) = server(|request, stream| {
            assert_eq!(
                request.body["payload"]["args"]["request"]["address"]["sessionId"],
                "a".repeat(256)
            );
            assert_eq!(
                request.body["payload"]["args"]["request"]["throughSeq"],
                i64::MAX
            );
            reply(stream, "200 OK", &success(&request, json!({})));
        });
        RpcClient::new(&origin, String::new())
            .unwrap()
            .page(&"a".repeat(256), i64::MAX)
            .unwrap();
        handle.join().unwrap();
    }

    #[test]
    fn http_errors_do_not_disclose_response_or_cookie() {
        for status in [
            "401 Unauthorized",
            "403 Forbidden",
            "500 Internal Server Error",
        ] {
            let (origin, handle) =
                server(move |_, stream| reply(stream, status, b"secret backend stack and cookie"));
            assert_eq!(
                RpcClient::new(&origin, "private-cookie".into())
                    .unwrap()
                    .list()
                    .unwrap_err(),
                if status.starts_with("401") || status.starts_with("403") {
                    AUTH_ERROR
                } else {
                    HTTP_ERROR
                }
            );
            handle.join().unwrap();
        }
    }

    #[test]
    fn redirect_is_not_followed_or_given_credentials() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let location = format!("http://{}/secret", target.local_addr().unwrap());
        let (origin, handle) = server(move |_, stream| {
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert_eq!(
            RpcClient::new(&origin, "private-cookie".into())
                .unwrap()
                .list()
                .unwrap_err(),
            HTTP_ERROR
        );
        handle.join().unwrap();
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn rpc_error_does_not_disclose_backend_contents() {
        let (origin, handle) = server(|request, stream| {
            let body = json!({"type": "server-response", "rpcId": request.body["rpcId"],
                "result": {"ok": false, "error": {"message": "secret cookie and stack", "code": "secret"}}});
            reply(stream, "200 OK", &serde_json::to_vec(&body).unwrap());
        });
        assert_eq!(
            RpcClient::new(&origin, String::new())
                .unwrap()
                .list()
                .unwrap_err(),
            RPC_ERROR
        );
        handle.join().unwrap();
    }

    #[test]
    fn rejects_invalid_envelopes_with_static_errors() {
        let cases = [
            json!({}),
            json!([]),
            json!({"type": "server-event", "result": {"ok": true, "value": []}}),
            json!({"type": "server-response", "rpcId": "wrong-id", "result": {"ok": true, "value": []}}),
            json!({"type": "server-response", "rpcId": 4, "result": {"ok": true, "value": []}}),
            json!({"type": "server-response", "result": null}),
            json!({"type": "server-response", "result": {"ok": "true", "value": []}}),
            json!({"type": "server-response", "result": {"ok": true}}),
            json!({"type": "server-response", "result": {"ok": false}}),
            json!({"type": "server-response", "result": {"value": []}}),
        ];
        for mut body in cases {
            let (origin, handle) = server(move |request, stream| {
                if let Some(object) = body.as_object_mut() {
                    if !object.contains_key("rpcId") {
                        object.insert("rpcId".into(), request.body["rpcId"].clone());
                    }
                }
                reply(stream, "200 OK", &serde_json::to_vec(&body).unwrap());
            });
            assert_eq!(
                RpcClient::new(&origin, String::new())
                    .unwrap()
                    .list()
                    .unwrap_err(),
                INVALID_RESPONSE
            );
            handle.join().unwrap();
        }
        let (origin, handle) = server(|_, stream| reply(stream, "200 OK", b"not JSON: secret"));
        assert_eq!(
            RpcClient::new(&origin, String::new())
                .unwrap()
                .list()
                .unwrap_err(),
            INVALID_RESPONSE
        );
        handle.join().unwrap();
    }

    #[test]
    fn rejects_oversized_declared_body_without_reading_it() {
        let (origin, handle) = server(|_, stream| {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .unwrap();
        });
        assert_eq!(
            RpcClient::new(&origin, String::new())
                .unwrap()
                .list()
                .unwrap_err(),
            RESPONSE_TOO_LARGE
        );
        handle.join().unwrap();
    }

    #[test]
    fn caps_body_without_content_length() {
        let (origin, handle) = server(|_, stream| {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .unwrap();
            let _ = stream.write_all(&vec![b' '; MAX_RESPONSE_BYTES as usize + 1]);
        });
        assert_eq!(
            RpcClient::new(&origin, String::new())
                .unwrap()
                .list()
                .unwrap_err(),
            RESPONSE_TOO_LARGE
        );
        handle.join().unwrap();
    }

    #[test]
    fn timeout_bounds_response_body_read_and_hides_details() {
        let (release, wait) = mpsc::channel();
        let (origin, handle) = server(move |_, stream| {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                .unwrap();
            // Hold the incomplete response until the client returns or watchdog fires.
            let _ = wait.recv_timeout(Duration::from_secs(6));
        });
        let start = std::time::Instant::now();
        let result = RpcClient::new(&origin, "private-cookie".into())
            .unwrap()
            .list();
        let elapsed = start.elapsed();
        let _ = release.send(());
        handle.join().unwrap();
        assert_eq!(result.unwrap_err(), TRANSPORT_ERROR);
        assert!(elapsed >= Duration::from_secs(2));
        assert!(elapsed < Duration::from_secs(5));
    }
}
