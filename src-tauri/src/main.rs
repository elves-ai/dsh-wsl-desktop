#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(windows)]
    dsh_wsl_desktop::run();
    #[cfg(not(windows))]
    {
        eprintln!("DSH WSL Desktop 是 Windows 原生应用，请在 Windows 构建和运行。");
        std::process::exit(1);
    }
}
