use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Config {
    pub distribution: String,
    pub linux_user: String,
    pub linux_launcher: String,
    pub linux_config: String,
    #[serde(default = "startup_timeout")]
    pub startup_timeout_seconds: u64,
    #[serde(default = "probe_timeout")]
    pub probe_timeout_seconds: u64,
    #[serde(default = "stop_timeout")]
    pub stop_timeout_seconds: u64,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "window_width")]
    pub window_width: u32,
    #[serde(default = "window_height")]
    pub window_height: u32,
}
fn startup_timeout() -> u64 {
    120
}
fn probe_timeout() -> u64 {
    15
}
fn stop_timeout() -> u64 {
    45
}
fn default_port() -> u16 {
    3080
}
fn window_width() -> u32 {
    1200
}
fn window_height() -> u32 {
    800
}

pub struct LoadedConfig {
    pub config: Config,
    pub path: PathBuf,
    pub imported: bool,
}
impl Config {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 64 * 1024 {
            return Err("启动配置过大。".into());
        }
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
        let config: Self = serde_json::from_slice(bytes)
            .map_err(|_| "启动配置不是有效的 JSON，或缺少必需字段。")?;
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&self) -> Result<(), String> {
        for (label, value) in [
            ("WSL 发行版", &self.distribution),
            ("Linux 用户", &self.linux_user),
            ("Linux 管理脚本", &self.linux_launcher),
            ("Linux 配置", &self.linux_config),
        ] {
            if value.trim().is_empty()
                || value.len() > 4096
                || value.chars().any(char::is_control)
                || value.starts_with('-')
            {
                return Err(format!("{label} 配置无效。"));
            }
        }
        if !self.linux_launcher.starts_with('/') || !self.linux_config.starts_with('/') {
            return Err("Linux 管理脚本和配置必须是绝对路径。".into());
        }
        if self.port == 0 {
            return Err("端口必须在 1–65535 范围内。".into());
        }
        if !(1..=600).contains(&self.startup_timeout_seconds)
            || !(1..=60).contains(&self.probe_timeout_seconds)
            || !(1..=120).contains(&self.stop_timeout_seconds)
        {
            return Err("启动、查询或停止超时配置超出允许范围。".into());
        }
        if !(480..=4096).contains(&self.window_width) || !(360..=4096).contains(&self.window_height)
        {
            return Err("窗口尺寸配置超出允许范围。".into());
        }
        Ok(())
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn wsl_args(&self, action: &str) -> Result<Vec<String>, String> {
        if !["probe", "run", "stop", "logs"].contains(&action) {
            return Err("不支持的 WSL 操作。".into());
        }
        let mut args = vec![
            "--distribution".into(),
            self.distribution.clone(),
            "--user".into(),
            self.linux_user.clone(),
            "--exec".into(),
            "/usr/bin/python3".into(),
            self.linux_launcher.clone(),
            action.into(),
            "--config".into(),
            self.linux_config.clone(),
        ];
        if action == "stop" {
            args.push("--confirmed".into());
        }
        Ok(args)
    }
}

/// Import only launcher settings, never Chrome profiles, credentials or DSH data.
pub fn load(directory: &Path, legacy: &Path) -> Result<LoadedConfig, String> {
    let path = directory.join("config.json");
    if path.is_file() {
        let data = fs::read(&path).map_err(|_| "无法读取启动器配置。")?;
        return Ok(LoadedConfig {
            config: Config::parse(&data)?,
            path,
            imported: false,
        });
    }
    let data =
        fs::read(legacy).map_err(|_| "没有找到旧启动器配置。请按 README 配置启动器后重试。")?;
    let config = Config::parse(&data)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建启动器配置目录。")?;
    let serialized = serde_json::to_vec_pretty(&config).map_err(|_| "无法序列化启动器配置。")?;
    use std::io::Write;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => file
            .write_all(&serialized)
            .map_err(|_| "无法保存导入配置。")?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return load(directory, legacy),
        Err(_) => return Err("无法保存导入配置。".into()),
    }
    Ok(LoadedConfig {
        config,
        path,
        imported: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Config {
        Config::parse(br#"{"Distribution":"Ubuntu-26.04","LinuxUser":"yangzhe","LinuxLauncher":"/home/yangzhe/.local/share/dsh-windows-launcher/launcher.py","LinuxConfig":"/home/yangzhe/.local/share/dsh-windows-launcher/config.json","BrowserPath":"legacy-only"}"#).unwrap()
    }
    #[test]
    fn imports_existing_configuration_and_defaults() {
        let c = fixture();
        assert_eq!(c.port, 3080);
        assert_eq!(c.window_width, 1200);
        assert_eq!(c.origin(), "http://127.0.0.1:3080");
        assert!(!serde_json::to_string(&c).unwrap().contains("BrowserPath"));
    }
    #[test]
    fn passes_arguments_without_a_shell() {
        let mut c = fixture();
        c.linux_launcher = "/home/test user/a; echo bad.py".into();
        let args = c.wsl_args("probe").unwrap();
        assert_eq!(args[6], c.linux_launcher);
        assert!(!args.iter().any(|s| s == "bash"));
        assert_eq!(c.wsl_args("stop").unwrap().last().unwrap(), "--confirmed");
        assert!(c.wsl_args("shutdown").is_err());
    }
    #[test]
    fn rejects_invalid_config() {
        let mut c = fixture();
        c.port = 0;
        assert!(c.validate().is_err());
        let mut c = fixture();
        c.linux_user = "root\n--shutdown".into();
        assert!(c.validate().is_err());
        let mut c = fixture();
        c.linux_config = "relative".into();
        assert!(c.validate().is_err());
        let mut c = fixture();
        c.startup_timeout_seconds = 0;
        assert!(c.validate().is_err());
    }
    #[test]
    fn imports_once_without_changing_legacy() {
        let root = std::env::temp_dir().join(format!(
            "dsh-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let old = root.join("legacy.json");
        let contents = serde_json::to_vec(&fixture()).unwrap();
        fs::write(&old, &contents).unwrap();
        let new = root.join("new");
        assert!(load(&new, &old).unwrap().imported);
        assert!(!load(&new, &old).unwrap().imported);
        assert_eq!(fs::read(&old).unwrap(), contents);
        // Cleanup only this unique absolute test directory.
        assert!(
            root.is_absolute()
                && root
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("dsh-config-test-")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
