//! Untrusted WSL helper replies and credential-safe diagnostics. No Tauri dependency.

use serde::Deserialize;
use std::{fmt, time::Instant};
use url::Url;

const MAX_REPLY_BYTES: usize = 64 * 1024;
const INVALID_URL: &str = "后端启动地址未通过安全校验。";

#[derive(Clone, Deserialize)]
pub struct BackendReply {
    pub state: String,
    pub url: Option<String>,
    #[serde(default)]
    pub authenticated: bool,
    /// Verified supervisor ownership; independent of browser authentication.
    #[serde(default)]
    pub managed: bool,
    pub pid: Option<u32>,
    pub code: Option<String>,
    pub service_log: Option<String>,
}

// A derived Debug would disclose the one-use launch credential. Omit the URL
// altogether, including malformed URLs, and sanitize all other helper strings.
impl fmt::Debug for BackendReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BackendReply")
            .field("state", &redact(&self.state))
            .field("url", &self.url.as_ref().map(|_| "[REDACTED]"))
            .field("authenticated", &self.authenticated)
            .field("managed", &self.managed)
            .field("pid", &self.pid)
            .field("code", &self.code.as_deref().map(redact))
            .field("service_log", &self.service_log.as_deref().map(redact))
            .finish()
    }
}

/// Accept one complete JSON reply; never echo parser errors or helper messages.
/// Error replies become a static, safe Chinese message, not an Ok(error) value.
pub fn parse_reply(bytes: &[u8]) -> Result<BackendReply, String> {
    if bytes.len() > MAX_REPLY_BYTES {
        return Err("后端响应超过 64 KiB 限制。".into());
    }
    let reply: BackendReply =
        serde_json::from_slice(bytes).map_err(|_| "后端响应不是有效的协议 JSON。".to_owned())?;
    match reply.state.as_str() {
        "ready" | "starting" | "stopped" | "logs" => Ok(reply),
        "error" => Err(backend_error(reply.code.as_deref())),
        _ => Err("后端返回了不支持的状态。".into()),
    }
}

/// Authentication is not proof of process ownership, and missing authentication
/// must not prevent a verified supervisor from stopping its own starting service.
pub fn validated_stop_pid(reply: &BackendReply) -> Result<u32, String> {
    if !["ready", "starting"].contains(&reply.state.as_str()) || !reply.managed {
        return Err("无法验证当前服务的托管归属，未发送停止信号。可选择“仅退出启动器”，或在原启动终端中处理。".into());
    }
    reply
        .pid
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "尚未取得托管服务的进程身份，请稍后重试；也可选择“仅退出启动器”。".into())
}

/// Only a ready reply may open the exact configured loopback root.
/// Check the raw spelling as well as parsed components: URL parsers normalize
/// alternative IPv4 spellings, dot segments, empty userinfo and control bytes.
pub fn validated_launch_url(reply: &BackendReply, expected_port: u16) -> Result<Url, String> {
    let invalid = || INVALID_URL.to_owned();
    if reply.state != "ready" || expected_port == 0 {
        return Err(invalid());
    }
    let raw = reply.url.as_deref().ok_or_else(invalid)?;
    let expected_root = format!("http://127.0.0.1:{expected_port}/");
    let (root, query) = match raw.split_once('?') {
        Some((root, query)) => (root, Some(query)),
        None => (raw, None),
    };
    if root != expected_root {
        return Err(invalid());
    }
    let has_token = match query {
        None | Some("") => false,
        Some(query) => {
            let token = query.strip_prefix("token=").ok_or_else(invalid)?;
            if token.len() != 43
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(invalid());
            }
            true
        }
    };
    if reply.authenticated != has_token {
        return Err(invalid());
    }
    let parsed = Url::parse(raw).map_err(|_| invalid())?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port_or_known_default() != Some(expected_port)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(parsed)
}

