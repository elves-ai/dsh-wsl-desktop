//! Independent epochs keep pet bubbles and system alerts from replaying historical events.
//! A visible pet replaces the system toast with sound, without disabling system alerts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemDelivery {
    Toast,
    SoundOnly,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChannelGate {
    pub system: bool,
    pub pet_visible: bool,
    pub system_epoch: u64,
    pub bubbles: bool,
    pub bubble_epoch: u64,
}
impl ChannelGate {
    pub fn route(
        system_enabled: bool,
        system_epoch: u64,
        pet_visible: bool,
        bubble_enabled: bool,
        bubble_epoch: u64,
    ) -> Self {
        Self {
            system: system_enabled,
            pet_visible,
            system_epoch,
            bubbles: pet_visible && bubble_enabled,
            bubble_epoch,
        }
    }
    pub fn active(self) -> bool {
        self.system || self.bubbles
    }
    pub fn allows_system(self, live: Self) -> bool {
        self.system && live.system && self.system_epoch == live.system_epoch
    }
    /// Choose one system effect from live visibility; sound-only never creates a toast.
    pub fn system_delivery(
        self,
        live: Self,
        foreground: bool,
        notify_when_focused: bool,
    ) -> Option<SystemDelivery> {
        if !self.allows_system(live) || foreground && !notify_when_focused {
            return None;
        }
        Some(if live.pet_visible {
            SystemDelivery::SoundOnly
        } else {
            SystemDelivery::Toast
        })
    }
    pub fn allows_bubble(self, live: Self) -> bool {
        self.bubbles && live.bubbles && self.bubble_epoch == live.bubble_epoch
    }
    pub fn current(self, live: Self) -> bool {
        self.allows_system(live) || self.allows_bubble(live)
    }
    pub fn continuous(self, previous: Option<Self>) -> bool {
        previous.is_some_and(|old| old.current(self))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn gate(toasts: bool, t: u64, bubbles: bool, b: u64) -> ChannelGate {
        ChannelGate {
            system: toasts,
            pet_visible: false,
            system_epoch: t,
            bubbles,
            bubble_epoch: b,
        }
    }
    #[test]
    fn bubbles_alone_monitor_without_toast_permission() {
        let g = gate(false, 0, true, 1);
        assert!(g.active());
        assert!(g.allows_bubble(g));
        assert!(!g.allows_system(g));
    }
    #[test]
    fn all_disabled_has_no_delivery() {
        let g = gate(false, 1, false, 1);
        assert!(!g.active());
        assert!(!g.current(g));
    }
    #[test]
    fn toggling_toasts_does_not_reset_ongoing_bubbles() {
        let old = gate(true, 1, true, 1);
        let live = gate(false, 2, true, 1);
        assert!(live.continuous(Some(old)));
        assert!(!old.allows_system(live));
        assert!(old.allows_bubble(live));
    }
    #[test]
    fn hiding_pet_does_not_reset_ongoing_toasts() {
        let old = gate(true, 1, true, 1);
        let live = gate(true, 1, false, 2);
        assert!(live.continuous(Some(old)));
        assert!(!old.allows_bubble(live));
        assert!(old.allows_system(live));
    }
    #[test]
    fn reenable_between_polls_starts_new_baseline() {
        let old = gate(false, 0, true, 1);
        let live = gate(false, 0, true, 3);
        assert!(!old.current(live));
        assert!(!live.continuous(Some(old)));
    }
    #[test]
    fn new_channel_cannot_receive_inflight_old_event() {
        let old = gate(true, 1, false, 0);
        let live = gate(true, 1, true, 1);
        assert!(live.continuous(Some(old)));
        assert!(!old.allows_bubble(live));
        assert!(old.allows_system(live));
    }
    #[test]
    fn swapping_only_channel_rebases_without_history() {
        assert!(!gate(false, 2, true, 1).continuous(Some(gate(true, 1, false, 0))));
    }
    #[test]
    fn visible_pet_never_produces_system_toast() {
        for bubbles in [false, true] {
            let g = ChannelGate::route(true, 1, true, bubbles, 1);
            assert_eq!(
                g.system_delivery(g, false, false),
                Some(SystemDelivery::SoundOnly)
            );
            assert!(g.active());
            assert_eq!(g.bubbles, bubbles);
        }
    }
    #[test]
    fn hidden_pet_uses_only_explicit_system_setting() {
        for toasts in [false, true] {
            let g = ChannelGate::route(toasts, 1, false, true, 1);
            assert_eq!(g.system, toasts);
            assert_eq!(
                g.system_delivery(g, false, false),
                toasts.then_some(SystemDelivery::Toast)
            );
            assert!(!g.bubbles);
        }
    }
    #[test]
    fn system_effect_matrix_keeps_sound_and_cards_exclusive_and_obeys_focus() {
        for enabled in [false, true] {
            for visible in [false, true] {
                for bubbles in [false, true] {
                    for foreground in [false, true] {
                        for focused_opt_in in [false, true] {
                            let g = ChannelGate::route(enabled, 4, visible, bubbles, 8);
                            let expected = if enabled && (!foreground || focused_opt_in) {
                                Some(if visible {
                                    SystemDelivery::SoundOnly
                                } else {
                                    SystemDelivery::Toast
                                })
                            } else {
                                None
                            };
                            assert_eq!(g.system_delivery(g, foreground, focused_opt_in), expected);
                            assert_eq!(g.bubbles, visible && bubbles);
                            assert_eq!(g.active(), enabled || visible && bubbles);
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn visibility_switch_preserves_system_history_and_uses_the_live_surface() {
        let hidden = ChannelGate::route(true, 1, false, false, 2);
        let visible = ChannelGate::route(true, 1, true, false, 2);
        assert!(visible.continuous(Some(hidden)));
        assert!(hidden.continuous(Some(visible)));
        assert_eq!(
            hidden.system_delivery(visible, false, false),
            Some(SystemDelivery::SoundOnly)
        );
        assert_eq!(
            visible.system_delivery(hidden, false, false),
            Some(SystemDelivery::Toast)
        );
    }
    #[test]
    fn sound_only_never_replays_an_event_from_a_disabled_or_old_system_epoch() {
        let captured = ChannelGate::route(true, 4, true, true, 2);
        let disabled = ChannelGate::route(false, 5, true, true, 2);
        let reenabled = ChannelGate::route(true, 6, true, true, 2);
        assert_eq!(captured.system_delivery(disabled, false, false), None);
        assert_eq!(captured.system_delivery(reenabled, false, false), None);
        assert_eq!(disabled.system_delivery(reenabled, false, false), None);
        assert!(captured.allows_bubble(reenabled));
    }
    #[test]
    fn bubble_preference_changes_do_not_disable_or_reset_sound_only_alerts() {
        let bubbles_on = ChannelGate::route(true, 1, true, true, 2);
        let bubbles_off = ChannelGate::route(true, 1, true, false, 3);
        assert!(bubbles_off.active());
        assert!(bubbles_off.continuous(Some(bubbles_on)));
        assert_eq!(
            bubbles_on.system_delivery(bubbles_off, false, false),
            Some(SystemDelivery::SoundOnly)
        );
        assert!(!bubbles_on.allows_bubble(bubbles_off));
    }
    #[test]
    fn first_activation_always_rebases() {
        assert!(!gate(true, 0, true, 1).continuous(None));
    }
}
