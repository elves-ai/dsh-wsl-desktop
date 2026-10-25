use super::*;
use crate::environment::{ProbeError, ProbeOutput};
use serde_json::{json, Value};

fn config() -> Config {
    Config::parse(br#"{"Distribution":"Ubuntu","LinuxUser":"alice","LinuxLauncher":"/home/alice/launcher","LinuxConfig":"/home/alice/config"}"#).unwrap()
}
fn binding() -> Binding {
    Binding {
        backend: backend_identity(&config()),
        workspace_id: "ws-1".into(),
        session_id: Some("session-1".into()),
        workspace_path: "/home/alice/project".into(),
        session_pending: false,
    }
}
fn snapshot() -> Value {
    json!({"available":true,"enabled":false,"pet_id":"pet-1","name":"鲸鱼娘","persona":"友善",
        "entries":[],"message":null,"runtime_ready":false,"mode":"explicit","total":0,"next_offset":null})
}
struct Fake {
    calls: Vec<(Vec<String>, Value, Duration)>,
    output: Result<ProbeOutput, ProbeError>,
}
impl Fake {
    fn new(value: Value) -> Self {
        Self {
            calls: vec![],
            output: Ok(ProbeOutput {
                success: true,
                stdout: serde_json::to_vec(&value).unwrap(),
            }),
        }
    }
}
impl Runner for Fake {
    fn run(&mut self, _: &[String], _: Duration) -> Result<ProbeOutput, ProbeError> {
        panic!("must send JSON stdin")
    }
    fn run_input(
        &mut self,
        args: &[String],
        input: Vec<u8>,
        timeout: Duration,
    ) -> Result<ProbeOutput, ProbeError> {
        self.calls.push((
            args.to_vec(),
            serde_json::from_slice(&input).unwrap(),
            timeout,
        ));
        std::mem::replace(&mut self.output, Err(ProbeError::Unavailable))
    }
}

#[test]
fn scope_is_stable_hex_and_isolates_every_identity_component() {
    let initial = binding();
    let expected = scope(&initial, &initial.backend).unwrap();
    assert_eq!(
        expected,
        "956a03107b2af37e54e8292b12398e3897e992d00517ddc36b03d2c668e2a925"
    );
    assert_eq!(expected.len(), 64);
    assert!(expected
        .bytes()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    for field in 0..4 {
        let mut changed = initial.clone();
        match field {
            0 => changed.backend.distribution.push('2'),
            1 => changed.backend.user.push('2'),
            2 => changed.backend.origin.push('2'),
            _ => changed.workspace_id.push('2'),
        }
        assert_ne!(expected, scope(&changed, &changed.backend).unwrap());
    }
    let mut changed = initial.clone();
    changed.session_id = Some("different-session".into());
    changed.workspace_path = "/different/path".into();
    changed.session_pending = true;
    assert_eq!(expected, scope(&changed, &changed.backend).unwrap());
    assert!(!expected.contains("alice"));
}

#[test]
fn scope_rejects_mismatch_blank_or_control_workspace() {
    let original = binding();
    let mut changed = original.clone();
    changed.backend.user = "bob".into();
    assert!(scope(&original, &changed.backend).is_err());
    for workspace in ["", " ", "id\n", "id\0"] {
        changed = original.clone();
        changed.workspace_id = workspace.into();
        assert!(scope(&changed, &changed.backend).is_err());
    }
}

#[test]
fn typed_actions_reject_unknown_keys_paths_scope_and_unsafe_kinds() {
    for value in [
        json!({"action":"get"}),
        json!({"action":"context","query":"x"}),
        json!({"action":"set_enabled","enabled":true,"scope":"other"}),
        json!({"action":"add","kind":"fact","content":"x","path":"/tmp/db"}),
        json!({"action":"add","kind":"episode","content":"x"}),
        json!({"action":"forget","id":"memory-1"}),
        json!({"action":"clear"}),
        json!({"action":"clear","confirm":"true"}),
    ] {
        assert!(serde_json::from_value::<MemoryAction>(value).is_err());
    }
}

#[test]
fn action_validation_counts_unicode_and_requires_clear_confirmation() {
    assert!(MemoryAction::UpdatePersona {
        name: "鲸".repeat(40),
        persona: "鲸".repeat(240)
    }
    .validate()
    .is_ok());
    assert!(MemoryAction::UpdatePersona {
        name: "鲸".repeat(41),
        persona: "".into()
    }
    .validate()
    .is_err());
    assert!(MemoryAction::UpdatePersona {
        name: "鲸".into(),
        persona: "鲸".repeat(241)
    }
    .validate()
    .is_err());
    assert!(MemoryAction::UpdatePersona {
        name: "鲸\n".into(),
        persona: "".into()
    }
    .validate()
    .is_err());
    for (value, valid) in [
        ("鲸".repeat(1000), true),
        ("鲸".repeat(1001), false),
        (" \n\t".into(), false),
        ("a\0b".into(), false),
    ] {
        assert_eq!(
            MemoryAction::Add {
                kind: MemoryKind::Fact,
                content: value
            }
            .validate()
            .is_ok(),
            valid
        );
    }
    assert!(MemoryAction::Clear { confirm: true }.validate().is_ok());
    assert!(MemoryAction::Clear { confirm: false }.validate().is_err());
    assert!(MemoryAction::Forget {
        id: "memory-1".into(),
        confirm: false
    }
    .validate()
    .is_err());
    assert!(MemoryAction::Forget {
        id: "memory-1".into(),
        confirm: true
    }
    .validate()
    .is_ok());
    for id in ["", "../id", "id\n", "a/b"] {
        assert!(MemoryAction::Forget {
            id: id.into(),
            confirm: true
        }
        .validate()
        .is_err());
    }
}

#[test]
fn list_validation_is_bounded() {
    assert!(MemoryAction::List {
        offset: 1000,
        query: "鲸".repeat(200)
    }
    .validate()
    .is_ok());
    assert!(MemoryAction::List {
        offset: 1001,
        query: "".into()
    }
    .validate()
    .is_err());
    assert!(MemoryAction::List {
        offset: 0,
        query: "鲸".repeat(201)
    }
    .validate()
    .is_err());
    assert!(serde_json::from_value::<MemoryAction>(
        json!({"action":"list","offset":-1,"query":""})
    )
    .is_err());
}

#[test]
fn get_uses_fixed_interpreter_and_native_scope_only_over_stdin() {
    let mut fake = Fake::new(snapshot());
    let value = run_with(&mut fake, &config(), &binding(), None).unwrap();
    assert!(value.available);
    let (args, input, timeout) = &fake.calls[0];
    assert_eq!(
        &args[..8],
        &[
            "--distribution",
            "Ubuntu",
            "--user",
            "alice",
            "--exec",
            "/usr/bin/python3",
            "-I",
            "-c"
        ]
    );
    assert_eq!(args[8], HELPER);
    assert_eq!(
        input,
        &json!({"scope":scope(&binding(), &binding().backend).unwrap(),"request":{"action":"get"}})
    );
    assert_eq!(*timeout, Duration::from_secs(15));
    assert!(!args.iter().any(|arg| arg.contains("ws-1")));
}

#[test]
fn all_ui_actions_roundtrip_to_data_only_requests() {
    for action in [
        json!({"action":"set_enabled","enabled":true}),
        json!({"action":"update_persona","name":"鲸鱼娘","persona":"友善"}),
        json!({"action":"add","kind":"preference","content":"喜欢茶"}),
        json!({"action":"correct","id":"memory-1","content":"喜欢咖啡"}),
        json!({"action":"forget","id":"memory-1","confirm":true}),
        json!({"action":"clear","confirm":true}),
        json!({"action":"list","offset":10,"query":"茶"}),
    ] {
        let parsed: MemoryAction = serde_json::from_value(action.clone()).unwrap();
        let mut fake = Fake::new(snapshot());
        run_with(&mut fake, &config(), &binding(), Some(&parsed)).unwrap();
        assert_eq!(fake.calls[0].1["request"], action);
    }
}

#[test]
fn invalid_action_identity_and_config_never_invoke_runner() {
    let mut fake = Fake::new(snapshot());
    assert!(run_with(
        &mut fake,
        &config(),
        &binding(),
        Some(&MemoryAction::Clear { confirm: false })
    )
    .is_err());
    let mut wrong = binding();
    wrong.backend.user = "bob".into();
    assert!(run_with(&mut fake, &config(), &wrong, None).is_err());
    let mut bad = config();
    bad.distribution = "--help".into();
    let mut bound = binding();
    bound.backend = backend_identity(&bad);
    assert!(run_with(&mut fake, &bad, &bound, None).is_err());
    assert!(fake.calls.is_empty());
}

#[test]
fn transport_and_parse_errors_never_echo_helper_output() {
    for success in [true, false] {
        let mut fake = Fake {
            calls: vec![],
            output: Ok(ProbeOutput {
                success,
                stdout: b"credential-secret-token".to_vec(),
            }),
        };
        let error = run_with(&mut fake, &config(), &binding(), None).unwrap_err();
        assert!(!error.contains("credential"));
    }
    let mut fake = Fake {
        calls: vec![],
        output: Err(ProbeError::Timeout),
    };
    assert!(run_with(&mut fake, &config(), &binding(), None).is_err());
}

#[test]
fn snapshot_is_backward_compatible_but_never_claims_runtime_ready() {
    let mut value = snapshot();
    value["enabled"] = json!(true);
    value["runtime_ready"] = json!(true);
    value["next_offset"] = json!(10);
    value["total"] = json!(25);
    let mut fake = Fake::new(value);
    let result = run_with(&mut fake, &config(), &binding(), None).unwrap();
    assert!(result.enabled);
    assert!(!result.runtime_ready);
    assert_eq!(result.next_offset, Some(10));
    assert_eq!(result.total, 25);
    assert!(result.message.unwrap().contains("需安装"));
    let mut old = snapshot();
    for key in ["runtime_ready", "mode", "total", "next_offset"] {
        old.as_object_mut().unwrap().remove(key);
    }
    assert!(serde_json::from_value::<MemorySnapshot>(old).is_ok());
}

#[test]
fn stored_episode_entries_remain_readable_but_cannot_be_added_from_ui() {
    let mut value = snapshot();
    value["entries"] = json!([{ "id":"memory-old", "kind":"episode", "content":"old record", "source_session_id":null,"updated_at":"2026-10-25T00:00:00Z" }]);
    let mut fake = Fake::new(value);
    let result = run_with(&mut fake, &config(), &binding(), None).unwrap();
    assert_eq!(result.entries[0].kind, MemoryEntryKind::Episode);
    assert_eq!(result.entries[0].source_session_id, None);
    assert!(serde_json::from_value::<MemoryAction>(
        json!({"action":"add","kind":"episode","content":"new"})
    )
    .is_err());
}

#[test]
fn unavailable_snapshot_exposes_no_identity_or_memory() {
    let value = MemorySnapshot::unavailable("尚未绑定");
    assert!(!value.available && !value.enabled && !value.runtime_ready);
    assert!(value.pet_id.is_empty() && value.entries.is_empty());
    assert_eq!(value.next_offset, None);
}

#[test]
fn shared_operation_gate_is_process_wide_and_serializes_admission() {
    let guard = operation_mutex().lock().unwrap();
    assert!(operation_mutex().try_lock().is_err());
    let (send, receive) = std::sync::mpsc::channel();
    let join = std::thread::spawn(move || {
        let _lease = operation_mutex().lock().unwrap();
        send.send(()).unwrap();
    });
    assert!(receive.try_recv().is_err());
    drop(guard);
    receive.recv_timeout(Duration::from_secs(2)).unwrap();
    join.join().unwrap();
}
