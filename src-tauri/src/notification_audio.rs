//! Pre-generated, approved notification voice clips. Playback never invokes a model.
use crate::pet_notifications::BubbleKind;

// PlaySound requires DWORD-aligned WAVE data that outlives asynchronous playback.
#[repr(C, align(4))]
struct NotificationSound<const N: usize>([u8; N]);

static COMPLETED_SOUND: NotificationSound<
    { include_bytes!("assets/notification-completed.wav").len() },
> = NotificationSound(*include_bytes!("assets/notification-completed.wav"));
static FAILED_SOUND: NotificationSound<{ include_bytes!("assets/notification-failed.wav").len() }> =
    NotificationSound(*include_bytes!("assets/notification-failed.wav"));
static WAITING_SOUND: NotificationSound<
    { include_bytes!("assets/notification-waiting.wav").len() },
> = NotificationSound(*include_bytes!("assets/notification-waiting.wav"));

/// Same status-to-voice mapping for sound-only alerts and silent Windows cards.
pub fn notification_sound(kind: BubbleKind) -> &'static [u8] {
    match kind {
        BubbleKind::Completed => &COMPLETED_SOUND.0,
        BubbleKind::Failed => &FAILED_SOUND.0,
        BubbleKind::Waiting => &WAITING_SOUND.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn each_status_uses_its_approved_voice_clip() {
        for (kind, expected) in [
            (
                BubbleKind::Completed,
                "348d633480fbf44b3227cd17e435569d425411c6ae7c66dccf5e365a4d5c68c5",
            ),
            (
                BubbleKind::Failed,
                "69126a2a45dd5b67fe983ccabd398c629aea6d09a0fd6560b80ba865b32182c9",
            ),
            (
                BubbleKind::Waiting,
                "30b8b1816a4c208af41f6fb3018d8139755abfb7a16f0d098e1c7aa92a22b515",
            ),
        ] {
            assert_eq!(
                format!("{:x}", Sha256::digest(notification_sound(kind))),
                expected
            );
        }
    }

    #[test]
    fn embedded_pcm_buffers_are_aligned_and_have_static_lifetimes() {
        for kind in [
            BubbleKind::Completed,
            BubbleKind::Failed,
            BubbleKind::Waiting,
        ] {
            let sound: &'static [u8] = notification_sound(kind);
            assert_eq!(sound.as_ptr() as usize % 4, 0);
            assert_eq!(&sound[..4], b"RIFF");
            assert_eq!(&sound[8..12], b"WAVE");
            assert_eq!(u16::from_le_bytes(sound[20..22].try_into().unwrap()), 1);
            assert_eq!(u16::from_le_bytes(sound[22..24].try_into().unwrap()), 1);
            assert_eq!(u32::from_le_bytes(sound[24..28].try_into().unwrap()), 24000);
            assert_eq!(u16::from_le_bytes(sound[34..36].try_into().unwrap()), 16);
        }
    }
}
