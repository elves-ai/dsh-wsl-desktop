fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_snapshot",
                "open_settings",
                "perform_action",
                "set_project_directory",
                "get_update_snapshot",
                "check_update",
                "install_update",
                "get_notification_snapshot",
                "set_notifications_enabled",
                "test_notification",
                "titlebar_action",
                "show_titlebar_menu",
            ]),
        ))
        .expect("Failed to build Tauri resources");
    }
}
