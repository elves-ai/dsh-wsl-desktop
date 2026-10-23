//! Pure catalog/recovery/send policy; no I/O, creation, registration or transport.
//! Wire fields verified in Harness api/workspace-controller/types.ts and
//! api/session-controller/types.ts. Caller owns backend identity verification.
use crate::assistant::{Binding, SessionRow, Snapshot};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("DSH 响应字段 {key} 必须是数组。"))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("DSH 响应字段 {key} 必须是非空字符串。"))
}
fn boolean(value: &Value, key: &str) -> Result<bool, String> {
    value
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("DSH 响应字段 {key} 必须是布尔值。"))
}
fn strings<'a>(value: &'a Value, key: &str) -> Result<Vec<&'a str>, String> {
    array(value, key)?
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("DSH 响应字段 {key} 包含无效标识。"))
        })
        .collect()
}

/// Returns selectable rows in Workspace manual order and the bound Session's live-running hint.
/// A missing bound Session does NOT discard other rows: explicit recovery remains possible.
/// The returned hint is metadata, not a newer-than-follow sequenced status update.
pub fn catalog(
    workspaces: &Value,
    list: &Value,
    binding: &Binding,
) -> Result<(Vec<SessionRow>, bool), String> {
    if binding.workspace_id.is_empty() || binding.workspace_path.is_empty() {
        return Err("助手项目绑定无效。".into());
    }
    let archived: BTreeSet<_> = strings(workspaces, "archivedSessionIds")?
        .into_iter()
        .collect();
    let mut matching = None;
    for item in array(workspaces, "items")? {
        let id = string(item, "workspaceId")?;
        let path = string(item, "path")?;
        if id == binding.workspace_id {
            if matching.is_some() {
                return Err("DSH 项目标识重复。".into());
            }
            if path != binding.workspace_path {
                return Err("助手项目目录已变化，请在 DSH 中检查后重新选择。".into());
            }
            matching = Some(item);
        }
    }
    let workspace = matching.ok_or("助手项目已删除或不存在，请明确重新选择；不会自动创建项目。")?;
    let ids = strings(workspace, "sessionIds")?;
    let mut summaries = BTreeMap::new();
    for item in array(list, "items")? {
        let id = string(item, "sessionId")?;
        // Do not turn malformed status into an idle/sendable Session.
        boolean(item, "running")?;
        boolean(item, "agentAvailable")?;
        if let Some(parent) = item.get("parentSessionId") {
            if parent.as_str().filter(|s| !s.is_empty()).is_none() {
                return Err("DSH parentSessionId 格式无效。".into());
            }
        }
        if let Some(origin) = item.get("origin") {
            if origin.as_str().is_none() {
                return Err("DSH origin 格式无效。".into());
            }
        }
        if summaries.insert(id, item).is_some() {
            return Err("DSH 会话标识重复。".into());
        }
    }
    let mut rows = Vec::new();
    let mut running = false;
    let mut seen = BTreeSet::new();
    for id in ids {
        if archived.contains(id) || !seen.insert(id) {
            continue;
        }
        let Some(item) = summaries.get(id) else {
            continue;
        };
        if item.get("origin").and_then(Value::as_str) == Some("subagent")
            || item.get("parentSessionId").is_some()
        {
            continue;
        }
        if binding.session_id.as_deref() == Some(id) {
            running = boolean(item, "running")? && boolean(item, "agentAvailable")?;
        }
        let title = match item.pointer("/projections/values/title") {
            None | Some(Value::Null) => None,
            Some(Value::String(title)) => Some(title.as_str()).filter(|s| !s.trim().is_empty()),
            Some(_) => return Err("DSH 会话标题格式无效。".into()),
        };
        rows.push(SessionRow {
            id: id.into(),
            title: title
                .map(|s| s.chars().take(160).collect())
                .unwrap_or_else(|| id.chars().take(12).collect()),
        });
    }
    Ok((rows, running))
}

