//! Windows-only, pet-scoped physical-pixel bridge for frontend physics.
//! No app launch, filesystem access, arbitrary target labels, or CSS scaling.
#![cfg(windows)]

use super::assistant::assert_assistant;
use crate::pet_geometry::{clamp_position, valid_area, valid_size, Area, Point, Size};
use serde::Serialize;
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

fn work_areas(window: &Window) -> Result<Vec<Area>, String> {
    let areas: Vec<_> = window
        .available_monitors()
        .map_err(|_| "无法读取屏幕工作区。")?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Area {
                x: f64::from(area.position.x),
                y: f64::from(area.position.y),
                width: f64::from(area.size.width),
                height: f64::from(area.size.height),
            }
        })
        .filter(|area| valid_area(*area))
        .collect();
    if areas.is_empty() {
        return Err("没有可用的屏幕工作区。".into());
    }
    Ok(areas)
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
    Ok(PetGeometry {
        position: Point {
            x: f64::from(position.x),
            y: f64::from(position.y),
        },
        size: window_size(window)?,
        cursor: Point {
            x: cursor.x,
            y: cursor.y,
        },
        scale,
        areas: work_areas(window)?,
        cursor_down: left_button_down(),
    })
}

#[tauri::command]
pub(super) fn get_pet_geometry(view: Webview, app: AppHandle) -> Result<PetGeometry, String> {
    let window = pet_window(&view, &app)?;
    geometry(&window, &app)
}

#[tauri::command]
pub(super) fn move_pet(
    view: Webview,
    app: AppHandle,
    x: f64,
    y: f64,
) -> Result<PetGeometry, String> {
    let window = pet_window(&view, &app)?;
    let mut position =
        clamp_position(Point { x, y }, window_size(&window)?, &work_areas(&window)?)?;
    // Windows may resize the physical window when crossing mixed-DPI monitors.
    // Re-read native geometry and correct using that *actual* size, without
    // multiplying by scale ourselves. Bound retries for display hotplug/races.
    for _ in 0..3 {
        // clamp_position validates the range and yields integral physical pixels.
        window
            .set_position(PhysicalPosition::new(position.x as i32, position.y as i32))
            .map_err(|_| "无法移动桌面宠物。")?;
        let actual = geometry(&window, &app)?;
        let visible = clamp_position(actual.position, actual.size, &actual.areas)?;
        if visible == actual.position {
            return Ok(actual);
        }
        position = visible;
    }
    Err("屏幕几何持续变化，无法安全放置桌面宠物。".into())
}
