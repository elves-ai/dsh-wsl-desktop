fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_snapshot", "perform_action"]),
        ))
        .expect("Failed to build Tauri resources");
    }
}
