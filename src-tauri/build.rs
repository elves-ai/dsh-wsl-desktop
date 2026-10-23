fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_snapshot",
                "open_settings",
                "return_from_settings",
                "settings_page_ready",
                "perform_action",
                "set_project_directory",
                "get_update_snapshot",
                "check_update",
                "install_update",
                "get_notification_snapshot",
                "set_notifications_enabled",
                "test_notification",
                "get_power_snapshot",
                "set_power_enabled",
                "titlebar_action",
                "open_titlebar_settings",
                "open_titlebar_updates",
                "get_titlebar_update_state",
            ]),
        ))
        .expect("Failed to build Tauri resources");
    }
}