/// Check immediately before prompt/cancel/follow; never substitutes an automatic create.
pub fn require_session(rows: &[SessionRow], binding: &Binding) -> Result<(), String> {
    if binding
        .session_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_some_and(|id| rows.iter().any(|row| row.id == id))
    {
        Ok(())
    } else {
        Err("当前助手会话已删除或归档，请选择其他会话或明确新建对话。".into())
    }
}

/// An uncertain create has already succeeded if its EXACT preallocated id is present.
/// Blankness is irrelevant: an existing nonblank Session must not be recreated or replaced.
pub fn pending_exists(binding: &Binding, rows: &[SessionRow]) -> bool {
    binding.session_pending && require_session(rows, binding).is_ok()
}

/// Native guard in addition to frontend disabling; pending includes uncertain prompt submission.
pub fn send_allowed(snapshot: &Snapshot, pending: bool) -> bool {
    snapshot.enabled
        && snapshot.connected
        && snapshot
            .session_id
            .as_deref()
            .is_some_and(|s| !s.is_empty())
        && !snapshot.running
        && !snapshot.waiting
        && !pending
        && !matches!(snapshot.phase.as_str(), "sending" | "cancelling")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::BackendIdentity;
    use serde_json::json;
    fn binding() -> Binding {
        Binding {
            backend: BackendIdentity {
                distribution: "Ubuntu".into(),
                user: "alice".into(),
                origin: "http://127.0.0.1:3080".into(),
            },
            workspace_id: "w1".into(),
            workspace_path: "/assistant".into(),
            session_id: Some("s1".into()),
            session_pending: false,
        }
    }
    fn workspaces() -> Value {
        json!({"items":[{"workspaceId":"w1","path":"/assistant","sessionIds":["s1","s2","archived","child","parented","missing"]}],"archivedSessionIds":["archived"]})
    }
    fn summary(id: &str) -> Value {
        json!({"sessionId":id,"running":false,"agentAvailable":true,"blank":false,"updatedAt":1})
    }
    fn list() -> Value {
        let mut child = summary("child");
        child["origin"] = json!("subagent");
        let mut parented = summary("parented");
        parented["parentSessionId"] = json!("s1");
        json!({"items":[summary("s1"),summary("s2"),summary("archived"),child,parented,summary("outside")]})
    }
    #[test]
    fn filters_archive_children_missing_and_outside_preserving_order() {
        let (rows, running) = catalog(&workspaces(), &list(), &binding()).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["s1", "s2"]
        );
        assert!(!running);
    }
    #[test]
    fn unknown_workspace_and_changed_path_fail_without_creation() {
        let mut b = binding();
        b.workspace_id = "unknown".into();
        assert!(catalog(&workspaces(), &list(), &b).is_err());
        b = binding();
        b.workspace_path = "/different".into();
        assert!(catalog(&workspaces(), &list(), &b).is_err());
    }
    #[test]
    fn missing_or_archived_bound_session_keeps_other_recovery_rows() {
        for id in ["missing", "archived", "child", "parented", "outside"] {
            let mut b = binding();
            b.session_id = Some(id.into());
            let (rows, running) = catalog(&workspaces(), &list(), &b).unwrap();
            assert_eq!(rows.len(), 2);
            assert!(!running);
            assert!(require_session(&rows, &b).is_err());
        }
        let mut b = binding();
        b.session_id = None;
        let (rows, _) = catalog(&workspaces(), &list(), &b).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(require_session(&rows, &b).is_err());
    }
    #[test]
    fn title_uses_real_projection_and_unicode_safe_fallback() {
        let mut l = list();
        l["items"][0]["projections"] =
            json!({"kind":"sequenced","asOfSeq":4,"values":{"title":"助手对话"}});
        let (rows, _) = catalog(&workspaces(), &l, &binding()).unwrap();
        assert_eq!(rows[0].title, "助手对话");
        assert_eq!(rows[1].title, "s2");
        l["items"][0]["projections"]["values"]["title"] = json!(null);
        assert_eq!(
            catalog(&workspaces(), &l, &binding()).unwrap().0[0].title,
            "s1"
        );
    }
    #[test]
    fn running_hint_requires_exact_current_and_live_agent() {
        let mut l = list();
        l["items"][1]["running"] = json!(true);
        assert!(!catalog(&workspaces(), &l, &binding()).unwrap().1);
        l["items"][0]["running"] = json!(true);
        assert!(catalog(&workspaces(), &l, &binding()).unwrap().1);
        l["items"][0]["agentAvailable"] = json!(false);
        assert!(!catalog(&workspaces(), &l, &binding()).unwrap().1);
    }
    #[test]
    fn malformed_essential_fields_fail_closed() {
        for (pointer, bad) in [
            ("/items", json!({})),
            ("/archivedSessionIds", json!(null)),
            ("/archivedSessionIds/0", json!(4)),
            ("/items/0/workspaceId", json!(null)),
            ("/items/0/path", json!(false)),
            ("/items/0/sessionIds", json!({})),
            ("/items/0/sessionIds/0", json!(null)),
        ] {
            let mut w = workspaces();
            *w.pointer_mut(pointer).unwrap() = bad;
            assert!(catalog(&w, &list(), &binding()).is_err(), "{pointer}");
        }
        for (pointer, bad) in [
            ("/items", json!(null)),
            ("/items/0/sessionId", json!(7)),
            ("/items/0/running", json!("false")),
            ("/items/0/agentAvailable", json!(null)),
        ] {
            let mut l = list();
            *l.pointer_mut(pointer).unwrap() = bad;
            assert!(catalog(&workspaces(), &l, &binding()).is_err(), "{pointer}");
        }
        let mut l = list();
        l["items"][0]["projections"] = json!({"values":{"title":{}}});
        assert!(catalog(&workspaces(), &l, &binding()).is_err());
    }
    #[test]
    fn duplicate_identity_is_ambiguous_not_sendable() {
        let mut w = workspaces();
        let copy = w["items"][0].clone();
        w["items"].as_array_mut().unwrap().push(copy);
        assert!(catalog(&w, &list(), &binding()).is_err());
        let mut l = list();
        l["items"].as_array_mut().unwrap().push(summary("s1"));
        assert!(catalog(&workspaces(), &l, &binding()).is_err());
    }
    #[test]
    fn pending_recovery_adopts_existing_nonblank_exact_session() {
        let mut b = binding();
        b.session_pending = true;
        let (rows, _) = catalog(&workspaces(), &list(), &b).unwrap();
        assert!(pending_exists(&b, &rows)); // s1 blank:false
        b.session_pending = false;
        assert!(!pending_exists(&b, &rows));
        b.session_pending = true;
        b.session_id = Some("s".into());
        assert!(!pending_exists(&b, &rows));
        b.session_id = Some("archived".into());
        assert!(!pending_exists(&b, &rows));
        b.session_id = None;
        assert!(!pending_exists(&b, &rows));
    }
    fn ready() -> Snapshot {
        Snapshot {
            enabled: true,
            connected: true,
            session_id: Some("s1".into()),
            phase: "ready".into(),
            ..Default::default()
        }
    }
    #[test]
    fn send_requires_enabled_connected_bound_idle_and_no_pending() {
        assert!(send_allowed(&ready(), false));
        assert!(!send_allowed(&ready(), true));
        for field in [
            "enabled",
            "connected",
            "session_id",
            "empty_id",
            "running",
            "waiting",
            "sending",
            "cancelling",
        ] {
            let mut s = ready();
            match field {
                "enabled" => s.enabled = false,
                "connected" => s.connected = false,
                "session_id" => s.session_id = None,
                "empty_id" => s.session_id = Some(String::new()),
                "running" => s.running = true,
                "waiting" => s.waiting = true,
                phase => s.phase = phase.into(),
            }
            assert!(!send_allowed(&s, false), "{field}");
        }
    }
}
