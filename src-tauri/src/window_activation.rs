//! Explicit user activation is separate from automatic service startup/navigation.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Activation {
    Workspace,
    Launcher { open_workspace: bool },
}

pub(crate) fn explicit_activation(
    state: Option<&str>,
    busy: bool,
    workspace_exists: bool,
) -> Activation {
    if workspace_exists && (state == Some("ready") || busy) {
        Activation::Workspace
    } else {
        Activation::Launcher {
            open_workspace: state.is_some() && !busy,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_workspace_is_restored_without_probe_or_reload() {
        for busy in [false, true] {
            assert_eq!(
                explicit_activation(Some("ready"), busy, true),
                Activation::Workspace
            );
        }
    }

    #[test]
    fn busy_existing_workspace_is_restored_without_service_work() {
        for state in ["starting", "stopped", "error", "unknown"] {
            assert_eq!(
                explicit_activation(Some(state), true, true),
                Activation::Workspace,
                "explicit activation while busy: {state}"
            );
        }
    }

    #[test]
    fn startup_without_workspace_always_reveals_launcher() {
        for state in ["setup", "starting", "ready", "error", "unknown"] {
            assert_eq!(
                explicit_activation(Some(state), true, false),
                Activation::Launcher {
                    open_workspace: false
                }
            );
        }
        assert_eq!(
            explicit_activation(None, false, false),
            Activation::Launcher {
                open_workspace: false
            }
        );
    }

    #[test]
    fn idle_launcher_keeps_explicit_open_and_first_run_semantics() {
        for state in ["setup", "starting", "stopped", "error", "ready"] {
            assert_eq!(
                explicit_activation(Some(state), false, false),
                Activation::Launcher {
                    open_workspace: true
                }
            );
        }
        assert_eq!(
            explicit_activation(Some("stopped"), false, true),
            Activation::Launcher {
                open_workspace: true
            }
        );
    }
}
