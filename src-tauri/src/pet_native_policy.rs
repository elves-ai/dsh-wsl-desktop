//! Deterministic policies for the native pet bridge; no Tauri, OS calls, or locks.
use crate::pet_geometry::{
    clamp_pet_position, valid_area, Area, Point, Size, MAX_PHYSICAL_COORDINATE,
};
use std::time::Duration;

/// Independent owners of pet keyboard focusability. Only an explicit composer open
/// may activate the window; notification changes merely recompute focusability.
pub struct PetFocusPolicy {
    composer_active: bool,
    interaction_surface_active: bool,
}
impl Default for PetFocusPolicy {
    fn default() -> Self {
        Self {
            composer_active: false,
            interaction_surface_active: true,
        }
    }
}
impl PetFocusPolicy {
    pub fn set_composer_active(&mut self, active: bool) {
        self.composer_active = active;
    }
    pub fn set_interaction_surface_active(&mut self, active: bool) {
        self.interaction_surface_active = active;
    }
    pub fn composer_active(&self) -> bool {
        self.composer_active
    }
    pub fn focusable(&mut self, visible: bool, live_cards: bool) -> bool {
        if !visible {
            // Showing the pet again must not restore an old typing lease.
            self.composer_active = false;
        }
        visible && (self.composer_active || (self.interaction_surface_active && live_cards))
    }
}

pub const WORK_AREA_CACHE_TTL: Duration = Duration::from_millis(350);

struct Snapshot {
    areas: Vec<Area>,
    fetched_at: Duration,
}

/// Callers must release their mutex before probing or enumerating native monitors.
/// Refresh tickets prevent reentrant resize/DPI invalidations from publishing old data.
#[derive(Default)]
pub struct WorkAreaCache {
    generation: u64,
    snapshot: Option<Snapshot>,
}

impl WorkAreaCache {
    pub fn cached(&self, now: Duration, current: Area) -> Option<Vec<Area>> {
        let snapshot = self.snapshot.as_ref()?;
        if !valid_area(current)
            || now < snapshot.fetched_at
            || now - snapshot.fetched_at >= WORK_AREA_CACHE_TTL
            || !snapshot.areas.contains(&current)
        {
            return None;
        }
        Some(snapshot.areas.clone())
    }

    pub fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.snapshot = None;
    }

    /// Clear old data *before* fetching: a failed refresh cannot fall back to stale data.
    pub fn begin_refresh(&mut self) -> u64 {
        self.invalidate();
        self.generation
    }

    /// false means an invalidation/new refresh superseded this ticket. Retry outside the lock.
    pub fn publish(
        &mut self,
        ticket: u64,
        now: Duration,
        current: Area,
        areas: Vec<Area>,
    ) -> Result<bool, &'static str> {
        if ticket != self.generation {
            return Ok(false);
        }
        if !valid_area(current)
            || areas.is_empty()
            || !areas.iter().all(|area| valid_area(*area))
            || !areas.contains(&current)
        {
            self.snapshot = None;
            return Err("屏幕工作区无效或正在变化，无法安全放置桌面宠物。");
        }
        self.snapshot = Some(Snapshot {
            areas,
            fetched_at: now,
        });
        Ok(true)
    }
}

/// Physical grab offsets are untrusted IPC input, even when the left button is up.
pub fn valid_grab(grab: Point) -> bool {
    [grab.x, grab.y]
        .iter()
        .all(|value| value.is_finite() && value.abs() <= MAX_PHYSICAL_COORDINATE)
}