/// A listening service may still be publishing its browser credential. Keep the
/// original startup deadline: a short grace period fails cold starts, while a
/// fresh deadline on each probe can wait forever. This never grants ownership.
/// Call only after validating a ready launch URL and Windows reachability.
pub fn wait_for_launch_authentication(
    reply: &BackendReply,
    status: u16,
    now: Instant,
    deadline: Instant,
) -> Result<bool, String> {
    if status != 401 || reply.authenticated {
        return Ok(false);
    }
    if !reply.managed {
        return Err("服务正在运行，但未验证托管归属，无法为新窗口自动认证。请使用原启动终端的认证链接；也可选择“仅退出启动器”。".into());
    }
    if now >= deadline {
        return Err(backend_error(Some("managed_auth_unavailable")));
    }
    Ok(true)
}

/// Map only known machine codes; unknown codes and raw messages are never shown.
pub fn backend_error(code: Option<&str>) -> String {
    match code {
        Some("port_in_use") => "端口被其它程序占用，未停止任何进程。",
        Some("stop_timeout") => "等待服务停止超时，未强制结束进程。",
        Some("stop_incomplete") => "服务尚未完全停止，请稍后重试。",
        Some("process_changed") => "服务进程身份校验未通过，未发送停止信号。请重试或选择“仅退出启动器”。",
        Some("managed_auth_unavailable") => "等待网页登录认证链接超时，服务仍由启动器托管，可能还在初始化。请先点击“重新检测”；若持续失败，请查看诊断日志。不会自动停止或重启服务。",
        Some("unverified_startup") => "无法确认启动中的服务身份，未停止进程。",
        Some("launcher_failure") => "WSL 启动器执行失败，请检查配置和日志。",
        Some("confirmation_required") => "停止服务前需要确认。",
        _ => "后端操作失败，请检查配置和日志。",
    }
    .to_owned()
}

