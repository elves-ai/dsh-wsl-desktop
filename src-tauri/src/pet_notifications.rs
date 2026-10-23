//! Bounded, memory-only pet notification inbox. No window, transport or filesystem IO.
//! The target and event-deduplication key never belong to a frontend payload.
use serde::Serialize;
use std::collections::VecDeque;
use url::{Host, Url};

pub const PENDING_LIMIT: usize = 32;
pub const SEEN_LIMIT: usize = 256;
pub const TTL_MS: u64 = 5 * 60 * 1000;
const KEY_LIMIT: usize = 4096;
const ID_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BubbleKind {
    Completed,
    Failed,
    Waiting,
}

/// Deliberately only presentation strings: no URL, session identity or dedupe key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Payload {
    pub id: String,
    pub kind: BubbleKind,
    pub title: String,
    pub body: String,
}

struct Record<T> {
    payload: Payload,
    target: T,
    created_ms: u64,
    key: String,
}

pub struct Inbox<T> {
    pending: VecDeque<Record<T>>,
    seen: VecDeque<(String, u64)>,
}

impl<T> Default for Inbox<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Inbox<T> {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            seen: VecDeque::new(),
        }
    }

    fn prune(&mut self, now_ms: u64) {
        self.pending
            .retain(|record| now_ms.saturating_sub(record.created_ms) < TTL_MS);
        self.seen
            .retain(|(_, created_ms)| now_ms.saturating_sub(*created_ms) < TTL_MS);
    }

    /// Clock and opaque ID are supplied by native code; tests need no real timers.
    /// Invalid IDs/oversized keys are rejected rather than truncated into collisions.
    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &mut self,
        now_ms: u64,
        id: &str,
        target: T,
        kind: BubbleKind,
        title: &str,
        body: &str,
        key: &str,
    ) -> Option<Payload> {
        self.prune(now_ms);
        if !valid_id(id)
            || key.is_empty()
            || key.len() > KEY_LIMIT
            || self.seen.iter().any(|(seen, _)| seen == key)
            || self.pending.iter().any(|record| record.payload.id == id)
        {
            return None;
        }
        let payload = Payload {
            id: id.to_owned(),
            kind,
            title: summary(title, 80),
            body: summary(body, 180),
        };
        if self.pending.len() == PENDING_LIMIT {
            self.pending.pop_front();
        }
        if self.seen.len() == SEEN_LIMIT {
            self.seen.pop_front();
        }
        self.seen.push_back((key.to_owned(), now_ms));
        self.pending.push_back(Record {
            payload: payload.clone(),
            target,
            created_ms: now_ms,
            key: key.to_owned(),
        });
        Some(payload)
    }

    /// Snapshot, not consumption: subscribe-then-pull cannot lose the first event.
    pub fn pending(&mut self, now_ms: u64) -> Vec<Payload> {
        self.prune(now_ms);
        self.pending
            .iter()
            .map(|record| record.payload.clone())
            .collect()
    }

    pub fn target(&mut self, now_ms: u64, id: &str) -> Option<&T> {
        self.prune(now_ms);
        if !valid_id(id) {
            return None;
        }
        self.pending
            .iter()
            .find(|record| record.payload.id == id)
            .map(|record| &record.target)
    }

    /// Replace a passive reminder with its live interaction, including racing deliveries.
    pub fn suppress_key(&mut self, now_ms: u64, key: &str) -> Vec<String> {
        self.prune(now_ms);
        if key.is_empty() || key.len() > KEY_LIMIT {
            return Vec::new();
        }
        let ids = self
            .pending
            .iter()
            .filter(|r| r.key == key)
            .map(|r| r.payload.id.clone())
            .collect();
        self.pending.retain(|r| r.key != key);
        if !self.seen.iter().any(|(seen, _)| seen == key) {
            if self.seen.len() == SEEN_LIMIT {
                self.seen.pop_front();
            }
            self.seen.push_back((key.to_owned(), now_ms));
        }
        ids
    }
    /// Success/dismissal removes the target, but retains the bounded dedupe entry.
    /// A failed native navigation simply does not acknowledge, allowing retry.
    pub fn ack(&mut self, now_ms: u64, id: &str) -> bool {
        self.prune(now_ms);
        if !valid_id(id) {
            return false;
        }
        if let Some(index) = self
            .pending
            .iter()
            .position(|record| record.payload.id == id)
        {
            self.pending.remove(index);
            true
        } else {
            false
        }
    }

    /// Hidden/disabled pets must not accumulate an inbox for a later surprise replay.
    pub fn clear(&mut self) {
        self.pending.clear();
        self.seen.clear();
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_LIMIT
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Defense in depth; current-server origin validation remains native at open time.
/// Accept only the root loopback URL and canonical session fragment produced by
/// notifications::notification_session_url, never paths, credentials or query data.
pub fn valid_target(target: &Url) -> bool {
    if target.scheme() != "http"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.path() != "/"
        || target.query().is_some()
        || target.port_or_known_default() == Some(0)
        || !matches!(target.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())
            && !matches!(target.host(), Some(Host::Ipv6(ip)) if ip.is_loopback())
    {
        return false;
    }
    let Some(fragment) = target.fragment().filter(|fragment| fragment.len() <= 2048) else {
        return false;
    };
    let pairs: Vec<_> = url::form_urlencoded::parse(fragment.as_bytes()).collect();
    if pairs.len() != 2 || pairs[0].0 != "session" || pairs[1].0 != "notification" {
        return false;
    }
    let session = &pairs[0].1;
    let nonce = &pairs[1].1;
    if session.trim().is_empty()
        || session.len() > 256
        || session.chars().any(char::is_control)
        || nonce.parse::<u64>().is_err()
    {
        return false;
    }
    let canonical = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("session", session)
        .append_pair("notification", nonce)
        .finish();
    canonical == fragment && nonce.bytes().all(|byte| byte.is_ascii_digit())
}

/// Plain text only, Unicode-aware limits, single-line and no invisible controls.
/// HTML-looking task names remain inert strings; rendering must use textContent.
fn summary(text: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut length = 0;
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            space = !output.is_empty();
            continue;
        }
        if ch.is_control()
            || matches!(ch, '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        {
            continue;
        }
        if length + usize::from(space) + 1 > limit {
            if length == limit {
                output.pop();
            }
            output.push('…');
            break;
        }
        if space {
            output.push(' ');
            length += 1;
            space = false;
        }
        output.push(ch);
        length += 1;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_interaction_suppresses_existing_and_racing_passive_reminders() {
        let mut inbox = Inbox::new();
        assert!(inbox
            .insert(
                0,
                "one",
                1u8,
                BubbleKind::Waiting,
                "title",
                "body",
                "waiting:session:call"
            )
            .is_some());
        assert_eq!(
            inbox.suppress_key(1, "waiting:session:call"),
            vec!["one".to_string()]
        );
        assert!(inbox.pending(1).is_empty());
        assert!(inbox.target(1, "one").is_none());
        assert!(inbox
            .insert(
                2,
                "two",
                2u8,
                BubbleKind::Waiting,
                "title",
                "body",
                "waiting:session:call"
            )
            .is_none());
        assert!(inbox.suppress_key(3, "waiting:other:call").is_empty());
        assert!(inbox
            .insert(
                4,
                "three",
                3u8,
                BubbleKind::Waiting,
                "title",
                "body",
                "waiting:other:call"
            )
            .is_none());
    }

    fn put(inbox: &mut Inbox<String>, now: u64, index: usize) -> Option<Payload> {
        inbox.insert(
            now,
            &format!("pet-{index}"),
            format!("native-target-{index}"),
            BubbleKind::Completed,
            "任务完成",
            "摘要",
            &format!("event-{index}"),
        )
    }

    #[test]
    fn capacity_evicts_oldest_target_but_remembers_event() {
        let mut inbox = Inbox::new();
        for index in 0..PENDING_LIMIT + 1 {
            assert!(put(&mut inbox, 10, index).is_some());
        }
        let pending = inbox.pending(10);
        assert_eq!(pending.len(), PENDING_LIMIT);
        assert_eq!(pending[0].id, "pet-1");
        assert!(inbox.target(10, "pet-0").is_none());
        assert!(put(&mut inbox, 10, 0).is_none());
    }

    #[test]
    fn seen_cache_is_bounded_and_oldest_keys_can_be_reused() {
        let mut inbox = Inbox::new();
        for index in 0..SEEN_LIMIT + 1 {
            put(&mut inbox, 0, index);
        }
        assert_eq!(inbox.seen.len(), SEEN_LIMIT);
        assert_eq!(inbox.pending.len(), PENDING_LIMIT);
        assert!(put(&mut inbox, 0, 0).is_some());
        assert!(put(&mut inbox, 0, SEEN_LIMIT).is_none());
    }

    #[test]
    fn ttl_expires_at_boundary_for_lookup_snapshot_and_dedupe() {
        let mut inbox = Inbox::new();
        put(&mut inbox, 20, 0);
        assert!(inbox.target(20 + TTL_MS - 1, "pet-0").is_some());
        assert!(inbox.target(20 + TTL_MS, "pet-0").is_none());
        assert!(inbox.pending(20 + TTL_MS).is_empty());
        assert!(put(&mut inbox, 20 + TTL_MS, 0).is_some());
        assert!(!inbox.ack(20 + TTL_MS * 2, "pet-0"));
    }

    #[test]
    fn duplicate_event_does_not_refresh_ttl_or_replace_target() {
        let mut inbox = Inbox::new();
        put(&mut inbox, 0, 0);
        assert!(inbox
            .insert(
                100,
                "different-id",
                "wrong-target".into(),
                BubbleKind::Failed,
                "other",
                "other",
                "event-0"
            )
            .is_none());
        assert_eq!(
            inbox.target(100, "pet-0").map(String::as_str),
            Some("native-target-0")
        );
        assert!(inbox.pending(TTL_MS).is_empty());
    }

    #[test]
    fn lookup_failure_is_retryable_and_ack_prevents_pull_replay() {
        let mut inbox = Inbox::new();
        put(&mut inbox, 0, 0);
        assert_eq!(inbox.pending(1), inbox.pending(2));
        assert_eq!(
            inbox.target(3, "pet-0").cloned(),
            inbox.target(4, "pet-0").cloned()
        );
        assert!(inbox.ack(5, "pet-0"));
        assert!(!inbox.ack(6, "pet-0"));
        assert!(inbox.pending(7).is_empty());
        assert!(inbox.target(8, "pet-0").is_none());
        assert!(put(&mut inbox, 9, 0).is_none());
    }

    #[test]
    fn clear_drops_all_native_records_and_seen_keys() {
        let mut inbox = Inbox::new();
        put(&mut inbox, 0, 0);
        inbox.clear();
        assert!(inbox.pending(0).is_empty());
        assert!(inbox.seen.is_empty());
        assert!(inbox.target(0, "pet-0").is_none());
        assert!(put(&mut inbox, 0, 0).is_some());
    }

    #[test]
    fn evict_ack_clear_and_expiry_really_drop_native_targets() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct Target(Arc<AtomicUsize>);
        impl Drop for Target {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut inbox = Inbox::new();
        for index in 0..=PENDING_LIMIT {
            inbox.insert(
                0,
                &format!("pet-{index}"),
                Target(dropped.clone()),
                BubbleKind::Completed,
                "",
                "",
                &format!("event-{index}"),
            );
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(inbox.ack(0, "pet-1"));
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
        inbox.clear();
        assert_eq!(dropped.load(Ordering::SeqCst), PENDING_LIMIT + 1);
        inbox.insert(
            1,
            "last",
            Target(dropped.clone()),
            BubbleKind::Completed,
            "",
            "",
            "last",
        );
        assert!(inbox.pending(1 + TTL_MS).is_empty());
        assert_eq!(dropped.load(Ordering::SeqCst), PENDING_LIMIT + 2);
    }

    #[test]
    fn payload_serializes_only_four_plain_string_fields() {
        let mut inbox = Inbox::new();
        let xss = "<img src=x onerror=alert(1)> </script><script>alert(2)</script>";
        let payload = inbox
            .insert(
                0,
                "pet-1",
                "http://127.0.0.1/#session=secret",
                BubbleKind::Waiting,
                xss,
                "\"} , \"url\": \"javascript:alert(1)",
                "private-dedupe-key",
            )
            .unwrap();
        let json = serde_json::to_value(payload).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(object.len(), 4);
        assert_eq!(json["kind"], "waiting");
        assert_eq!(json["title"], xss);
        assert!(object.values().all(serde_json::Value::is_string));
        let encoded = serde_json::to_string(&json).unwrap();
        assert!(!encoded.contains("session=secret"));
        assert!(!encoded.contains("private-dedupe-key"));
        assert!(json.get("url").is_none());
        assert!(json.get("target").is_none());
        for (kind, name) in [
            (BubbleKind::Completed, "completed"),
            (BubbleKind::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }
    }

    #[test]
    fn summaries_are_unicode_bounded_and_strip_invisible_controls() {
        let mut inbox = Inbox::new();
        let payload = inbox
            .insert(
                0,
                "pet-1",
                (),
                BubbleKind::Failed,
                &"宠🐱".repeat(90),
                &"长任务".repeat(100),
                "key",
            )
            .unwrap();
        assert_eq!(payload.title.chars().count(), 80);
        assert_eq!(payload.body.chars().count(), 180);
        assert!(payload.title.ends_with('…'));
        assert_eq!(
            summary("  任务\n\t完成\0\u{202e} <b>ok</b>  ", 80),
            "任务 完成 <b>ok</b>"
        );
        assert_eq!(summary(&"a".repeat(80), 80).chars().count(), 80);
        assert_eq!(
            summary(&format!("{} b", "a".repeat(79)), 80)
                .chars()
                .count(),
            80
        );
    }

    #[test]
    fn invalid_or_oversized_ids_and_keys_do_not_enter_cache() {
        let mut inbox = Inbox::new();
        for id in [
            "".to_owned(),
            "a".repeat(129),
            "http://evil".into(),
            "../session".into(),
            "id\0".into(),
        ] {
            assert!(inbox
                .insert(0, &id, (), BubbleKind::Completed, "", "", "key")
                .is_none());
        }
        for key in [String::new(), "a".repeat(KEY_LIMIT + 1)] {
            assert!(inbox
                .insert(0, "valid", (), BubbleKind::Completed, "", "", &key)
                .is_none());
        }
        assert!(inbox.pending(0).is_empty());
        assert!(inbox
            .insert(
                0,
                &"a".repeat(128),
                (),
                BubbleKind::Completed,
                "",
                "",
                "key"
            )
            .is_some());
    }

    #[test]
    fn duplicate_id_does_not_overwrite_unrelated_target() {
        let mut inbox = Inbox::new();
        put(&mut inbox, 0, 0);
        assert!(inbox
            .insert(
                0,
                "pet-0",
                "other".into(),
                BubbleKind::Failed,
                "",
                "",
                "other-event"
            )
            .is_none());
        assert_eq!(
            inbox.target(0, "pet-0").map(String::as_str),
            Some("native-target-0")
        );
        assert_eq!(inbox.seen.len(), 1);
    }

    #[test]
    fn accepts_only_loopback_canonical_session_targets() {
        for target in [
            "http://127.0.0.1:3080/#session=abc&notification=1",
            "http://[::1]:3080/#session=a+b%2F%E4%BB%BB%E5%8A%A1&notification=123",
        ] {
            assert!(valid_target(&Url::parse(target).unwrap()), "{target}");
        }
        for target in [
            "https://127.0.0.1/#session=a&notification=1",
            "http://example.com/#session=a&notification=1",
            "http://127.0.0.1:0/#session=a&notification=1",
            "http://user:pass@127.0.0.1/#session=a&notification=1",
            "http://127.0.0.1/other#session=a&notification=1",
            "http://127.0.0.1/?token=secret#session=a&notification=1",
            "http://127.0.0.1/#session=a",
            "http://127.0.0.1/#session=&notification=1",
            "http://127.0.0.1/#session=a&notification=1&session=b",
            "http://127.0.0.1/#session=a&notification=bad",
            "http://127.0.0.1/#session=a%00b&notification=1",
            "http://127.0.0.1/#session=a&notification=18446744073709551616",
            "http://127.0.0.1/#session=a%ZZ&notification=1",
        ] {
            assert!(!valid_target(&Url::parse(target).unwrap()), "{target}");
        }
    }
}