/// None skips SetWindowPos only when the clamped integral target equals an actual native read.
pub fn clamped_move_target(
    requested: Point,
    actual: Point,
    size: Size,
    areas: &[Area],
) -> Result<Option<Point>, &'static str> {
    let target = clamp_pet_position(requested, size, areas)?;
    Ok((target != actual).then_some(target))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composer_focus_survives_notification_and_surface_changes() {
        let mut focus = PetFocusPolicy::default();
        assert!(!focus.focusable(true, false));
        focus.set_composer_active(true);
        // No cards (including disconnects/bubbles disabled) must not cancel typing.
        assert!(focus.focusable(true, false));
        assert!(focus.focusable(true, true));
        focus.set_interaction_surface_active(false);
        assert!(focus.focusable(true, true));
        assert!(focus.focusable(true, false));
        focus.set_composer_active(false);
        assert!(!focus.focusable(true, true));
    }

    #[test]
    fn composer_close_preserves_only_live_card_focus() {
        let mut focus = PetFocusPolicy::default();
        focus.set_composer_active(true);
        focus.set_composer_active(false);
        assert!(focus.focusable(true, true));
        assert!(!focus.focusable(true, false));
        focus.set_interaction_surface_active(false);
        assert!(!focus.focusable(true, true));
    }

    #[test]
    fn hidden_pet_releases_composer_and_does_not_restore_typing() {
        let mut focus = PetFocusPolicy::default();
        focus.set_composer_active(true);
        assert!(!focus.focusable(false, true));
        assert!(!focus.composer_active());
        assert!(!focus.focusable(true, false));
        // Delayed input-open IPC while hidden must not arm the next show either.
        focus.set_composer_active(true);
        assert!(!focus.focusable(false, false));
        assert!(!focus.focusable(true, false));
        assert!(focus.focusable(true, true));
    }

    const MAIN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };
    const LEFT: Area = Area {
        x: -1920.0,
        y: -400.0,
        width: 1920.0,
        height: 1040.0,
    };
    const PET: Size = Size {
        width: 360.0,
        height: 320.0,
    };
    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }
    fn read(
        cache: &mut WorkAreaCache,
        now: Duration,
        current: Area,
        result: Result<Vec<Area>, &'static str>,
        enumerations: &mut usize,
    ) -> Result<Vec<Area>, &'static str> {
        if let Some(areas) = cache.cached(now, current) {
            return Ok(areas);
        }
        let ticket = cache.begin_refresh();
        *enumerations += 1;
        let areas = result?;
        assert!(cache.publish(ticket, now, current, areas.clone())?);
        Ok(areas)
    }

    #[test]
    fn repeated_geometry_reads_enumerate_once_per_ttl_not_per_frame() {
        let mut cache = WorkAreaCache::default();
        let mut count = 0;
        for frame in 0..100 {
            for _ in 0..3 {
                assert_eq!(
                    read(
                        &mut cache,
                        ms(frame * 16),
                        MAIN,
                        Ok(vec![MAIN, LEFT]),
                        &mut count
                    ),
                    Ok(vec![MAIN, LEFT])
                );
            }
        }
        assert_eq!(count, 5); // 300 snapshot reads, only t=0/352/704/1056/1408 enumerate.
    }

    #[test]
    fn cache_expires_exactly_at_ttl_and_time_regression_cannot_extend_it() {
        let mut cache = WorkAreaCache::default();
        let ticket = cache.begin_refresh();
        cache.publish(ticket, ms(100), MAIN, vec![MAIN]).unwrap();
        assert!(cache.cached(ms(449), MAIN).is_some());
        assert!(cache.cached(ms(450), MAIN).is_none());
        assert!(cache.cached(ms(99), MAIN).is_none());
    }

    #[test]
    fn resize_or_dpi_explicit_invalidation_refreshes_before_ttl() {
        let mut cache = WorkAreaCache::default();
        let mut count = 0;
        read(&mut cache, ms(0), MAIN, Ok(vec![MAIN]), &mut count).unwrap();
        cache.invalidate();
        read(&mut cache, ms(1), MAIN, Ok(vec![MAIN]), &mut count).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn taskbar_or_current_monitor_area_changes_refresh_immediately() {
        let mut cache = WorkAreaCache::default();
        let mut count = 0;
        read(&mut cache, ms(0), MAIN, Ok(vec![MAIN]), &mut count).unwrap();
        let taskbar = Area {
            height: 1000.0,
            ..MAIN
        };
        read(
            &mut cache,
            ms(1),
            taskbar,
            Ok(vec![taskbar, LEFT]),
            &mut count,
        )
        .unwrap();
        read(&mut cache, ms(2), LEFT, Ok(vec![taskbar, LEFT]), &mut count).unwrap();
        assert_eq!(count, 2); // Crossing onto an already validated cached monitor needs no enumeration.
        let added = Area { x: 3000.0, ..MAIN };
        read(
            &mut cache,
            ms(3),
            added,
            Ok(vec![taskbar, LEFT, added]),
            &mut count,
        )
        .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn noncurrent_monitor_hotplug_is_picked_up_at_bounded_ttl() {
        let mut cache = WorkAreaCache::default();
        let mut count = 0;
        read(&mut cache, ms(0), MAIN, Ok(vec![MAIN, LEFT]), &mut count).unwrap();
        assert_eq!(
            read(&mut cache, ms(349), MAIN, Ok(vec![MAIN]), &mut count).unwrap(),
            vec![MAIN, LEFT]
        );
        assert_eq!(
            read(&mut cache, ms(350), MAIN, Ok(vec![MAIN]), &mut count).unwrap(),
            vec![MAIN]
        );
        assert_eq!(count, 2);
    }

    #[test]
    fn failed_refresh_never_reuses_or_revalidates_the_old_snapshot() {
        let mut cache = WorkAreaCache::default();
        let mut count = 0;
        read(&mut cache, ms(0), MAIN, Ok(vec![MAIN]), &mut count).unwrap();
        assert_eq!(
            read(
                &mut cache,
                ms(350),
                MAIN,
                Err("enumeration failed"),
                &mut count
            ),
            Err("enumeration failed")
        );
        assert!(cache.cached(ms(351), MAIN).is_none());
        assert_eq!(
            read(&mut cache, ms(351), MAIN, Ok(vec![MAIN]), &mut count),
            Ok(vec![MAIN])
        );
        assert_eq!(count, 3);
    }

    #[test]
    fn generation_guard_rejects_inflight_refresh_after_reentrant_invalidation() {
        let mut cache = WorkAreaCache::default();
        let old = cache.begin_refresh();
        cache.invalidate();
        assert_eq!(cache.publish(old, ms(1), MAIN, vec![MAIN]), Ok(false));
        assert!(cache.cached(ms(2), MAIN).is_none());
        let newest = cache.begin_refresh();
        cache
            .publish(newest, ms(3), MAIN, vec![MAIN, LEFT])
            .unwrap();
        assert_eq!(cache.publish(old, ms(4), MAIN, vec![MAIN]), Ok(false));
        assert_eq!(cache.cached(ms(4), MAIN).unwrap(), vec![MAIN, LEFT]);
    }

    #[test]
    fn invalid_or_missing_current_area_fails_closed_on_refresh() {
        for areas in [
            vec![],
            vec![LEFT],
            vec![
                MAIN,
                Area {
                    height: 0.0,
                    ..LEFT
                },
            ],
        ] {
            let mut cache = WorkAreaCache::default();
            let ticket = cache.begin_refresh();
            assert!(cache.publish(ticket, ms(0), MAIN, areas).is_err());
            assert!(cache.cached(ms(1), MAIN).is_none());
        }
        let mut cache = WorkAreaCache::default();
        let ticket = cache.begin_refresh();
        let invalid = Area {
            x: f64::NAN,
            ..MAIN
        };
        assert!(cache.publish(ticket, ms(0), invalid, vec![MAIN]).is_err());
    }

    #[test]
    fn grab_validation_is_finite_bounded_and_does_not_scale_physical_pixels() {
        assert!(valid_grab(Point { x: -42.5, y: 300.0 }));
        assert!(valid_grab(Point {
            x: MAX_PHYSICAL_COORDINATE,
            y: -MAX_PHYSICAL_COORDINATE
        }));
        for value in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            MAX_PHYSICAL_COORDINATE + 1.0,
        ] {
            assert!(!valid_grab(Point { x: value, y: 0.0 }));
            assert!(!valid_grab(Point { x: 0.0, y: value }));
        }
    }

    #[test]
    fn unchanged_integral_target_skips_move_but_actual_external_movement_does_not() {
        let requested = Point { x: 100.4, y: 200.1 };
        assert_eq!(
            clamped_move_target(requested, Point { x: 100.0, y: 200.0 }, PET, &[MAIN]),
            Ok(None)
        );
        assert_eq!(
            clamped_move_target(requested, Point { x: 90.0, y: 200.0 }, PET, &[MAIN]),
            Ok(Some(Point { x: 100.0, y: 200.0 }))
        );
    }

    #[test]
    fn repeated_clamped_edge_requests_skip_only_after_actual_native_edge_is_reached() {
        let requested = Point {
            x: -9999.0,
            y: -9999.0,
        };
        let edge = Point {
            x: -2032.0,
            y: -400.0,
        };
        assert_eq!(
            clamped_move_target(requested, edge, PET, &[LEFT, MAIN]),
            Ok(None)
        );
        assert_eq!(
            clamped_move_target(
                requested,
                Point {
                    x: -1900.0,
                    y: -300.0
                },
                PET,
                &[LEFT, MAIN]
            ),
            Ok(Some(edge))
        );
    }

    #[test]
    fn changed_actual_size_reclamps_after_dpi_even_when_requested_position_is_unchanged() {
        let actual = Point {
            x: 1672.0,
            y: 720.0,
        };
        assert_eq!(clamped_move_target(actual, actual, PET, &[MAIN]), Ok(None));
        let larger = Size {
            width: 720.0,
            height: 640.0,
        };
        assert_eq!(
            clamped_move_target(actual, actual, larger, &[MAIN]),
            Ok(Some(Point {
                x: 1425.0,
                y: 400.0
            }))
        );
        assert!(clamped_move_target(
            Point {
                x: f64::NAN,
                y: 0.0
            },
            actual,
            PET,
            &[MAIN]
        )
        .is_err());
    }
}
