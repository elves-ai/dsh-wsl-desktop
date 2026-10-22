//! Update policy shared by the Windows adapter and platform-independent tests.
use semver::Version;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use url::Url;

#[derive(Clone, Debug, Serialize)]
pub struct UpdateSnapshot {
    pub current_version: String,
    pub phase: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub message: String,
    pub busy: bool,
}
impl UpdateSnapshot {
    pub fn new(version: &str) -> Self {
        Self {
            current_version: version.into(),
            phase: "idle".into(),
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            message: "仅更新 Windows 启动器，不升级或停止 WSL 服务。".into(),
            busy: false,
        }
    }
    pub fn progress(&mut self, chunk: usize, total: Option<u64>) {
        self.downloaded = self.downloaded.saturating_add(chunk as u64);
        self.total = total.filter(|n| *n > 0);
    }
}

/// An operation lease is released on errors and cancellation as well as success.
#[derive(Default)]
pub struct UpdateGate(AtomicBool);
impl UpdateGate {
    pub fn enter(&self) -> Option<UpdateLease<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(UpdateLease(self))
    }
}
pub struct UpdateLease<'a>(&'a UpdateGate);
impl Drop for UpdateLease<'_> {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::SeqCst);
    }
}

/// No frontend-provided URL, alternate host, prerelease or downgrade can be installed.
pub fn validate_download(current: &str, version: &str, url: &Url) -> Result<(), String> {
    let current = Version::parse(current).map_err(|_| "当前版本信息无效。")?;
    let next = Version::parse(version).map_err(|_| "更新版本信息无效。")?;
    if next <= current
        || !next.pre.is_empty()
        || !next.build.is_empty()
        || next.to_string() != version
    {
        return Err("更新必须是更高的正式版本。".into());
    }
    let expected = format!("https://github.com/elves-ai/dsh-wsl-desktop/releases/download/v{version}/dsh-wsl-desktop_{version}_x64-setup.exe");
    if url.as_str() != expected {
        return Err("更新包地址不属于此项目的正式发布。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(version: &str) -> Url {
        Url::parse(&format!("https://github.com/elves-ai/dsh-wsl-desktop/releases/download/v{version}/dsh-wsl-desktop_{version}_x64-setup.exe")).unwrap()
    }
    #[test]
    fn accepts_only_newer_stable_project_installer() {
        assert!(validate_download("0.1.0", "0.2.0", &url("0.2.0")).is_ok());
        for version in [
            "0.1.0",
            "0.0.9",
            "0.2.0-beta.1",
            "0.2.0+build",
            "v0.2.0",
            "0.02.0",
            "../../bad",
        ] {
            assert!(
                validate_download("0.1.0", version, &url("0.2.0")).is_err(),
                "{version}"
            );
        }
        for bad in [
            "http://github.com/elves-ai/dsh-wsl-desktop/releases/download/v0.2.0/dsh-wsl-desktop_0.2.0_x64-setup.exe",
            "https://github.com.evil.test/elves-ai/dsh-wsl-desktop/releases/download/v0.2.0/dsh-wsl-desktop_0.2.0_x64-setup.exe",
            "https://github.com/another/repo/releases/download/v0.2.0/dsh-wsl-desktop_0.2.0_x64-setup.exe",
            "https://github.com/elves-ai/dsh-wsl-desktop/releases/download/v0.2.0/dsh-wsl-desktop.exe",
        ] { assert!(validate_download("0.1.0", "0.2.0", &Url::parse(bad).unwrap()).is_err()); }
        for suffix in ["?token=secret", "#fragment"] {
            let bad = Url::parse(&(url("0.2.0").to_string() + suffix)).unwrap();
            assert!(validate_download("0.1.0", "0.2.0", &bad).is_err());
        }
        assert!(validate_download("0.1.0", "0.2.0", &url("0.3.0")).is_err());
    }
    #[test]
    fn gate_prevents_overlap_and_releases_on_early_return() {
        let gate = UpdateGate::default();
        let lease = gate.enter().unwrap();
        assert!(gate.enter().is_none());
        drop(lease);
        assert!(gate.enter().is_some());
        fn cancelled(gate: &UpdateGate) -> Result<(), ()> {
            let _lease = gate.enter().unwrap();
            Err(())
        }
        assert!(cancelled(&gate).is_err());
        assert!(gate.enter().is_some());
    }
    #[test]
    fn progress_supports_unknown_size_and_saturates() {
        let mut snapshot = UpdateSnapshot::new("0.1.0");
        snapshot.progress(10, Some(0));
        assert_eq!(snapshot.total, None);
        snapshot.progress(20, Some(100));
        assert_eq!(snapshot.downloaded, 30);
        assert_eq!(snapshot.total, Some(100));
        snapshot.downloaded = u64::MAX;
        snapshot.progress(1, None);
        assert_eq!(snapshot.downloaded, u64::MAX);
    }
}
