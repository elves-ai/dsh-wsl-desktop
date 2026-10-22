//! Read-only, cross-platform policy for questions requiring user attention.
//! No question text, arguments, transport, or native notification state is retained.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const LIMIT: usize = 4096;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
type Key = (String, String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttentionNotice {
    pub session_id: String,
    pub call_id: String,
}

#[derive(Clone, Debug, Default)]
pub struct AttentionTracker {
    cursors: BTreeMap<String, Cursor>,
    candidates: BTreeSet<Key>,
    seen: BTreeSet<Key>,
}

#[derive(Clone, Debug)]
struct Cursor {
    cut: i64,
    folded: Fold,
}

#[derive(Clone, Debug, Default)]
struct Fold {
    direct: BTreeSet<String>,
    // Keep non-attention dispatch ancestors too: completing a parent cancels
    // every descendant, not just a dispatch whose own name needs attention.
    nested: BTreeMap<String, Dispatch>,
}

#[derive(Clone, Debug)]
struct Dispatch {
    root: String,
    parent: String,
    attention: bool,
}

impl AttentionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// A notification settings epoch change permits current pending calls again.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Reconnect must establish a fresh blocking baseline without replaying
    /// notices already consumed (including notices suppressed in foreground).
    pub fn disconnected(&mut self) {
        self.cursors.clear();
        self.candidates.clear();
    }

    /// Read the current maxMessages=1 page at the supplied inclusive cut.
    /// A blocking start is only a hint (validation/guards can still reject it):
    /// require two successful polls, normally about 3–6 seconds, not equal cuts.
    /// Timed active projections are authoritative and can notify immediately.
    /// Returning a notice consumes it even if the adapter stays silent in front.
    /// On any error *all* tracker state remains unchanged; closure I/O cannot be
    /// rolled back. Errors from the reader are returned unchanged to its owner.
    pub fn poll(
        &mut self,
        list: &Value,
        mut read_page: impl FnMut(&str, i64) -> Result<Value, String>,
    ) -> Result<Vec<AttentionNotice>, String> {
        let mut next = self.clone();
        let notices = next.poll_inner(list, &mut read_page)?;
        *self = next;
        Ok(notices)
    }

    fn poll_inner(
        &mut self,
        list: &Value,
        read_page: &mut impl FnMut(&str, i64) -> Result<Value, String>,
    ) -> Result<Vec<AttentionNotice>, String> {
        let items = list
            .get("items")
            .and_then(Value::as_array)
            .ok_or("Attention session list is invalid.")?;
        let mut sessions = BTreeSet::new();
        let mut previous_cursors = std::mem::take(&mut self.cursors);
        let mut folded_count = 0;
        let mut pending = BTreeSet::new();
        let mut immediate = BTreeSet::new();
        for item in items {
            let row = item
                .as_object()
                .ok_or("Attention session row is invalid.")?;
            if row.get("agentAvailable").and_then(Value::as_bool) != Some(true)
                || row.get("origin").and_then(Value::as_str) == Some("subagent")
            {
                continue;
            }
            let Some(projections) = row.get("projections") else {
                continue;
            };
            if projections.get("kind").and_then(Value::as_str) != Some("sequenced") {
                continue;
            }
            let session = identifier(row.get("sessionId"))?;
            if !sessions.insert(session.to_owned()) {
                return Err("Attention session list contains duplicate identifiers.".into());
            }
            bounded(sessions.len())?;
            let running = row
                .get("running")
                .and_then(Value::as_bool)
                .ok_or("Attention running state is invalid.")?;
            let cut = sequence(projections.get("asOfSeq"))?;
            let (active, queued) = active_calls(projections)?;
            for call in active.difference(&queued) {
                insert_key(&mut immediate, session, call)?;
            }
            if !running {
                continue;
            }
            let previous = previous_cursors.remove(session);
            if previous.as_ref().is_some_and(|cursor| cut < cursor.cut) {
                // A rebuilt log is a new blocking baseline, not a second
                // observation of the old lifecycle. Keep consumed IDs deduped.
                self.candidates.retain(|key| key.0 != session);
            }
            let cursor = match previous {
                Some(cursor) if cursor.cut == cut => cursor,
                _ => {
                    let page = read_page(session, cut)?;
                    Cursor {
                        cut,
                        folded: fold_page(&page, cut)?,
                    }
                }
            };
            folded_count += cursor.folded.direct.len() + cursor.folded.nested.len();
            bounded(folded_count)?;
            self.cursors.insert(session.to_owned(), cursor);
            let folded = &self.cursors[session].folded;
            for call in &folded.direct {
                if !queued.contains(call) {
                    insert_key(&mut pending, session, call)?;
                }
            }
            for (call, dispatch) in &folded.nested {
                if dispatch.attention && !queued.contains(call) {
                    insert_key(&mut pending, session, call)?;
                }
            }
        }
        let mut notices = Vec::new();
        // A successful poll without a candidate breaks its consecutive baseline.
        for key in pending
            .intersection(&self.candidates)
            .chain(immediate.iter())
        {
            if self.seen.insert(key.clone()) {
                bounded(self.seen.len())?;
                notices.push(AttentionNotice {
                    session_id: key.0.clone(),
                    call_id: key.1.clone(),
                });
            }
        }
        self.candidates = pending;
        Ok(notices)
    }
}