/// Redact token= values of any length (not just URLs), and Bearer credentials.
/// ASCII markers are case-insensitive; quoted values may contain whitespace.
/// This is for diagnostics, never for validating a launch URL.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut offset = 0;
    while offset < text.len() {
        let rest = &text[offset..];
        if ascii_prefix(rest, "token=") {
            out.push_str(&rest[..6]);
            out.push_str("[REDACTED]");
            offset += 6;
            offset = credential_end(text, offset);
        } else if ascii_prefix(rest, "bearer")
            && (offset == 0
                || !text[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_'))
            && rest[6..].chars().next().is_some_and(char::is_whitespace)
        {
            out.push_str(&rest[..6]);
            offset += 6;
            while let Some(c) = text[offset..].chars().next() {
                if !c.is_whitespace() {
                    break;
                }
                out.push(c);
                offset += c.len_utf8();
            }
            out.push_str("[REDACTED]");
            offset = credential_end(text, offset);
        } else {
            let c = rest.chars().next().expect("nonempty suffix");
            out.push(c);
            offset += c.len_utf8();
        }
    }
    out
}

fn ascii_prefix(text: &str, prefix: &str) -> bool {
    text.as_bytes()
        .get(..prefix.len())
        .is_some_and(|bytes| bytes.eq_ignore_ascii_case(prefix.as_bytes()))
}

fn credential_end(text: &str, start: usize) -> usize {
    // Consume an existing marker, but still hide any appended secret suffix.
    let start = if text[start..].starts_with("[REDACTED]") {
        start + "[REDACTED]".len()
    } else {
        start
    };
    let rest = &text[start..];
    if let Some(quote @ ('"' | '\'')) = rest.chars().next() {
        let after_quote = start + quote.len_utf8();
        let mut escaped = false;
        for (index, c) in text[after_quote..].char_indices() {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == quote {
                return after_quote + index + c.len_utf8();
            }
        }
        return text.len();
    }
    for (index, c) in rest.char_indices() {
        if c.is_whitespace()
            || matches!(
                c,
                '&' | '#' | '"' | '\'' | '<' | '>' | ';' | ',' | ')' | ']' | '}'
            )
        {
            return start + index;
        }
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

    fn ready(url: &str, authenticated: bool) -> BackendReply {
        BackendReply {
            state: "ready".into(),
            url: Some(url.into()),
            authenticated,
            managed: false,
            pid: Some(42),
            code: None,
            service_log: None,
        }
    }

    #[test]
    fn cold_start_waits_past_three_seconds_then_accepts_the_auth_link() {
        use std::time::Duration;
        let start = Instant::now();
        let deadline = start + Duration::from_secs(120);
        let mut reply = ready("http://127.0.0.1:3080/", false);
        reply.managed = true;
        // Includes both a newly spawned service and an already-starting one:
        // readiness must not depend on whether this invocation spawned it.
        for seconds in [0, 3, 4, 15, 60, 119] {
            assert_eq!(
                wait_for_launch_authentication(
                    &reply,
                    401,
                    start + Duration::from_secs(seconds),
                    deadline
                ),
                Ok(true)
            );
            assert_eq!(validated_stop_pid(&reply), Ok(42));
        }
        reply.authenticated = true;
        reply.url = Some(format!("http://127.0.0.1:3080/?token={TOKEN}"));
        assert!(validated_launch_url(&reply, 3080).is_ok());
        assert_eq!(
            wait_for_launch_authentication(&reply, 401, start + Duration::from_secs(15), deadline),
            Ok(false)
        );
    }

    #[test]
    fn missing_authentication_expires_at_the_original_startup_deadline() {
        use std::time::Duration;
        let start = Instant::now();
        for seconds in [1, 2, 120] {
            let deadline = start + Duration::from_secs(seconds);
            let mut reply = ready("http://127.0.0.1:3080/", false);
            reply.managed = true;
            for now in [deadline, deadline + Duration::from_secs(1)] {
                let error = wait_for_launch_authentication(&reply, 401, now, deadline).unwrap_err();
                assert_eq!(error, backend_error(Some("managed_auth_unavailable")));
                assert!(error.contains("重新检测"));
                assert_eq!(validated_stop_pid(&reply), Ok(42));
            }
        }
    }

    #[test]
    fn authentication_wait_does_not_adopt_external_services_or_block_public_ones() {
        use std::time::Duration;
        let now = Instant::now();
        let deadline = now + Duration::from_secs(120);
        let mut reply = ready("http://127.0.0.1:3080/", false);
        assert!(wait_for_launch_authentication(&reply, 401, now, deadline).is_err());
        for managed in [false, true] {
            reply.managed = managed;
            assert_eq!(
                wait_for_launch_authentication(&reply, 200, now, deadline),
                Ok(false)
            );
        }
        reply.managed = false;
        reply.authenticated = true;
        assert_eq!(
            wait_for_launch_authentication(&reply, 401, now, deadline),
            Ok(false)
        );
        assert!(validated_stop_pid(&reply).is_err());
    }

    #[test]
    fn stop_identity_does_not_depend_on_browser_authentication() {
        for state in ["ready", "starting"] {
            let reply = parse_reply(
                format!(r#"{{"state":"{state}","managed":true,"authenticated":false,"pid":42}}"#)
                    .as_bytes(),
            )
            .unwrap();
            assert_eq!(validated_stop_pid(&reply).unwrap(), 42);
        }
        // Even an authenticated URL does not grant authority over an external PID.
        let external = ready(&format!("http://127.0.0.1:3080/?token={TOKEN}"), true);
        assert!(validated_stop_pid(&external).is_err());
        for json in [
            r#"{"state":"ready","managed":true}"#,
            r#"{"state":"starting","managed":true,"pid":0}"#,
            r#"{"state":"stopped","managed":true,"pid":42}"#,
            r#"{"state":"ready","authenticated":true,"pid":42}"#,
        ] {
            assert!(validated_stop_pid(&parse_reply(json.as_bytes()).unwrap()).is_err());
        }
    }

    #[test]
    fn accepts_helper_states_and_optional_fields() {
        for state in ["ready", "starting", "stopped", "logs"] {
            let json = format!(r#"{{"state":"{state}","already_stopped":true,"port":3080}}"#);
            let reply = parse_reply(json.as_bytes()).unwrap();
            assert_eq!(reply.state, state);
            assert!(!reply.authenticated);
            assert!(reply.url.is_none());
        }
        let json = format!(
            r#"{{"state":"ready","url":"http://127.0.0.1:3080/?token={TOKEN}","authenticated":true,"pid":42}}"#
        );
        let reply = parse_reply(json.as_bytes()).unwrap();
        assert_eq!(reply.pid, Some(42));
        assert!(validated_launch_url(&reply, 3080).is_ok());
        let logs = parse_reply(br#"{"state":"logs","service_log":"/tmp/web.log"}"#).unwrap();
        assert_eq!(logs.service_log.as_deref(), Some("/tmp/web.log"));
    }

    #[test]
    fn rejects_unknown_states_malformed_types_and_duplicate_fields() {
        for json in [
            r#"{"state":"READY"}"#,
            r#"{"state":"unknown"}"#,
            r#"{"state":"token=secret"}"#,
            r#"{}"#,
            r#"[]"#,
            r#"null"#,
            r#"{"state":"ready","authenticated":"true"}"#,
            r#"{"state":"ready","authenticated":null}"#,
            r#"{"state":"ready","pid":-1}"#,
            r#"{"state":"ready","pid":4294967296}"#,
            r#"{"state":"ready","url":123}"#,
            r#"{"state":"ready","state":"stopped"}"#,
            r#"{"state":"ready"} {"state":"stopped"}"#,
            r#"{"state":"ready",invalid token=secret}"#,
        ] {
            let error = parse_reply(json.as_bytes()).unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert!(parse_reply(&[0xff]).is_err());
        assert!(parse_reply(b"").is_err());
    }

    #[test]
    fn enforces_exact_64_kib_reply_limit() {
        let mut bytes = br#"{"state":"stopped"}"#.to_vec();
        bytes.resize(MAX_REPLY_BYTES, b' ');
        assert!(parse_reply(&bytes).is_ok());
        bytes.push(b' ');
        assert!(parse_reply(&bytes).unwrap_err().contains("64 KiB"));
    }

    #[test]
    fn error_replies_only_expose_static_mapping() {
        for code in [
            "port_in_use",
            "stop_timeout",
            "stop_incomplete",
            "process_changed",
            "unverified_startup",
            "launcher_failure",
            "confirmation_required",
        ] {
            let json = format!(r#"{{"state":"error","code":"{code}","message":"token=secret"}}"#);
            assert_eq!(
                parse_reply(json.as_bytes()).unwrap_err(),
                backend_error(Some(code))
            );
        }
        let json = br#"{"state":"error","code":"token=secret","message":"Bearer hidden"}"#;
        assert_eq!(parse_reply(json).unwrap_err(), backend_error(None));
        assert_eq!(
            parse_reply(br#"{"state":"error"}"#).unwrap_err(),
            backend_error(None)
        );
        assert!(!backend_error(Some("evil raw code")).contains("evil"));
    }

    #[test]
    fn accepts_only_expected_root_and_authentication_pairing() {
        for url in ["http://127.0.0.1:3080/", "http://127.0.0.1:3080/?"] {
            assert!(validated_launch_url(&ready(url, false), 3080).is_ok());
            assert!(validated_launch_url(&ready(url, true), 3080).is_err());
        }
        let url = format!("http://127.0.0.1:3080/?token={TOKEN}");
        assert!(validated_launch_url(&ready(&url, true), 3080).is_ok());
        assert!(validated_launch_url(&ready(&url, false), 3080).is_err());
        assert!(validated_launch_url(&ready("http://127.0.0.1:80/", false), 80).is_ok());
        assert!(validated_launch_url(&ready("http://127.0.0.1:0/", false), 0).is_err());
        for state in ["starting", "stopped", "logs", "error"] {
            let mut reply = ready(&url, true);
            reply.state = state.into();
            assert!(validated_launch_url(&reply, 3080).is_err());
        }
        let mut missing = ready(&url, true);
        missing.url = None;
        assert!(validated_launch_url(&missing, 3080).is_err());
    }

    #[test]
    fn rejects_malicious_hosts_ports_credentials_paths_and_fragments() {
        for url in [
            "https://127.0.0.1:3080/",
            "http://localhost:3080/",
            "http://127.0.0.1.evil:3080/",
            "http://evil:3080/",
            "http://127.0.0.2:3080/",
            "http://[::1]:3080/",
            "http://2130706433:3080/",
            "http://127.1:3080/",
            "http://0177.0.0.1:3080/",
            "http://0x7f000001:3080/",
            "http://127.0.0.1:3081/",
            "http://127.0.0.1/",
            "http://127.0.0.1:03080/",
            "http://user@127.0.0.1:3080/",
            "http://user:pass@127.0.0.1:3080/",
            "http://@127.0.0.1:3080/",
            "http://127.0.0.1:3080/other",
            "http://127.0.0.1:3080",
            "http://127.0.0.1:3080/./",
            "http://127.0.0.1:3080/a/../",
            "http://127.0.0.1:3080/%2e/",
            "http://127.0.0.1:3080//",
            "http://127.0.0.1:3080/#",
            "http://127.0.0.1:3080/#secret",
            " http://127.0.0.1:3080/",
            "http://127.0.0.1:3080/\n",
            "http://127.0.0.1:3080/\\evil",
        ] {
            let error = validated_launch_url(&ready(url, false), 3080).unwrap_err();
            assert_eq!(error, INVALID_URL, "unexpected error for adversarial URL");
        }
    }

    #[test]
    fn rejects_noncanonical_extra_repeated_and_malformed_query_values() {
        for query in [
            "other=value".to_owned(),
            "token=".into(),
            "token=short".into(),
            format!("token={TOKEN}x"),
            format!("token={TOKEN}&token={TOKEN}"),
            format!("token={TOKEN}&"),
            format!("token={TOKEN}&x=1"),
            format!("TOKEN={TOKEN}"),
            format!("%74oken={TOKEN}"),
            format!("token={TOKEN}#"),
            format!("token={TOKEN}#secret"),
            format!("token={TOKEN}?"),
            format!("token={TOKEN}\n"),
            format!("token={}+", &TOKEN[..42]),
            format!("token={}%41", &TOKEN[..42]),
            format!("token={}é", &TOKEN[..41]),
        ] {
            let raw = format!("http://127.0.0.1:3080/?{query}");
            for authenticated in [true, false] {
                assert_eq!(
                    validated_launch_url(&ready(&raw, authenticated), 3080).unwrap_err(),
                    INVALID_URL
                );
            }
        }
        for token in ["_".repeat(43), "-".repeat(43), "9".repeat(43)] {
            let raw = format!("http://127.0.0.1:3080/?token={token}");
            assert!(validated_launch_url(&ready(&raw, true), 3080).is_ok());
        }
    }

    #[test]
    fn redacts_non_url_short_long_repeated_and_unicode_credentials() {
        assert_eq!(
            redact("prefix token=a suffix"),
            "prefix token=[REDACTED] suffix"
        );
        assert_eq!(
            redact("?token=abc&token=def#end"),
            "?token=[REDACTED]&token=[REDACTED]#end"
        );
        assert_eq!(
            redact("TOKEN=私密值, token=\"secret with spaces\""),
            "TOKEN=[REDACTED], token=[REDACTED]"
        );
        assert_eq!(redact("token='secret with spaces'"), "token=[REDACTED]");
        assert_eq!(redact("token=\"unterminated secret"), "token=[REDACTED]");
        assert_eq!(
            redact("token=\"secret\\\"still secret\""),
            "token=[REDACTED]"
        );
        assert_eq!(
            redact(&format!("token={}", "x".repeat(100_000))),
            "token=[REDACTED]"
        );
        assert_eq!(
            redact("Authorization: Bearer abc.def_-/+=\nnext"),
            "Authorization: Bearer [REDACTED]\nnext"
        );
        assert_eq!(
            redact("bearer\t私密 bEaReR \"secret with spaces\""),
            "bearer\t[REDACTED] bEaReR [REDACTED]"
        );
        assert_eq!(
            redact("untouched 中文 NotBearer word token="),
            "untouched 中文 NotBearer word token=[REDACTED]"
        );
        assert_eq!(redact("token=[REDACTED]secret"), "token=[REDACTED]");
        let once = redact("token=secret & Bearer credential");
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn debug_never_discloses_url_or_embedded_credentials() {
        let mut reply = ready("malformed secret launch URL", true);
        reply.state = "ready token=state-secret".into();
        reply.code = Some("Bearer code-secret".into());
        reply.service_log = Some("/tmp/token=log-secret".into());
        let debug = format!("{reply:?}");
        for secret in ["launch URL", "state-secret", "code-secret", "log-secret"] {
            assert!(!debug.contains(secret));
        }
        assert!(debug.contains("[REDACTED]"));
    }
}
