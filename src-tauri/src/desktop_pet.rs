//! Windows-only, pet-scoped physical-pixel bridge for frontend physics.
//! No app launch, filesystem access, arbitrary target labels, or CSS scaling.
#![cfg(windows)]

use super::assistant::assert_assistant;
use crate::pet_geometry::{
    clamp_pet_position, pet_horizontal_inset, valid_area, valid_size, Area, Point, Size,
};
use crate::pet_native_policy::{clamped_move_target, valid_grab, WorkAreaCache};
use serde::Serialize;
use std::{
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::{AppHandle, Manager, PhysicalPosition, Webview, Window};

// Keep this local: windows-sys does not enable KeyboardAndMouse, and the bridge
// only needs this single read-only user32 entry point (no Cargo feature changes).
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

/// Shared with native hit testing so OS-level drags never become click-through.
pub(super) fn left_button_down() -> bool {
    // Only the high bit denotes current state; ignore the unreliable low bit.
    // SAFETY: GetAsyncKeyState takes a scalar virtual-key code, no pointers.
    unsafe { GetAsyncKeyState(0x01) < 0 } // VK_LBUTTON
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct PetGeometry {
    position: Point,
    size: Size,
    cursor: Point,
    /// Informational only. All other fields already use physical screen pixels.
    scale: f64,
    areas: Vec<Area>,
    cursor_down: bool,
    escape_down: bool,
    /// Transparent left/right stage padding; only the character must remain visible.
    horizontal_inset: f64,
}

fn pet_window(view: &Webview, app: &AppHandle) -> Result<Window, String> {
    assert_assistant(view)?;
    let url = view.url().map_err(|_| "无法验证助手页面。")?;
    // assert_assistant checks the exact local origin/path, credentials, fragment,
    // and query pairs. Also require the literal pet query and both native labels;
    // chat, child webviews, and alternate query encodings cannot move this window.
    if view.label() != "assistant-pet"
        || view.window().label() != "assistant-pet"
        || url.query() != Some("view=pet")
    {
        return Err("此页面无权读取或移动桌面宠物。".into());
    }
    app.get_window("assistant-pet")
        .ok_or_else(|| "桌面宠物窗口不存在。".into())
}

static WORK_AREAS: OnceLock<Mutex<WorkAreaCache>> = OnceLock::new();
static CACHE_EPOCH: OnceLock<Instant> = OnceLock::new();

fn area_cache() -> &'static Mutex<WorkAreaCache> {
    WORK_AREAS.get_or_init(|| Mutex::new(WorkAreaCache::default()))
}

/// Event callbacks only touch policy state; never call Tauri while holding this mutex.
pub(super) fn invalidate_work_areas() {
    area_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .invalidate();
}

fn monitor_area(monitor: &tauri::Monitor) -> Area {
    let area = monitor.work_area();
    Area {
        x: f64::from(area.position.x),
        y: f64::from(area.position.y),
        width: f64::from(area.size.width),
        height: f64::from(area.size.height),
    }
}

fn current_work_area(window: &Window) -> Result<Area, String> {
    let result = window
        .current_monitor()
        .map_err(|_| "无法读取当前屏幕工作区。".to_owned())
        .and_then(|monitor| monitor.ok_or_else(|| "当前屏幕工作区不可用。".to_owned()))
        .map(|monitor| monitor_area(&monitor))
        .and_then(|area| {
            if valid_area(area) {
                Ok(area)
            } else {
                Err("当前屏幕工作区无效。".to_owned())
            }
        });
    if result.is_err() {
        invalidate_work_areas();
    }
    result
}

fn work_areas(window: &Window) -> Result<Vec<Area>, String> {
    let epoch = CACHE_EPOCH.get_or_init(Instant::now);
    for _ in 0..3 {
        // A cheap fresh probe catches cross-monitor/taskbar changes before using cached bounds.
        let current = current_work_area(window)?;
        let ticket = {
            let mut cache = area_cache().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(areas) = cache.cached(epoch.elapsed(), current) {
                return Ok(areas);
            }
            cache.begin_refresh()
        };
        // No lock spans UI dispatch: resize/DPI events can reenter and invalidate the ticket.
        let areas: Vec<_> = window
            .available_monitors()
            .map_err(|_| "无法读取屏幕工作区。")?
            .iter()
            .map(monitor_area)
            .collect();
        let current = current_work_area(window)?;
        let published = area_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .publish(ticket, epoch.elapsed(), current, areas.clone())?;
        if published {
            return Ok(areas);
        }
    }
    Err("屏幕工作区持续变化，无法安全放置桌面宠物。".into())
}

fn window_size(window: &Window) -> Result<Size, String> {
    let size = window.outer_size().map_err(|_| "无法读取宠物窗口尺寸。")?;
    let size = Size {
        width: f64::from(size.width),
        height: f64::from(size.height),
    };
    if !valid_size(size) {
        return Err("助手窗口尺寸无效。".into());
    }
    Ok(size)
}

fn geometry(window: &Window, app: &AppHandle) -> Result<PetGeometry, String> {
    let position = window
        .outer_position()
        .map_err(|_| "无法读取宠物窗口位置。")?;
    let cursor = app.cursor_position().map_err(|_| "无法读取鼠标位置。")?;
    let scale = window.scale_factor().map_err(|_| "无法读取屏幕缩放。")?;
    if !cursor.x.is_finite() || !cursor.y.is_finite() || !scale.is_finite() || scale <= 0.0 {
        return Err("屏幕坐标或缩放无效。".into());
    }
    let size = window_size(window)?;
    Ok(PetGeometry {
        position: Point {
            x: f64::from(position.x),
            y: f64::from(position.y),
        },
        size,
        cursor: Point {
            x: cursor.x,
            y: cursor.y,
        },
        scale,
        areas: work_areas(window)?,
        cursor_down: left_button_down(),
        // SAFETY: GetAsyncKeyState takes a scalar virtual-key code, no pointers.
        escape_down: unsafe { GetAsyncKeyState(0x1B) < 0 }, // VK_ESCAPE
        horizontal_inset: pet_horizontal_inset(size),
    })
}

/// Internal placement path, also used when restoring saved edge positions.
pub(super) fn constrain_pet_position(window: &Window, requested: Point) -> Result<Point, String> {
    clamp_pet_position(requested, window_size(window)?, &work_areas(window)?).map_err(str::to_owned)
}

#[tauri::command]
pub(super) fn get_pet_geometry(view: Webview, app: AppHandle) -> Result<PetGeometry, String> {
    let window = pet_window(&view, &app)?;
    geometry(&window, &app)
}

/// Ordinary dragging performs cursor sampling and movement in one authenticated IPC.
#[tauri::command]
pub(super) fn drag_pet(
    view: Webview,
    app: AppHandle,
    grab_x: f64,
    grab_y: f64,
) -> Result<PetGeometry, String> {
    let window = pet_window(&view, &app)?;
    let grab = Point {
        x: grab_x,
        y: grab_y,
    };
    if !valid_grab(grab) {
        return Err("抓取偏移必须是合理范围内的有限物理像素坐标。".into());
    }
    let actual = geometry(&window, &app)?;
    if !actual.cursor_down {
        return Ok(actual);
    }
    let requested = Point {
        x: actual.cursor.x - grab.x,
        y: actual.cursor.y - grab.y,
    };
    move_to(&window, &app, requested, actual, true)
}

#[tauri::command]
pub(super) fn move_pet(
    view: Webview,
    app: AppHandle,
    x: f64,
    y: f64,
) -> Result<PetGeometry, String> {
    let window = pet_window(&view, &app)?;
    let actual = geometry(&window, &app)?;
    move_to(&window, &app, Point { x, y }, actual, false)
}

fn move_to(
    window: &Window,
    app: &AppHandle,
    mut requested: Point,
    mut actual: PetGeometry,
    dragging: bool,
) -> Result<PetGeometry, String> {
    // Windows may resize the physical window when crossing mixed-DPI monitors.
    // Re-read native geometry and correct using that *actual* size, without
    // multiplying by scale ourselves. Bound retries for display hotplug/races.
    for _ in 0..3 {
        if dragging && !left_button_down() {
            return geometry(window, app);
        }
        // No-op decisions use a fresh actual native position, never a frontend position cache.
        if let Some(position) =
            clamped_move_target(requested, actual.position, actual.size, &actual.areas)?
        {
            window
                .set_position(PhysicalPosition::new(position.x as i32, position.y as i32))
                .map_err(|_| "无法移动桌面宠物。")?;
        }
        // Even skipped movement returns fresh cursor/buttons and detects geometry/DPI changes.
        actual = geometry(window, app)?;
        let visible = clamp_pet_position(actual.position, actual.size, &actual.areas)?;
        if visible == actual.position {
            return Ok(actual);
        }
        requested = visible;
    }
    Err("屏幕几何持续变化，无法安全放置桌面宠物。".into())
}