fn bounded(size: usize) -> Result<(), String> {
    if size > LIMIT {
        Err("Attention state exceeds the safety limit; reset is required.".into())
    } else {
        Ok(())
    }
}

fn identifier(value: Option<&Value>) -> Result<&str, String> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= LIMIT && !id.chars().any(char::is_control))
        .ok_or_else(|| "Attention identifier is invalid.".into())
}

fn sequence(value: Option<&Value>) -> Result<i64, String> {
    value
        .and_then(Value::as_i64)
        .filter(|seq| (-1..=MAX_SAFE_INTEGER).contains(seq))
        .ok_or_else(|| "Attention sequence is invalid.".into())
}

fn insert_key(keys: &mut BTreeSet<Key>, session: &str, call: &str) -> Result<(), String> {
    keys.insert((session.to_owned(), call.to_owned()));
    bounded(keys.len())
}

fn attention_name(name: &str) -> bool {
    matches!(name, "ask_user_question" | "exit_plan_mode")
}

/// Only metadata is accessed. In particular, never inspect or clone questions,
/// answers, arguments, or queued message bodies.
fn active_calls(projections: &Value) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let mut active = BTreeSet::new();
    let mut queued = BTreeSet::new();
    let mut continued = BTreeSet::new();
    let Some(values) = projections.get("values") else {
        return Ok((active, queued));
    };
    if !values.is_object() {
        return Err("Attention projection values are invalid.".into());
    }
    if let Some(questions) = values.get("userQuestions") {
        let rows = questions
            .get("active")
            .and_then(Value::as_array)
            .ok_or("Attention active question projection is invalid.")?;
        bounded(rows.len())?;
        for row in rows {
            let call = identifier(row.get("callId"))?;
            if !matches!(
                row.get("state").and_then(Value::as_str),
                Some("open" | "continued")
            ) {
                return Err("Attention active question state is invalid.".into());
            }
            if row.get("state").and_then(Value::as_str) == Some("continued") {
                continued.insert(call.to_owned());
            }
            if !active.insert(call.to_owned()) {
                return Err("Attention active question identifiers are duplicated.".into());
            }
        }
    }
    if let Some(inbox) = values.get("inbox") {
        if !inbox.is_object() {
            return Err("Attention inbox projection is invalid.".into());
        }
        for lane in ["next-turn", "next-step"] {
            let Some(messages) = inbox.get(lane) else {
                continue;
            };
            let messages = messages
                .as_array()
                .ok_or("Attention inbox lane is invalid.")?;
            for message in messages {
                let message = message
                    .as_object()
                    .ok_or("Attention inbox item is invalid.")?;
                let Some(source) = message.get("source") else {
                    continue;
                };
                if !source.is_object() {
                    return Err("Attention inbox source is invalid.".into());
                }
                if source.get("kind").and_then(Value::as_str) == Some("user-question-reply") {
                    queued.insert(identifier(source.get("callId"))?.to_owned());
                    bounded(queued.len())?;
                }
            }
        }
    }
    queued.retain(|call| continued.contains(call));
    Ok((active, queued))
}

