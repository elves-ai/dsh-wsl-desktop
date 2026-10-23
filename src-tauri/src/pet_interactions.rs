//! In-memory interaction projection and fail-closed answer validation.
//! Raw questions, plans and tool arguments must never be persisted or logged.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_QUESTIONS: usize = 32;
const MAX_OPTIONS: usize = 64;

fn default_answerable() -> bool {
    true
}

// Optional wire fields may be absent, but the declared non-null type still applies when present.
fn present_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub connected: bool,
    pub items: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub kind: String,
    pub agent_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<Question>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    pub can_allow: bool,
    #[serde(default = "default_answerable")]
    pub answerable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub question: String,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub detail: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub header: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub options: Option<Vec<OptionItem>>,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub multi_select: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub intent: Option<Intent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionItem {
    pub label: String,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Intent {
    #[serde(rename = "plan-review")]
    PlanReview {
        approve: String,
        #[serde(default, rename = "callId", skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub id: String,
    pub selected: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub custom: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Reply {
    Questions { answers: Vec<Answer> },
    Approval { decision: String },
}

fn bounded(value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "交互数据无法编码".to_string())?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("交互数据过大，请在 DSH 中处理（未截断内容）".into());
    }
    Ok(())
}

fn questions_valid(questions: &[Question]) -> Result<(), String> {
    if questions.is_empty() || questions.len() > MAX_QUESTIONS {
        return Err("问题数量不支持，请在 DSH 中处理".into());
    }
    let mut ids = HashSet::new();
    for q in questions {
        if q.id.is_empty() || !ids.insert(q.id.as_str()) {
            return Err("问题标识为空或重复".into());
        }
        let options = q.options.as_deref().unwrap_or_default();
        if options.len() > MAX_OPTIONS {
            return Err("选项过多，请在 DSH 中处理（未截断内容）".into());
        }
        let mut labels = HashSet::new();
        if options.iter().any(|o| !labels.insert(o.label.as_str())) {
            return Err("问题选项标签重复".into());
        }
        if let Some(Intent::PlanReview { approve, .. }) = &q.intent {
            if q.multi_select == Some(true)
                || q.detail
                    .as_ref()
                    .is_none_or(|detail| detail.trim().is_empty())
                || !options.iter().any(|o| o.label == *approve)
            {
                return Err("计划确认缺少完整计划或明确的同意选项".into());
            }
        }
    }
    Ok(())
}

/// Project one known Host event without shortening any user-visible content.
/// Tool details must come from the exact Session/call lookup, not a UI draft.
pub fn project(
    id: &str,
    event: &str,
    agent_id: &str,
    request: &Value,
    tool_details: Option<&str>,
) -> Result<Card, String> {
    bounded(request)?;
    if id.is_empty() || agent_id.is_empty() || !request.is_object() {
        return Err("交互标识或请求无效".into());
    }
    let known: &[&str] = match event {
        "user-questions/request" => &["questions", "wait", "agent", "signal"],
        "approval/request" => &[
            "toolName",
            "callId",
            "reason",
            "displayReason",
            "agent",
            "signal",
        ],
        _ => return Err("不支持的交互类型，请在 DSH 中处理".into()),
    };
    if request
        .as_object()
        .is_some_and(|object| object.keys().any(|key| !known.contains(&key.as_str())))
    {
        return Err("交互包含尚不支持的信息，请在 DSH 中处理".into());
    }
    let mut card = Card {
        id: id.into(),
        kind: String::new(),
        agent_label: format!("会话 {agent_id}"),
        questions: None,
        tool_name: None,
        reason: None,
        details: None,
        can_allow: false,
        answerable: true,
        warning: None,
    };
    match event {
        "user-questions/request" => {
            let raw = request.get("questions").ok_or("请求缺少问题")?;
            let questions: Vec<Question> = serde_json::from_value(raw.clone())
                .map_err(|_| "问题格式不支持，请在 DSH 中处理".to_string())?;
            questions_valid(&questions)?;
            card.kind = "questions".into();
            card.questions = Some(questions);
        }
        "approval/request" => {
            let tool_name = request
                .get("toolName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or("审批缺少工具名称")?;
            let reason = match request.get("reason") {
                None => None,
                Some(Value::String(reason)) => Some(reason.clone()),
                Some(_) => return Err("审批原因格式不支持".into()),
            };
            let mut details = Vec::new();
            if let Some(display) = request.get("displayReason") {
                let display = display.as_object().ok_or("审批说明格式不支持")?;
                if display.get("en").and_then(Value::as_str).is_none()
                    || display.values().any(|text| !text.is_string())
                {
                    return Err("审批说明格式不支持".into());
                }
                // Retain every locale and the audit reason, not just a translated summary.
                details.push(format!(
                    "本地化说明：\n{}",
                    serde_json::to_string_pretty(display).map_err(|_| "审批说明无法编码")?
                ));
            }
            if let Some(raw) = tool_details {
                bounded(&raw)?;
                let full: Value = serde_json::from_str(raw)
                    .map_err(|_| "完整操作参数无法解析，请在 DSH 中处理".to_string())?;
                let call_id = request.get("callId").and_then(Value::as_str);
                if full.get("tool_name").and_then(Value::as_str) != Some(tool_name)
                    || call_id.is_none()
                    || full.get("call_id").and_then(Value::as_str) != call_id
                    || !full.get("arguments").is_some_and(Value::is_object)
                {
                    return Err("操作详情与审批不匹配，请在 DSH 中处理".into());
                }
                card.can_allow = full
                    .get("arguments")
                    .and_then(Value::as_object)
                    .is_some_and(|arguments| !arguments.is_empty());
                if !card.can_allow {
                    card.warning =
                        Some("操作参数为空，无法核对风险；可拒绝，或打开 DSH 处理".into());
                }
                details.push(format!("完整操作参数（仅允许本次）：\n{raw}"));
            } else {
                card.warning =
                    Some("缺少已核对的完整操作参数；可拒绝，或打开 DSH 处理，不能在此允许".into());
            }
            card.kind = "approval".into();
            card.tool_name = Some(tool_name.into());
            card.reason = reason;
            if !details.is_empty() {
                card.details = Some(details.join("\n\n"));
            }
        }
        _ => return Err("不支持的交互类型，请在 DSH 中处理".into()),
    }
    bounded(&card)?;
    Ok(card)
}

/// Validate against the retained original card, returning only the Host value.
/// The broker still owns connection generation, cancellation and one-shot settlement.
pub fn validate_reply(card: &Card, reply: &Reply) -> Result<Value, String> {
    bounded(reply)?;
    if !card.answerable {
        return Err("请求尚未就绪或已结束，不能提交".into());
    }
    match (card.kind.as_str(), reply) {
        ("approval", Reply::Approval { decision }) => match decision.as_str() {
            "allowed-once" if card.can_allow => Ok(json!("allowed-once")),
            "allowed-once" => Err("缺少完整操作参数，不能允许；请在 DSH 中处理".into()),
            "rejected" => Ok(json!("rejected")),
            _ => Err("不支持的授权决定；只能允许一次或拒绝".into()),
        },
        ("questions", Reply::Questions { answers }) => {
            let questions = card.questions.as_deref().ok_or("问题数据不可用")?;
            questions_valid(questions)?;
            if answers.len() != questions.len() {
                return Err("必须逐题提交完整答案".into());
            }
            let mut ids = HashSet::new();
            if answers.iter().any(|answer| !ids.insert(answer.id.as_str())) {
                return Err("答案标识重复".into());
            }
            let mut output = Vec::with_capacity(questions.len());
            for question in questions {
                let answer = answers
                    .iter()
                    .find(|answer| answer.id == question.id)
                    .ok_or("答案包含未知问题或缺少问题")?;
                let options = question.options.as_deref().unwrap_or_default();
                let mut selected = HashSet::new();
                for label in &answer.selected {
                    if !selected.insert(label.as_str())
                        || !options.iter().any(|o| o.label == *label)
                    {
                        return Err("答案包含未知或重复选项".into());
                    }
                }
                if question.multi_select != Some(true) && answer.selected.len() > 1 {
                    return Err("单选题不能选择多个选项".into());
                }
                if let Some(Intent::PlanReview { approve, .. }) = &question.intent {
                    if answer.selected.iter().any(|label| label == approve)
                        && answer.custom.is_some()
                    {
                        return Err("带修改意见的计划不能作为批准提交".into());
                    }
                }
                let custom = answer
                    .custom
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty());
                if question.intent.is_none()
                    && question.multi_select != Some(true)
                    && answer.custom.is_some()
                    && !answer.selected.is_empty()
                {
                    return Err("单选题的自定义答案不能同时选择选项".into());
                }
                let labels = answer.selected.clone();
                output.push(Answer {
                    id: question.id.clone(),
                    selected: labels,
                    custom: custom.map(str::to_owned),
                });
            }
            let result = json!({"answers": output});
            bounded(&result)?;
            Ok(result)
        }
        _ => Err("答案类型与请求不匹配".into()),
    }
}

fn event_arguments(event: &Value) -> Option<Value> {
    let data = event.get("data")?;
    match event.get("type")?.as_str()? {
        "tool/call" => {
            let raw = data.get("arguments")?.as_str()?;
            let args: Value = serde_json::from_str(raw).ok()?;
            args.is_object().then_some(args)
        }
        "tool/ptc-dispatch-start" => data
            .get("arguments")
            .filter(|args| args.is_object())
            .cloned(),
        _ => None,
    }
}

fn event_call_id(event: &Value) -> Option<&str> {
    match event.get("type")?.as_str()? {
        "tool/call" => event.get("data")?.get("callId")?.as_str(),
        "tool/ptc-dispatch-start" => event.get("data")?.get("subCallId")?.as_str(),
        _ => None,
    }
}

/// Resolve complete invocation arguments from the current Session.page records.
/// A nested dispatch requires the entire parent chain and original root program.
/// Missing history, ambiguous identities or malformed JSON fail closed.
pub fn tool_details(page: &Value, call_id: &str, tool_name: &str) -> Option<String> {
    if call_id.is_empty() || tool_name.is_empty() {
        return None;
    }
    let records = page.get("records")?.as_array()?;
    let events: Vec<&Value> = records
        .iter()
        .filter(|record| record.get("type").and_then(Value::as_str) == Some("event"))
        .filter_map(|record| record.get("event"))
        .collect();
    let lookup = |id: &str| -> Option<&Value> {
        let matches: Vec<_> = events
            .iter()
            .copied()
            .filter(|event| event_call_id(event) == Some(id))
            .collect();
        (matches.len() == 1).then(|| matches[0])
    };
    let event = lookup(call_id)?;
    let data = event.get("data")?;
    if data.get("name")?.as_str()? != tool_name {
        return None;
    }
    let arguments = event_arguments(event)?;
    if tool_name == "run_code"
        && arguments
            .get("code")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return None;
    }
    let mut full = json!({"call_id":call_id,"tool_name":tool_name,"arguments":arguments});
    if event.get("type")?.as_str()? == "tool/ptc-dispatch-start" {
        let root = data.get("rootCallId")?.as_str()?;
        let mut parent = data.get("parentCallId")?.as_str()?;
        let mut visited = HashSet::from([call_id]);
        let mut parents = Vec::new();
        loop {
            if !visited.insert(parent) || parents.len() >= 64 {
                return None;
            }
            let parent_event = lookup(parent)?;
            let parent_data = parent_event.get("data")?;
            let name = parent_data.get("name")?.as_str()?;
            let args = event_arguments(parent_event)?;
            if name != "run_code"
                || args
                    .get("code")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                return None;
            }
            parents.push(json!({"call_id":parent,"tool_name":name,"arguments":args}));
            if parent == root {
                if parent_event.get("type")?.as_str()? != "tool/call" {
                    return None;
                }
                break;
            }
            if parent_event.get("type")?.as_str()? != "tool/ptc-dispatch-start"
                || parent_data.get("rootCallId")?.as_str()? != root
            {
                return None;
            }
            parent = parent_data.get("parentCallId")?.as_str()?;
        }
        full["parents"] = json!(parents);
    }
    bounded(&full).ok()?;
    let text = serde_json::to_string_pretty(&full).ok()?;
    bounded(&text).ok()?;
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question_request() -> Value {
        json!({"questions":[{"id":"q","question":"<script>alert(1)</script>","detail":"全文 <b>保留</b>","options":[{"label":"A (Recommended)","description":"完整说明"},{"label":"B"}]}]})
    }
    fn card(request: Value) -> Card {
        project("event", "user-questions/request", "session", &request, None).unwrap()
    }
    fn reply(value: Value) -> Reply {
        serde_json::from_value(value).unwrap()
    }
    fn plan() -> Value {
        json!({"questions":[{"id":"plan-review","question":"Approve?","detail":"# 完整计划\n不可截断的正文","options":[{"label":"Approve"},{"label":"Keep planning"}],"intent":{"kind":"plan-review","approve":"Approve","callId":"p"}}]})
    }
    fn approval() -> Value {
        json!({"toolName":"bash","callId":"c","reason":"完整风险原因"})
    }
    fn record(event_type: &str, data: Value) -> Value {
        json!({"type":"event","event":{"type":event_type,"seq":1,"time":1,"data":data}})
    }

    #[test]
    fn projected_cards_omit_absent_fields_and_emit_frontend_fixture() {
        let q = card(question_request());
        let approval = project(
            "approval-event",
            "approval/request",
            "session",
            &approval(),
            None,
        )
        .unwrap();
        let question_json = serde_json::to_value(&q).unwrap();
        for field in ["tool_name", "reason", "details", "warning"] {
            assert!(
                question_json.get(field).is_none(),
                "absent question card field: {field}"
            );
        }
        assert_eq!(question_json["answerable"], true);
        let approval_json = serde_json::to_value(&approval).unwrap();
        assert!(approval_json.get("questions").is_none());
        assert!(approval_json.get("details").is_none());
        for projected in [&question_json, &approval_json] {
            assert!(projected
                .as_object()
                .unwrap()
                .values()
                .all(|value| !value.is_null()));
        }
        let fixture = serde_json::to_value(Snapshot {
            revision: 42,
            connected: true,
            items: vec![q, approval],
        })
        .unwrap();
        // Static synthetic data only; no live request or user parameters reach test output.
        println!("PET_INTERACTIONS_FIXTURE={fixture}");
    }

    #[test]
    fn serialized_snapshot_matches_frontend_parser() {
        use std::io::Write;
        use std::path::PathBuf;
        use std::process::{Command, Stdio};

        let page = json!({"records":[record("tool/call",json!({
            "callId":"c", "name":"bash",
            "arguments":"{\"command\":\"echo <script>unsafe HTML remains text</script>\",\"workdir\":\"/fixture\"}"
        }))]});
        let details = tool_details(&page, "c", "bash").unwrap();
        let snapshot = Snapshot {
            revision: 43,
            connected: true,
            items: vec![
                card(question_request()),
                project(
                    "plan-event",
                    "user-questions/request",
                    "session",
                    &plan(),
                    None,
                )
                .unwrap(),
                project(
                    "approval-event",
                    "approval/request",
                    "session",
                    &approval(),
                    Some(&details),
                )
                .unwrap(),
            ],
        };
        let manifest = option_env!("CARGO_MANIFEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap().join("src-tauri"));
        let mut child = Command::new("node")
            .arg("tests/pet-interaction-wire.mjs")
            .current_dir(
                manifest
                    .parent()
                    .expect("Cargo manifest has project parent"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start actual frontend interaction parser");
        let mut input = child.stdin.take().expect("piped fixture stdin");
        input
            .write_all(&serde_json::to_vec(&snapshot).unwrap())
            .expect("write static Rust fixture");
        drop(input);
        let output = child.wait_with_output().expect("wait for frontend parser");
        assert!(
            output.status.success(),
            "frontend interaction parser rejected Rust snapshot: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn preserves_untrusted_text_and_original_recommended_label_without_default_selection() {
        let c = card(question_request());
        assert_eq!(
            c.questions.as_ref().unwrap()[0].question,
            "<script>alert(1)</script>"
        );
        assert!(!c.can_allow);
        let out = validate_reply(
            &c,
            &reply(
                json!({"kind":"questions","answers":[{"id":"q","selected":["A (Recommended)"]}]}),
            ),
        )
        .unwrap();
        assert_eq!(out["answers"][0]["selected"][0], "A (Recommended)");
        assert!(validate_reply(
            &c,
            &reply(json!({"kind":"questions","answers":[{"id":"q","selected":["A"]}]}))
        )
        .is_err());
        let skip = validate_reply(
            &c,
            &reply(json!({"kind":"questions","answers":[{"id":"q","selected":[]}]})),
        )
        .unwrap();
        assert_eq!(skip, json!({"answers":[{"id":"q","selected":[]}]}));
    }

    #[test]
    fn multiple_questions_ids_membership_and_selection_counts_are_checked() {
        let c = card(
            json!({"questions":[{"id":"one","question":"One","options":[{"label":"X"}]},{"id":"many","question":"Many","multiSelect":true,"options":[{"label":"X"},{"label":"Y"}]},{"id":"text","question":"Text"}]}),
        );
        let out=validate_reply(&c,&reply(json!({"kind":"questions","answers":[{"id":"many","selected":["X","Y"],"custom":" Z "},{"id":"one","selected":[],"custom":" other "},{"id":"text","selected":[],"custom":" detail "}]}))).unwrap();
        assert_eq!(
            out["answers"][0],
            json!({"id":"one","selected":[],"custom":"other"})
        );
        assert_eq!(out["answers"][1]["selected"], json!(["X", "Y"]));
        assert_eq!(out["answers"][2]["custom"], "detail");
        for answers in [
            json!([]),
            json!([{"id":"one","selected":[]},{"id":"one","selected":[]},{"id":"text","selected":[]}]),
            json!([{"id":"one","selected":[]},{"id":"unknown","selected":[]},{"id":"text","selected":[]}]),
        ] {
            assert!(
                validate_reply(&c, &reply(json!({"kind":"questions","answers":answers}))).is_err()
            );
        }
        let c = card(question_request());
        for selected in [
            json!(["B", "B"]),
            json!(["B", "A (Recommended)"]),
            json!(["unknown"]),
        ] {
            assert!(validate_reply(
                &c,
                &reply(json!({"kind":"questions","answers":[{"id":"q","selected":selected}]}))
            )
            .is_err());
        }
    }

    #[test]
    fn plan_consent_never_includes_feedback_even_empty_feedback() {
        let c = card(plan());
        assert_eq!(validate_reply(&c,&reply(json!({"kind":"questions","answers":[{"id":"plan-review","selected":["Approve"]}]}))).unwrap(),json!({"answers":[{"id":"plan-review","selected":["Approve"]}]}));
        for custom in ["", " ", "change it"] {
            assert!(validate_reply(&c,&reply(json!({"kind":"questions","answers":[{"id":"plan-review","selected":["Approve"],"custom":custom}]}))).is_err());
        }
        assert_eq!(validate_reply(&c,&reply(json!({"kind":"questions","answers":[{"id":"plan-review","selected":["Keep planning"],"custom":"change tests"}]}))).unwrap()["answers"][0]["selected"],json!(["Keep planning"]));
        let mut p = plan();
        p["questions"][0]["intent"]["kind"] = json!("unknown");
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        let mut p = plan();
        p["questions"][0]["intent"]["approve"] = json!("not offered");
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        let mut p = plan();
        p["questions"][0]["multiSelect"] = json!(true);
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        let mut p = plan();
        p["questions"][0].as_object_mut().unwrap().remove("detail");
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
    }

    #[test]
    fn unknown_reply_fields_and_intents_are_not_silently_dropped() {
        for value in [
            json!({"kind":"approval","decision":"allowed-once","forever":true}),
            json!({"kind":"questions","answers":[],"extra":true}),
            json!({"kind":"questions","answers":[{"id":"q","selected":[],"extra":true}]}),
        ] {
            assert!(serde_json::from_value::<Reply>(value).is_err());
        }
    }

    #[test]
    fn approval_is_once_only_and_requires_exact_complete_details() {
        let mut request = approval();
        request["displayReason"] = json!({"en":"Full risk","zh":"完整说明"});
        let c = project("e", "approval/request", "s", &request, None).unwrap();
        assert_eq!(c.reason.as_deref(), Some("完整风险原因"));
        assert!(c.details.as_deref().unwrap().contains("完整说明"));
        assert!(!c.can_allow);
        assert!(c.warning.is_some());
        assert!(validate_reply(
            &c,
            &Reply::Approval {
                decision: "allowed-once".into()
            }
        )
        .is_err());
        assert_eq!(
            validate_reply(
                &c,
                &Reply::Approval {
                    decision: "rejected".into()
                }
            )
            .unwrap(),
            json!("rejected")
        );
        let raw=json!({"tool_name":"bash","call_id":"c","arguments":{"command":"rm -rf /very/important","workdir":"/","sandbox_permissions":"danger-full-access","justification":"完整理由"}}).to_string();
        let c = project("e", "approval/request", "s", &request, Some(&raw)).unwrap();
        assert!(c.can_allow);
        assert!(c.details.unwrap().contains(&raw));
        let c = project("e", "approval/request", "s", &request, Some(&raw)).unwrap();
        assert_eq!(
            validate_reply(
                &c,
                &Reply::Approval {
                    decision: "allowed-once".into()
                }
            )
            .unwrap(),
            json!("allowed-once")
        );
        for decision in ["allowed-session", "allowed-always", "cancelled", ""] {
            assert!(validate_reply(
                &c,
                &Reply::Approval {
                    decision: decision.into()
                }
            )
            .is_err());
        }
        assert!(project("e", "approval/request", "s", &request, Some("{}")).is_err());
        let bad = raw.replace("\"call_id\":\"c\"", "\"call_id\":\"other\"");
        assert!(project("e", "approval/request", "s", &request, Some(&bad)).is_err());
    }

    #[test]
    fn null_custom_and_single_choice_custom_are_not_ambiguous_consent() {
        let c = card(question_request());
        for custom in ["", "other"] {
            let r = reply(
                json!({"kind":"questions","answers":[{"id":"q","selected":["B"],"custom":custom}]}),
            );
            assert!(validate_reply(&c, &r).is_err());
        }
        let bad = json!({"kind":"questions","answers":[{"id":"plan-review","selected":["Approve"],"custom":null}]});
        assert!(serde_json::from_value::<Reply>(bad).is_err());
        let mut p = plan();
        p["questions"][0]["intent"] = Value::Null;
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
    }

    #[test]
    fn readiness_and_empty_parameters_cannot_grant() {
        let mut c = card(question_request());
        c.answerable = false;
        let answer = reply(json!({"kind":"questions","answers":[{"id":"q","selected":[]}]}));
        assert!(validate_reply(&c, &answer).is_err());
        let raw = json!({"call_id":"c","tool_name":"bash","arguments":{}}).to_string();
        let mut c = project("e", "approval/request", "s", &approval(), Some(&raw)).unwrap();
        assert!(!c.can_allow);
        assert!(c.warning.is_some());
        assert!(validate_reply(
            &c,
            &Reply::Approval {
                decision: "allowed-once".into()
            }
        )
        .is_err());
        c.answerable = false;
        assert!(validate_reply(
            &c,
            &Reply::Approval {
                decision: "rejected".into()
            }
        )
        .is_err());
        let mut request = approval();
        request["newRiskInformation"] = json!("not safe to silently omit");
        assert!(project("e", "approval/request", "s", &request, None).is_err());
    }

    #[test]
    fn bounds_fail_instead_of_truncating_or_partially_projecting() {
        let mut p = question_request();
        p["questions"][0]["detail"] = json!("危".repeat(MAX_JSON_BYTES));
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        let mut p = question_request();
        p["questions"] = json!(vec![p["questions"][0].clone(); 33]);
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        let mut p = question_request();
        p["questions"][0]["options"] = json!((0..65)
            .map(|i| json!({"label":i.to_string()}))
            .collect::<Vec<_>>());
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        let mut p = question_request();
        p["questions"][0]["options"] = json!([{"label":"same"},{"label":"same"}]);
        assert!(project("e", "user-questions/request", "s", &p, None).is_err());
        assert!(project("e", "unknown", "s", &json!({}), None).is_err());
    }

    #[test]
    fn resolves_only_exact_current_page_tool_calls_with_complete_json() {
        let page = json!({"records":[record("tool/call",json!({"callId":"c","name":"bash","arguments":"{\"command\":\"echo <script>\"}"}))],"hasMore":false});
        let full: Value = serde_json::from_str(&tool_details(&page, "c", "bash").unwrap()).unwrap();
        assert_eq!(full["arguments"]["command"], "echo <script>");
        assert!(tool_details(&page, "other", "bash").is_none());
        assert!(tool_details(&page, "c", "read").is_none());
        let malformed = json!({"records":[record("tool/call",json!({"callId":"c","name":"bash","arguments":"{\"command\":"}))]});
        assert!(tool_details(&malformed, "c", "bash").is_none());
        let ambiguous = json!({"records":[page["records"][0].clone(),page["records"][0].clone()]});
        assert!(tool_details(&ambiguous, "c", "bash").is_none());
    }

    #[test]
    fn nested_ptc_needs_root_program_and_unambiguous_full_parent_chain() {
        let start = record(
            "tool/ptc-dispatch-start",
            json!({"rootCallId":"root","parentCallId":"root","subCallId":"child","name":"bash","arguments":{"command":"echo hi"}}),
        );
        let missing = json!({"records":[start.clone()]});
        assert!(tool_details(&missing, "child", "bash").is_none());
        let root = record(
            "tool/call",
            json!({"callId":"root","name":"run_code","arguments":"{\"code\":\"await tools.bash({command: 'echo hi'})\",\"description\":\"whole original program\"}"}),
        );
        let page = json!({"records":[root,start.clone()]});
        let full: Value =
            serde_json::from_str(&tool_details(&page, "child", "bash").unwrap()).unwrap();
        assert_eq!(
            full["parents"][0]["arguments"]["code"],
            "await tools.bash({command: 'echo hi'})"
        );
        let mut cycle = page.clone();
        cycle["records"][1]["event"]["data"]["parentCallId"] = json!("child");
        assert!(tool_details(&cycle, "child", "bash").is_none());
        let settled =
            json!({"records":[record("tool/ptc-dispatch",start["event"]["data"].clone())]});
        assert!(tool_details(&settled, "child", "bash").is_none());
    }
}
