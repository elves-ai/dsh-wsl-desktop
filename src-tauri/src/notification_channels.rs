//! Delivery-channel epochs keep independently enabled pet bubbles and Windows toasts
//! from replaying historical events or resetting an already active channel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChannelGate {
    pub toasts: bool,
    pub toast_epoch: u64,
    pub bubbles: bool,
    pub bubble_epoch: u64,
}
impl ChannelGate {
    pub fn route(
        toast_enabled: bool,
        toast_epoch: u64,
        pet_visible: bool,
        bubble_enabled: bool,
        bubble_epoch: u64,
    ) -> Self {
        Self {
            toasts: toast_enabled && !pet_visible,
            toast_epoch,
            bubbles: pet_visible && bubble_enabled,
            bubble_epoch,
        }
    }
    pub fn active(self) -> bool {
        self.toasts || self.bubbles
    }
    pub fn allows_toast(self, live: Self) -> bool {
        self.toasts && live.toasts && self.toast_epoch == live.toast_epoch
    }
    pub fn allows_bubble(self, live: Self) -> bool {
        self.bubbles && live.bubbles && self.bubble_epoch == live.bubble_epoch
    }
    pub fn current(self, live: Self) -> bool {
        self.allows_toast(live) || self.allows_bubble(live)
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
            toasts,
            toast_epoch: t,
            bubbles,
            bubble_epoch: b,
        }
    }
    #[test]
    fn bubbles_alone_monitor_without_toast_permission() {
        let g = gate(false, 0, true, 1);
        assert!(g.active());
        assert!(g.allows_bubble(g));
        assert!(!g.allows_toast(g));
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
        assert!(!old.allows_toast(live));
        assert!(old.allows_bubble(live));
    }
    #[test]
    fn hiding_pet_does_not_reset_ongoing_toasts() {
        let old = gate(true, 1, true, 1);
        let live = gate(true, 1, false, 2);
        assert!(live.continuous(Some(old)));
        assert!(!old.allows_bubble(live));
        assert!(old.allows_toast(live));
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
        assert!(old.allows_toast(live));
    }
    #[test]
    fn swapping_only_channel_rebases_without_history() {
        assert!(!gate(false, 2, true, 1).continuous(Some(gate(true, 1, false, 0))));
    }
    #[test]
    fn visible_pet_never_produces_system_toast() {
        for bubbles in [false, true] {
            let g = ChannelGate::route(true, 1, true, bubbles, 1);
            assert!(!g.toasts);
            assert_eq!(g.bubbles, bubbles);
        }
    }
    #[test]
    fn hidden_pet_uses_only_explicit_system_setting() {
        for toasts in [false, true] {
            let g = ChannelGate::route(toasts, 1, false, true, 1);
            assert_eq!(g.toasts, toasts);
            assert!(!g.bubbles);
        }
    }
    #[test]
    fn first_activation_always_rebases() {
        assert!(!gate(true, 0, true, 1).continuous(None));
    }
}
