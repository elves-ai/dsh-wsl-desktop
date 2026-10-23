//! Pure physical-pixel geometry shared by the native pet bridge and its tests.
//! Never multiply these values by a CSS/device scale factor.
use serde::Serialize;

/// A deliberately conservative bound, well inside Win32 signed pixel coordinates.
pub const MAX_PHYSICAL_COORDINATE: f64 = 1_000_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn coordinate(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_PHYSICAL_COORDINATE
}

pub fn valid_size(size: Size) -> bool {
    coordinate(size.width) && coordinate(size.height) && size.width > 0.0 && size.height > 0.0
}

pub fn valid_area(area: Area) -> bool {
    coordinate(area.x)
        && coordinate(area.y)
        && valid_size(Size {
            width: area.width,
            height: area.height,
        })
        && coordinate(area.x + area.width)
        && coordinate(area.y + area.height)
}

/// Find the nearest *individual* work area that can contain the whole window.
/// The union bounding box is deliberately not used: it can contain monitor gaps.
/// Returned positions are integral physical pixels, ready for Win32/Tauri.
/// Oversized windows fail closed instead of being left partly off screen.
pub fn clamp_position(requested: Point, size: Size, areas: &[Area]) -> Result<Point, &'static str> {
    if !coordinate(requested.x) || !coordinate(requested.y) {
        return Err("助手位置必须是合理范围内的有限物理像素坐标。");
    }
    if !valid_size(size) {
        return Err("助手窗口尺寸无效。");
    }
    let mut nearest: Option<(Point, f64)> = None;
    for &area in areas {
        if !valid_area(area) || size.width > area.width || size.height > area.height {
            continue;
        }
        let min_x = area.x.ceil();
        let min_y = area.y.ceil();
        let max_x = (area.x + area.width - size.width).floor();
        let max_y = (area.y + area.height - size.height).floor();
        if max_x < min_x || max_y < min_y {
            continue;
        }
        let candidate = Point {
            x: requested.x.round().clamp(min_x, max_x),
            y: requested.y.round().clamp(min_y, max_y),
        };
        let distance = (candidate.x - requested.x).powi(2) + (candidate.y - requested.y).powi(2);
        // Stable monitor-order tie breaking prevents jitter between equidistant screens.
        if nearest.as_ref().map_or(true, |(_, best)| distance < *best) {
            nearest = Some((candidate, distance));
        }
    }
    nearest
        .map(|(position, _)| position)
        .ok_or("没有能完整容纳助手窗口的屏幕工作区。")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PET: Size = Size {
        width: 220.0,
        height: 250.0,
    };
    const MAIN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };

    #[test]
    fn preserves_physical_pixels_and_rounds_once() {
        assert_eq!(
            clamp_position(Point { x: 123.4, y: 456.7 }, PET, &[MAIN]),
            Ok(Point { x: 123.0, y: 457.0 })
        );
    }

    #[test]
    fn clamps_to_work_area_not_taskbar_or_outer_screen() {
        assert_eq!(
            clamp_position(
                Point {
                    x: 1919.0,
                    y: 1079.0
                },
                PET,
                &[MAIN]
            ),
            Ok(Point {
                x: 1700.0,
                y: 790.0
            })
        );
    }

    #[test]
    fn never_places_window_in_multimonitor_gap() {
        let right = Area {
            x: 3000.0,
            y: 500.0,
            width: 1920.0,
            height: 1040.0,
        };
        assert_eq!(
            clamp_position(
                Point {
                    x: 2400.0,
                    y: 600.0
                },
                PET,
                &[MAIN, right]
            ),
            Ok(Point {
                x: 3000.0,
                y: 600.0
            })
        );
        assert_eq!(
            clamp_position(
                Point {
                    x: 2100.0,
                    y: 600.0
                },
                PET,
                &[MAIN, right]
            ),
            Ok(Point {
                x: 1700.0,
                y: 600.0
            })
        );
    }

    #[test]
    fn supports_negative_and_staggered_monitors() {
        let left = Area {
            x: -1920.0,
            y: -400.0,
            width: 1920.0,
            height: 1040.0,
        };
        assert_eq!(
            clamp_position(
                Point {
                    x: -2100.0,
                    y: -500.0
                },
                PET,
                &[MAIN, left]
            ),
            Ok(Point {
                x: -1920.0,
                y: -400.0
            })
        );
        assert_eq!(
            clamp_position(
                Point {
                    x: -150.0,
                    y: 500.0
                },
                PET,
                &[MAIN, left]
            ),
            Ok(Point {
                x: -220.0,
                y: 390.0
            })
        );
    }

    #[test]
    fn selects_fitting_monitor_even_when_small_monitor_is_nearer() {
        let tiny = Area {
            x: 2000.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        assert_eq!(
            clamp_position(Point { x: 2000.0, y: 0.0 }, PET, &[tiny, MAIN]),
            Ok(Point { x: 1700.0, y: 0.0 })
        );
    }

    #[test]
    fn oversized_window_is_rejected_not_partially_hidden() {
        assert!(clamp_position(
            Point { x: 0.0, y: 0.0 },
            Size {
                width: 1921.0,
                height: 250.0
            },
            &[MAIN]
        )
        .is_err());
        assert!(clamp_position(
            Point { x: 0.0, y: 0.0 },
            Size {
                width: 220.0,
                height: 1041.0
            },
            &[MAIN]
        )
        .is_err());
    }

    #[test]
    fn exactly_fitting_window_has_one_valid_position() {
        assert_eq!(
            clamp_position(
                Point {
                    x: -999.0,
                    y: 999.0
                },
                Size {
                    width: MAIN.width,
                    height: MAIN.height
                },
                &[MAIN]
            ),
            Ok(Point { x: 0.0, y: 0.0 })
        );
    }

    #[test]
    fn rejects_nan_infinity_and_unreasonable_coordinates() {
        for value in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            1_000_001.0,
            -1_000_001.0,
        ] {
            assert!(clamp_position(Point { x: value, y: 0.0 }, PET, &[MAIN]).is_err());
            assert!(clamp_position(Point { x: 0.0, y: value }, PET, &[MAIN]).is_err());
        }
    }

    #[test]
    fn rejects_invalid_dimensions_and_missing_or_invalid_monitors() {
        let origin = Point { x: 0.0, y: 0.0 };
        for value in [f64::NAN, f64::INFINITY, 0.0, -1.0, 1_000_001.0] {
            assert!(clamp_position(
                origin,
                Size {
                    width: value,
                    height: 250.0
                },
                &[MAIN]
            )
            .is_err());
            assert!(clamp_position(
                origin,
                Size {
                    width: 220.0,
                    height: value
                },
                &[MAIN]
            )
            .is_err());
        }
        assert!(clamp_position(origin, PET, &[]).is_err());
        let invalid = Area {
            x: f64::NAN,
            ..MAIN
        };
        assert!(clamp_position(origin, PET, &[invalid]).is_err());
        assert_eq!(clamp_position(origin, PET, &[invalid, MAIN]), Ok(origin));
    }

    #[test]
    fn reclamps_actual_size_after_mixed_dpi_resize() {
        let first = clamp_position(
            Point {
                x: 1700.0,
                y: 790.0,
            },
            PET,
            &[MAIN],
        )
        .unwrap();
        let resized = Size {
            width: 440.0,
            height: 500.0,
        };
        let corrected = clamp_position(first, resized, &[MAIN]).unwrap();
        assert_eq!(
            corrected,
            Point {
                x: 1480.0,
                y: 540.0
            }
        );
        assert_eq!(clamp_position(corrected, resized, &[MAIN]), Ok(corrected));
    }

    #[test]
    fn equidistant_monitors_use_stable_order() {
        let left = Area { x: -1920.0, ..MAIN };
        assert_eq!(
            clamp_position(Point { x: -110.0, y: 50.0 }, PET, &[left, MAIN]),
            Ok(Point { x: -220.0, y: 50.0 })
        );
    }
}
