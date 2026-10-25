use super::*;
fn binding() -> Binding {
    Binding {
        backend: BackendIdentity {
            distribution: "Ubuntu-24.04".into(),
            user: "alice".into(),
            origin: "http://127.0.0.1:3080".into(),
        },
        workspace_id: "workspace-test".into(),
        session_id: Some("session-test".into()),
        workspace_path: "/home/alice/项目 space/.workspace".into(),
        session_pending: false,
    }
}
fn no_probe(_: &str) -> Result<bool, ()> {
    panic!("must not inspect filesystem")
}
fn no_open(_: &str) -> Result<(), ()> {
    panic!("must not open folder")
}
#[test]
fn changes_during_probe_require_refresh_before_dispatch() {
    let b = binding();
    assert!(unchanged(Some(&b), Some(&b.backend), Some(&b), Some(&b.backend)).is_ok());
    let mut latest = b.clone();
    latest.workspace_path = "/different".into();
    assert!(unchanged(Some(&b), Some(&b.backend), Some(&latest), Some(&b.backend)).is_err());
    latest = b.clone();
    latest.session_id = Some("other-session".into());
    assert!(unchanged(Some(&b), Some(&b.backend), Some(&latest), Some(&b.backend)).is_err());
    latest = b.clone();
    latest.backend.distribution = "Debian".into();
    assert!(unchanged(Some(&b), Some(&b.backend), Some(&b), Some(&latest.backend)).is_err());
    assert!(unchanged(Some(&b), Some(&b.backend), None, Some(&b.backend)).is_err());
    assert!(unchanged(Some(&b), Some(&b.backend), Some(&b), None).is_err());
}
#[test]
fn unbound_is_read_only_and_cannot_open() {
    assert_eq!(
        inspect(None, None, no_probe).status,
        WorkspaceStatus::Unbound
    );
    assert!(open_bound(None, None, no_probe, no_open).is_err());
}
#[test]
fn only_bound_distribution_and_workspace_form_the_unc_target() {
    let b = binding();
    let expected = to_unc(&b.backend.distribution, &b.workspace_path).unwrap();
    let state = open_bound(
        Some(&b),
        Some(&b.backend),
        |path| {
            assert_eq!(path, expected);
            Ok(true)
        },
        |path| {
            assert_eq!(path, expected);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(state.path.as_deref(), Some(b.workspace_path.as_str()));
    let json = serde_json::to_value(state).unwrap();
    assert_eq!(json["status"], "ready");
    assert_eq!(json.as_object().unwrap().len(), 4); // No session ids, messages or credentials.
}
#[test]
fn every_backend_identity_change_fails_before_filesystem_access() {
    let b = binding();
    for changed in [
        BackendIdentity {
            distribution: "Debian".into(),
            ..b.backend.clone()
        },
        BackendIdentity {
            user: "bob".into(),
            ..b.backend.clone()
        },
        BackendIdentity {
            origin: "http://127.0.0.1:3081".into(),
            ..b.backend.clone()
        },
    ] {
        let state = inspect(Some(&b), Some(&changed), no_probe);
        assert_eq!(state.status, WorkspaceStatus::BackendChanged);
        assert_eq!(state.distribution.as_deref(), Some("Ubuntu-24.04"));
        assert!(open_bound(Some(&b), Some(&changed), no_probe, no_open).is_err());
    }
    assert_eq!(
        inspect(Some(&b), None, no_probe).status,
        WorkspaceStatus::BackendChanged
    );
    assert!(open_bound(Some(&b), None, no_probe, no_open).is_err());
}
#[test]
fn malformed_paths_and_distributions_never_reach_probe_or_opener() {
    for path in [
        "",
        "~/work",
        "relative",
        "C:/work",
        "//host/share",
        "/home/../other",
        "/home/./work",
        "/home//work",
        "/home/a\\b",
        "/home/a:b",
        "/home/a\n",
        "/home/a.",
        "/home/*.json",
    ] {
        let mut b = binding();
        b.workspace_path = path.into();
        assert_eq!(
            inspect(Some(&b), Some(&b.backend), no_probe).status,
            WorkspaceStatus::Invalid,
            "{path}"
        );
        assert!(open_bound(Some(&b), Some(&b.backend), no_probe, no_open).is_err());
    }
    for distribution in [
        "",
        "..",
        "Ubuntu/other",
        "Ubuntu\\other",
        "Ubuntu:",
        "Ubuntu\n",
    ] {
        let mut b = binding();
        b.backend.distribution = distribution.into();
        assert!(open_bound(Some(&b), Some(&b.backend), no_probe, no_open).is_err());
    }
}
#[test]
fn missing_non_directory_and_permission_failures_do_not_create_or_open() {
    let b = binding();
    for (probe_result, expected) in [
        (Ok(false), WorkspaceStatus::Missing),
        (Err(()), WorkspaceStatus::Unavailable),
    ] {
        assert_eq!(
            inspect(Some(&b), Some(&b.backend), |_| probe_result).status,
            expected
        );
        assert!(open_bound(Some(&b), Some(&b.backend), |_| probe_result, no_open).is_err());
    }
}
#[test]
fn open_rechecks_current_state_and_propagates_dispatch_failure() {
    let b = binding();
    assert_eq!(
        inspect(Some(&b), Some(&b.backend), |_| Ok(true)).status,
        WorkspaceStatus::Ready
    );
    // A directory disappearing after display must not be opened or recreated.
    assert!(open_bound(Some(&b), Some(&b.backend), |_| Ok(false), no_open).is_err());
    let error = open_bound(Some(&b), Some(&b.backend), |_| Ok(true), |_| Err(())).unwrap_err();
    assert!(error.contains("打开目录失败"));
}
#[test]
fn refreshed_binding_replaces_path_without_creating_a_session() {
    let mut b = binding();
    b.session_id = None;
    assert_eq!(
        inspect(Some(&b), Some(&b.backend), |_| Ok(true))
            .path
            .as_deref(),
        Some(b.workspace_path.as_str())
    );
    b.workspace_path = "/home/alice/new".into();
    open_bound(
        Some(&b),
        Some(&b.backend),
        |target| {
            assert!(target.ends_with("alice\\new"));
            Ok(true)
        },
        |_| Ok(()),
    )
    .unwrap();
    assert!(b.session_id.is_none());
}