fn fold_page(page: &Value, cut: i64) -> Result<Fold, String> {
    let records = page
        .get("records")
        .and_then(Value::as_array)
        .ok_or("Attention event page is invalid.")?;
    // hasMore describes older message groups, not truncation of this tail page.
    page.get("hasMore")
        .and_then(Value::as_bool)
        .ok_or("Attention event pagination flag is invalid.")?;
    let mut folded = Fold::default();
    let mut last = None;
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("event") {
            return Err("Attention event record is invalid.".into());
        }
        let event = record.get("event").ok_or("Attention event is missing.")?;
        let seq = sequence(event.get("seq"))?;
        if seq < 0 || seq > cut || last.is_some_and(|previous| seq != previous + 1) {
            return Err("Attention event sequence is invalid or unordered.".into());
        }
        last = Some(seq);
        event
            .get("time")
            .and_then(Value::as_u64)
            .filter(|time| *time <= MAX_SAFE_INTEGER as u64)
            .ok_or("Attention event time is invalid.")?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .ok_or("Attention event type is invalid.")?;
        let data = event
            .get("data")
            .ok_or("Attention event data is missing.")?;
        match kind {
            "turn/start" | "turn/end" | "step/end" | "session/end-seed" => folded = Fold::default(),
            "tool/call" => {
                let name = data
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("Attention tool name is invalid.")?;
                if attention_name(name) {
                    folded
                        .direct
                        .insert(identifier(data.get("callId"))?.to_owned());
                }
            }
            "tool/ptc-dispatch-start" => {
                let name = data
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("Attention dispatch name is invalid.")?;
                let root = identifier(data.get("rootCallId"))?.to_owned();
                let parent = identifier(data.get("parentCallId"))?.to_owned();
                let sub = identifier(data.get("subCallId"))?.to_owned();
                if sub == root || sub == parent || folded.nested.contains_key(&sub) {
                    return Err("Attention dispatch ancestry is invalid.".into());
                }
                folded.nested.insert(
                    sub,
                    Dispatch {
                        root,
                        parent,
                        attention: attention_name(name),
                    },
                );
            }
            "tool/result" => {
                let call = identifier(
                    data.get("message")
                        .and_then(|message| message.get("toolCallId")),
                )?;
                folded.direct.remove(call);
                folded.nested.retain(|_, dispatch| dispatch.root != call);
                folded.remove_dispatch(call);
            }
            "tool/ptc-dispatch" => folded.remove_dispatch(identifier(data.get("subCallId"))?),
            _ => {}
        }
        bounded(folded.direct.len() + folded.nested.len())?;
    }
    if (cut >= 0 && last != Some(cut)) || (cut == -1 && !records.is_empty()) {
        return Err("Attention event page does not cover the requested cut.".into());
    }
    Ok(folded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, cut: i64, running: bool) -> Value {
        json!({"sessionId":id,"agentAvailable":true,"running":running,
            "projections":{"kind":"sequenced","asOfSeq":cut}})
    }
    fn list(rows: Vec<Value>) -> Value {
        json!({"items":rows})
    }
    fn event(seq: i64, kind: &str, data: Value) -> Value {
        json!({"type":"event","event":{"seq":seq,"time":1,"type":kind,"data":data}})
    }
    fn call(seq: i64, id: &str, name: &str) -> Value {
        event(
            seq,
            "tool/call",
            json!({"callId":id,"name":name,"arguments":{"secret":"do not retain"}}),
        )
    }
    fn result(seq: i64, id: &str) -> Value {
        event(
            seq,
            "tool/result",
            json!({"message":{"toolCallId":id,"content":"private"}}),
        )
    }
    fn nested(seq: i64, sub: &str, parent: &str, root: &str, name: &str) -> Value {
        event(
            seq,
            "tool/ptc-dispatch-start",
            json!({"subCallId":sub,"parentCallId":parent,
            "rootCallId":root,"name":name,"arguments":{"secret":"do not retain"}}),
        )
    }
    fn page(records: Vec<Value>) -> Value {
        json!({"records":records,"hasMore":false})
    }
    fn poll(tracker: &mut AttentionTracker, rows: &Value, page: &Value) -> Vec<AttentionNotice> {
        tracker.poll(rows, |_, _| Ok(page.clone())).unwrap()
    }
    fn notice(session: &str, call: &str) -> AttentionNotice {
        AttentionNotice {
            session_id: session.into(),
            call_id: call.into(),
        }
    }
    fn timed(id: &str, state: &str, running: bool) -> Value {
        let mut row = row("s", 0, running);
        row["projections"]["values"] = json!({"userQuestions":{"active":[{
            "callId":id,"state":state,"questions":[{"question":"PRIVATE QUESTION"}]}]}});
        row
    }
    fn fingerprint(tracker: &AttentionTracker) -> String {
        format!("{tracker:?}")
    }

    #[test]
    fn direct_existing_pending_confirms_second_poll_and_reads_same_cut_once() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 0, true)]);
        let data = page(vec![call(0, "q", "ask_user_question")]);
        let mut reads = 0;
        for n in 0..5 {
            let notices = tracker
                .poll(&rows, |id, cut| {
                    assert_eq!((id, cut), ("s", 0));
                    reads += 1;
                    Ok(data.clone())
                })
                .unwrap();
            assert_eq!(
                notices,
                if n == 1 {
                    vec![notice("s", "q")]
                } else {
                    vec![]
                }
            );
        }
        assert_eq!(reads, 1);
    }

    #[test]
    fn direct_exit_plan_mode_is_attention() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 0, true)]);
        let data = page(vec![call(0, "plan", "exit_plan_mode")]);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "plan")]);
    }

    #[test]
    fn changed_sequence_confirms_same_key() {
        let mut tracker = AttentionTracker::new();
        let first = call(7, "q", "ask_user_question");
        let mut data = page(vec![first.clone()]);
        data["hasMore"] = json!(true);
        assert!(poll(&mut tracker, &list(vec![row("s", 7, true)]), &data).is_empty());
        let mut next = page(vec![first, event(8, "tool/progress", json!({}))]);
        next["hasMore"] = json!(true);
        assert_eq!(
            poll(&mut tracker, &list(vec![row("s", 8, true)]), &next),
            vec![notice("s", "q")]
        );
    }

    #[test]
    fn non_attention_tools_and_code_strings_do_not_notify() {
        for name in [
            "run_code",
            "prefixask_user_question",
            "ask_user_question_suffix",
            "tools.ask_user_question",
        ] {
            let mut tracker = AttentionTracker::new();
            let mut invocation = call(0, "x", name);
            invocation["event"]["data"]["arguments"] =
                json!({"code":"await tools.ask_user_question({}); exit_plan_mode"});
            let rows = list(vec![row("s", 0, true)]);
            let data = page(vec![invocation]);
            assert!(poll(&mut tracker, &rows, &data).is_empty());
            assert!(poll(&mut tracker, &rows, &data).is_empty());
        }
    }

    #[test]
    fn fast_answer_or_guard_failure_never_confirms() {
        for terminal in [
            result(1, "q"),
            event(1, "turn/end", json!({})),
            event(1, "step/end", json!({})),
        ] {
            let mut tracker = AttentionTracker::new();
            let start = call(0, "q", "ask_user_question");
            assert!(poll(
                &mut tracker,
                &list(vec![row("s", 0, true)]),
                &page(vec![start.clone()])
            )
            .is_empty());
            let rows = list(vec![row("s", 1, true)]);
            let data = page(vec![start, terminal]);
            assert!(poll(&mut tracker, &rows, &data).is_empty());
            assert!(poll(&mut tracker, &rows, &data).is_empty());
        }
    }

    #[test]
    fn all_page_events_are_folded_before_confirmation() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 3, true)]);
        let data = page(vec![
            call(0, "old", "ask_user_question"),
            result(1, "old"),
            call(2, "plan", "exit_plan_mode"),
            event(3, "tool/progress", json!({})),
        ]);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "plan")]);
    }

    #[test]
    fn turn_step_and_seed_boundaries_clear_all_blocking() {
        for boundary in ["turn/start", "turn/end", "step/end", "session/end-seed"] {
            let mut tracker = AttentionTracker::new();
            let rows = list(vec![row("s", 2, true)]);
            let data = page(vec![
                call(0, "direct", "ask_user_question"),
                nested(1, "sub", "root", "root", "exit_plan_mode"),
                event(2, boundary, json!({})),
            ]);
            assert!(poll(&mut tracker, &rows, &data).is_empty());
            assert!(poll(&mut tracker, &rows, &data).is_empty());
        }
    }

    #[test]
    fn live_call_after_seed_is_not_lost() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 2, true)]);
        let data = page(vec![
            call(0, "history", "ask_user_question"),
            event(1, "session/end-seed", json!({})),
            call(2, "live", "ask_user_question"),
        ]);
        poll(&mut tracker, &rows, &data);
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "live")]);
    }

    #[test]
    fn nested_questions_and_plan_confirm_by_sub_id() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 2, true)]);
        let data = page(vec![
            call(0, "root", "run_code"),
            nested(1, "q", "root", "root", "ask_user_question"),
            nested(2, "p", "root", "root", "exit_plan_mode"),
        ]);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(
            poll(&mut tracker, &rows, &data),
            vec![notice("s", "p"), notice("s", "q")]
        );
    }

    #[test]
    fn parallel_nested_completion_clears_only_its_branch() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 3, true)]);
        let data = page(vec![
            nested(0, "a", "root", "root", "ask_user_question"),
            nested(1, "b", "root", "root", "ask_user_question"),
            nested(2, "c", "other", "other", "exit_plan_mode"),
            event(3, "tool/ptc-dispatch", json!({"subCallId":"a"})),
        ]);
        poll(&mut tracker, &rows, &data);
        assert_eq!(
            poll(&mut tracker, &rows, &data),
            vec![notice("s", "b"), notice("s", "c")]
        );
    }

    #[test]
    fn root_result_cancels_every_nested_in_that_root() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 3, true)]);
        let data = page(vec![
            nested(0, "a", "root", "root", "ask_user_question"),
            nested(1, "b", "a", "root", "exit_plan_mode"),
            nested(2, "keep", "other", "other", "ask_user_question"),
            result(3, "root"),
        ]);
        poll(&mut tracker, &rows, &data);
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "keep")]);
    }

    #[test]
    fn non_attention_parent_dispatch_completion_cancels_all_descendants() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 4, true)]);
        let data = page(vec![
            nested(0, "parent", "root", "root", "run_code"),
            nested(1, "middle", "parent", "root", "run_code"),
            nested(2, "child", "middle", "root", "ask_user_question"),
            nested(3, "sibling", "root", "root", "exit_plan_mode"),
            event(4, "tool/ptc-dispatch", json!({"subCallId":"parent"})),
        ]);
        poll(&mut tracker, &rows, &data);
        assert_eq!(
            poll(&mut tracker, &rows, &data),
            vec![notice("s", "sibling")]
        );
    }

    #[test]
    fn parent_tool_result_also_cancels_dispatch_descendants() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 2, true)]);
        let data = page(vec![
            nested(0, "p", "root", "root", "run_code"),
            nested(1, "q", "p", "root", "ask_user_question"),
            result(2, "p"),
        ]);
        poll(&mut tracker, &rows, &data);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
    }

    #[test]
    fn timed_active_first_poll_works_when_not_running() {
        for state in ["open", "continued"] {
            let mut tracker = AttentionTracker::new();
            let rows = list(vec![timed("q", state, false)]);
            assert_eq!(
                tracker
                    .poll(&rows, |_, _| panic!("idle timed rows need no page"))
                    .unwrap(),
                vec![notice("s", "q")]
            );
            assert!(tracker
                .poll(&rows, |_, _| panic!("no page"))
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn active_and_direct_and_nested_share_one_seen_key() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![timed("q", "open", true)]);
        let data = page(vec![call(0, "q", "ask_user_question")]);
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "q")]);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        let next = list(vec![row("s", 1, true)]);
        let data = page(vec![nested(1, "q", "root", "root", "ask_user_question")]);
        assert!(poll(&mut tracker, &next, &data).is_empty());
        assert!(poll(&mut tracker, &next, &data).is_empty());
    }

    #[test]
    fn queued_continued_replies_suppress_both_inbox_lanes() {
        for lane in ["next-turn", "next-step"] {
            let mut tracker = AttentionTracker::new();
            let mut queued = timed("q", "continued", false);
            queued["projections"]["values"]["inbox"] = json!({});
            queued["projections"]["values"]["inbox"][lane] =
                json!([{"source":{"kind":"user-question-reply","callId":"q"}}]);
            assert!(poll(&mut tracker, &list(vec![queued.clone()]), &page(vec![])).is_empty());
            assert!(poll(&mut tracker, &list(vec![queued]), &page(vec![])).is_empty());
            assert!(tracker.seen.is_empty());
            // Suppression is temporary, not an acknowledgment, if queued work disappears.
            assert_eq!(
                poll(
                    &mut tracker,
                    &list(vec![timed("q", "continued", false)]),
                    &page(vec![])
                ),
                vec![notice("s", "q")]
            );
        }
    }

    #[test]
    fn queued_reply_does_not_suppress_open_or_another_call() {
        for (state, queued_call) in [("open", "q"), ("continued", "other")] {
            let mut tracker = AttentionTracker::new();
            let mut row = timed("q", state, false);
            row["projections"]["values"]["inbox"] = json!({"next-step":[{"source":{"kind":"user-question-reply","callId":queued_call}}]});
            assert_eq!(
                poll(&mut tracker, &list(vec![row]), &page(vec![])),
                vec![notice("s", "q")]
            );
        }
    }

    #[test]
    fn active_projection_does_not_retain_question_or_answer_text() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![timed("q", "open", false)]);
        poll(&mut tracker, &rows, &page(vec![]));
        assert!(!fingerprint(&tracker).contains("PRIVATE QUESTION"));
        // The policy deliberately does not validate or read question bodies.
        let mut row = timed("another", "continued", false);
        row["projections"]["values"]["userQuestions"]["active"][0]["questions"] = json!("unread");
        assert_eq!(
            poll(&mut tracker, &list(vec![row]), &page(vec![])),
            vec![notice("s", "another")]
        );
    }

    #[test]
    fn fork_parent_is_allowed_subagent_and_unavailable_are_ignored() {
        let mut tracker = AttentionTracker::new();
        let mut fork = row("fork", 0, true);
        fork["parentSessionId"] = json!("parent");
        let mut sub = timed("q", "open", false);
        sub["origin"] = json!("subagent");
        let mut unavailable = timed("q", "open", false);
        unavailable["agentAvailable"] = json!(false);
        let rows = list(vec![fork, sub, unavailable]);
        let data = page(vec![call(0, "q", "ask_user_question")]);
        poll(&mut tracker, &rows, &data);
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("fork", "q")]);
    }

    #[test]
    fn successful_absence_breaks_confirmation_including_running_false() {
        for absent in [list(vec![]), list(vec![row("s", 0, false)])] {
            let mut tracker = AttentionTracker::new();
            let rows = list(vec![row("s", 0, true)]);
            let data = page(vec![call(0, "q", "ask_user_question")]);
            poll(&mut tracker, &rows, &data);
            assert!(poll(&mut tracker, &absent, &page(vec![])).is_empty());
            assert!(poll(&mut tracker, &rows, &data).is_empty());
            assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "q")]);
        }
    }

    #[test]
    fn disappearing_call_and_new_call_have_distinct_confirmation() {
        let mut tracker = AttentionTracker::new();
        poll(
            &mut tracker,
            &list(vec![row("s", 0, true)]),
            &page(vec![call(0, "old", "ask_user_question")]),
        );
        let rows = list(vec![row("s", 2, true)]);
        let data = page(vec![
            call(0, "old", "ask_user_question"),
            result(1, "old"),
            call(2, "new", "ask_user_question"),
        ]);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "new")]);
    }

    #[test]
    fn notices_are_consumed_even_when_foreground_adapter_discards_them() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![timed("q", "open", false)]);
        drop(poll(&mut tracker, &rows, &page(vec![])));
        assert!(poll(&mut tracker, &rows, &page(vec![])).is_empty());
    }

    #[test]
    fn reset_rearms_but_disconnected_preserves_consumed_notices() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 0, true)]);
        let data = page(vec![call(0, "q", "ask_user_question")]);
        poll(&mut tracker, &rows, &data);
        assert_eq!(poll(&mut tracker, &rows, &data).len(), 1);
        tracker.disconnected();
        assert!(tracker.cursors.is_empty());
        assert!(tracker.candidates.is_empty());
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        tracker.reset();
        assert!(tracker.seen.is_empty());
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(poll(&mut tracker, &rows, &data).len(), 1);
    }

    #[test]
    fn disconnect_before_confirmation_requires_fresh_two_polls() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 0, true)]);
        let data = page(vec![call(0, "q", "ask_user_question")]);
        poll(&mut tracker, &rows, &data);
        tracker.disconnected();
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(poll(&mut tracker, &rows, &data).len(), 1);
    }

    #[test]
    fn reader_error_propagates_without_partial_cursors_or_confirmation() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("a", 0, true), row("b", 0, true)]);
        let before = fingerprint(&tracker);
        assert_eq!(
            tracker
                .poll(&rows, |id, _| if id == "a" {
                    Ok(page(vec![call(0, "q", "ask_user_question")]))
                } else {
                    Err("reader unavailable".into())
                })
                .unwrap_err(),
            "reader unavailable"
        );
        assert_eq!(fingerprint(&tracker), before);
        assert!(poll(
            &mut tracker,
            &rows,
            &page(vec![call(0, "q", "ask_user_question")])
        )
        .is_empty());
    }

    #[test]
    fn invalid_later_row_does_not_consume_timed_notices_or_baseline() {
        let mut tracker = AttentionTracker::new();
        let mut invalid = row("bad", 0, false);
        invalid["running"] = json!("secret invalid");
        let rows = list(vec![timed("q", "open", false), invalid]);
        let before = fingerprint(&tracker);
        let error = tracker.poll(&rows, |_, _| panic!("no read")).unwrap_err();
        assert!(!error.contains("secret"));
        assert_eq!(fingerprint(&tracker), before);
        assert_eq!(
            poll(
                &mut tracker,
                &list(vec![timed("q", "open", false)]),
                &page(vec![])
            ),
            vec![notice("s", "q")]
        );
    }

    #[test]
    fn failed_poll_neither_advances_nor_clears_existing_confirmation() {
        let mut tracker = AttentionTracker::new();
        let rows = list(vec![row("s", 0, true)]);
        let data = page(vec![call(0, "q", "ask_user_question")]);
        poll(&mut tracker, &rows, &data);
        let before = fingerprint(&tracker);
        assert!(tracker
            .poll(&list(vec![row("s", 1, true)]), |_, _| Ok(page(vec![])))
            .is_err());
        assert_eq!(fingerprint(&tracker), before);
        assert_eq!(poll(&mut tracker, &rows, &data), vec![notice("s", "q")]);
    }

    #[test]
    fn malformed_pages_fail_closed_without_partial_state() {
        let good = call(0, "q", "ask_user_question");
        let mut bad_time = good.clone();
        bad_time["event"]["time"] = json!(MAX_SAFE_INTEGER + 1);
        let mut missing_data = good.clone();
        missing_data["event"]
            .as_object_mut()
            .unwrap()
            .remove("data");
        let mut missing_id = good.clone();
        missing_id["event"]["data"]["callId"] = json!(null);
        let cases = vec![
            json!({}),
            json!({"records":[],"hasMore":false}),
            json!({"records":[good.clone()]}),
            json!({"records":[good.clone()],"hasMore":"secret"}),
            page(vec![json!({"type":"header"})]),
            page(vec![bad_time]),
            page(vec![missing_data]),
            page(vec![missing_id]),
            page(vec![good.clone(), good]),
            page(vec![event(-1, "turn/start", json!({}))]),
            page(vec![event(1, "turn/start", json!({}))]),
        ];
        for data in cases {
            let mut tracker = AttentionTracker::new();
            let before = fingerprint(&tracker);
            let error = tracker
                .poll(&list(vec![row("s", 0, true)]), |_, _| Ok(data.clone()))
                .unwrap_err();
            assert_eq!(fingerprint(&tracker), before);
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn pages_with_internal_gaps_or_descending_sequences_are_rejected() {
        for records in [
            vec![
                event(0, "turn/start", json!({})),
                call(2, "q", "ask_user_question"),
            ],
            vec![
                event(2, "turn/start", json!({})),
                call(1, "q", "ask_user_question"),
            ],
        ] {
            assert!(fold_page(&page(records), 2).is_err());
        }
    }

    #[test]
    fn minus_one_empty_page_and_max_safe_sequence_are_valid() {
        let mut tracker = AttentionTracker::new();
        assert!(poll(&mut tracker, &list(vec![row("s", -1, true)]), &page(vec![])).is_empty());
        let rows = list(vec![row("s", MAX_SAFE_INTEGER, true)]);
        let data = page(vec![call(MAX_SAFE_INTEGER, "q", "ask_user_question")]);
        assert!(poll(&mut tracker, &rows, &data).is_empty());
        assert_eq!(poll(&mut tracker, &rows, &data).len(), 1);
    }

    #[test]
    fn unsafe_or_non_integer_sequences_and_missing_running_are_rejected() {
        for invalid in [
            json!(-2),
            json!(MAX_SAFE_INTEGER + 1),
            json!(0.5),
            json!("0"),
            json!(null),
            json!(u64::MAX),
        ] {
            let mut bad = row("s", 0, false);
            bad["projections"]["asOfSeq"] = invalid;
            assert!(AttentionTracker::new()
                .poll(&list(vec![bad]), |_, _| panic!("no read"))
                .is_err());
        }
        let mut bad = row("s", 0, false);
        bad.as_object_mut().unwrap().remove("running");
        assert!(AttentionTracker::new()
            .poll(&list(vec![bad]), |_, _| panic!("no read"))
            .is_err());
    }

    #[test]
    fn malformed_lists_ids_active_and_inbox_are_rejected() {
        for rows in [
            json!({}),
            json!({"items":null}),
            list(vec![json!(null)]),
            list(vec![row("s", 0, false), row("s", 0, false)]),
            list(vec![row("", 0, false)]),
            list(vec![row("bad\n", 0, false)]),
        ] {
            assert!(AttentionTracker::new()
                .poll(&rows, |_, _| panic!("no read"))
                .is_err());
        }
        for values in [
            json!(null),
            json!({"userQuestions":{"active":null}}),
            json!({"userQuestions":{"active":[{"callId":"q","state":"answered"}]}}),
            json!({"userQuestions":{"active":[{"callId":"q"}]}}),
            json!({"userQuestions":{"active":[{"callId":"q","state":"open"},{"callId":"q","state":"continued"}]}}),
            json!({"inbox":{"next-turn":false}}),
            json!({"inbox":{"next-step":[{"source":{"kind":"user-question-reply"}}]}}),
        ] {
            let mut bad = row("s", 0, false);
            bad["projections"]["values"] = values;
            assert!(AttentionTracker::new()
                .poll(&list(vec![bad]), |_, _| panic!("no read"))
                .is_err());
        }
    }

    #[test]
    fn session_capacity_is_explicit_and_transactional() {
        let mut tracker = AttentionTracker::new();
        let rows = list(
            (0..=LIMIT)
                .map(|n| row(&format!("s{n}"), -1, false))
                .collect(),
        );
        assert!(tracker.poll(&rows, |_, _| panic!("no read")).is_err());
        assert!(tracker.cursors.is_empty());
        assert!(tracker.seen.is_empty());
    }

    #[test]
    fn candidate_and_dispatch_capacity_are_explicit() {
        for nested_calls in [false, true] {
            let records = (0..=LIMIT)
                .map(|n| {
                    if nested_calls {
                        nested(
                            n as i64,
                            &format!("q{n}"),
                            "root",
                            "root",
                            "ask_user_question",
                        )
                    } else {
                        call(n as i64, &format!("q{n}"), "ask_user_question")
                    }
                })
                .collect();
            assert!(fold_page(&page(records), LIMIT as i64).is_err());
        }
        let mut row = row("s", 0, false);
        row["projections"]["values"] = json!({"userQuestions":{"active":(0..=LIMIT).map(|n|
            json!({"callId":format!("q{n}"),"state":"open"})).collect::<Vec<_>>()}});
        assert!(AttentionTracker::new()
            .poll(&list(vec![row]), |_, _| panic!("no read"))
            .is_err());
    }

    #[test]
    fn seen_capacity_is_bounded_across_disconnects_without_silent_eviction() {
        let mut tracker = AttentionTracker::new();
        tracker.seen = (0..LIMIT)
            .map(|n| ("s".into(), format!("old{n}")))
            .collect();
        tracker.disconnected();
        let before = fingerprint(&tracker);
        let rows = list(vec![timed("new", "open", false)]);
        assert!(tracker.poll(&rows, |_, _| panic!("no read")).is_err());
        assert_eq!(fingerprint(&tracker), before);
        tracker.reset();
        assert_eq!(poll(&mut tracker, &rows, &page(vec![])).len(), 1);
    }

    #[test]
    fn sequence_regression_rebaselines_only_that_session() {
        let mut tracker = AttentionTracker::new();
        let original = list(vec![row("a", 5, true), row("b", 5, true)]);
        let old = page(vec![call(5, "q", "ask_user_question")]);
        assert!(poll(&mut tracker, &original, &old).is_empty());
        let regressed = list(vec![row("a", 0, true), row("b", 5, true)]);
        let first = tracker
            .poll(&regressed, |id, cut| {
                assert_eq!((id, cut), ("a", 0));
                Ok(page(vec![call(0, "q", "ask_user_question")]))
            })
            .unwrap();
        assert_eq!(first, vec![notice("b", "q")]);
        assert_eq!(
            tracker
                .poll(&regressed, |_, _| panic!("cached cuts"))
                .unwrap(),
            vec![notice("a", "q")]
        );
        // Regression also retains seen: returning to an earlier call ID cannot
        // replay either notice, even after fresh consecutive observations.
        let reset = list(vec![row("a", -1, true), row("b", 5, true)]);
        assert!(poll(&mut tracker, &reset, &page(vec![])).is_empty());
        assert!(poll(
            &mut tracker,
            &regressed,
            &page(vec![call(0, "q", "ask_user_question")])
        )
        .is_empty());
        assert!(tracker
            .poll(&regressed, |_, _| panic!("cached cuts"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn same_call_id_in_different_sessions_is_not_deduplicated() {
        let mut tracker = AttentionTracker::new();
        let a = timed("q", "open", false);
        let mut b = a.clone();
        b["sessionId"] = json!("b");
        assert_eq!(
            poll(&mut tracker, &list(vec![a, b]), &page(vec![])),
            vec![notice("b", "q"), notice("s", "q")]
        );
    }
}

impl Fold {
    fn remove_dispatch(&mut self, call: &str) {
        let mut removed = BTreeSet::from([call.to_owned()]);
        loop {
            let before = removed.len();
            for (sub, dispatch) in &self.nested {
                if removed.contains(&dispatch.parent) {
                    removed.insert(sub.clone());
                }
            }
            if before == removed.len() {
                break;
            }
        }
        self.nested.retain(|sub, _| !removed.contains(sub));
    }
}
