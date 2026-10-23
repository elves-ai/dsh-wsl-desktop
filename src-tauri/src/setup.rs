//! First-run setup; discovery is read-only, completion is an explicit local IPC.
use crate::{
    config::{self, Config},
    environment::{self, NativeRunner, Runner},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

pub const MANAGER_VERSION: &str = "1.0.0";
const MANAGER: &str = include_str!("../helpers/manager.py");
const HELPER: &str = include_str!("../helpers/setup_environment.py");

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetupRequest {
    pub distribution: String,
    pub linux_user: String,
    pub repository: String,
    pub node: String,
    pub port: u16,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub linux_user: String,
    pub home: String,
    pub node: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Installed {
    linux_user: String,
    linux_launcher: String,
    linux_config: String,
    manager_version: String,
}
fn name(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 4096
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}
fn path(value: &str) -> bool {
    name(value) && value.starts_with('/') && !value.starts_with("//") && !value.contains("://")
}
impl SetupRequest {
    fn validate(&self) -> Result<(), String> {
        if !name(&self.distribution) || !name(&self.linux_user) {
            return Err("请选择有效的 WSL 发行版和 Linux 用户。".into());
        }
        if !path(&self.repository) || !path(&self.node) {
            return Err("Harness 目录和 Node 必须填写 WSL 内的绝对路径。".into());
        }
        if self.port == 0 {
            return Err("端口必须在 1–65535 范围内。".into());
        }
        Ok(())
    }
}
fn failure(code: &str) -> String {
    match code {
        "user" => "无法确认 Linux 用户或其家目录权限，请检查用户后重试。",
        "python" => "所选发行版需要 /usr/bin/python3，版本不低于 3.9；请手动准备后重试。",
        "launcher" => "缺少系统 ss 命令，请在所选发行版中准备 iproute2 后重试。",
        "pidfd" => "内置管理器需要支持 pidfd 的 Linux 内核及 Python；请使用可用的 WSL 2 环境后重试，不会回退为不安全的 PID 停止。",
        "repository" => "目录不是可读的 Harness 源码根目录，请检查项目路径。",
        "node" => "Node 路径不可执行或不满足项目版本要求；请指定正确的 WSL Node 绝对路径。",
        "dependencies" => "Harness 尚未准备好 tsx/esm 依赖，请在项目中手动安装依赖后重试。",
        "web_assets" => "Harness 的 Web 构建产物缺失或不完整，请手动完成构建后重试。",
        "port" => "端口必须在 1–65535 范围内。",
        "port_busy" => "所选端口已有服务监听；不会接管或停止它，请改用其他端口后重试。",
        "conflict" => "部署位置存在内容不同或权限异常的文件；未覆盖，请检查桌面管理器目录。",
        "storage" => "WSL 桌面管理器目录不可安全写入，请检查目录权限或符号链接。",
        _ => "首次配置未完成，请检查 WSL 用户、Python、目录写入权限及服务状态后重试；未启动或停止任何服务。",
    }.into()
}
fn distribution_list(runner: &mut impl Runner) -> Result<Vec<String>, String> {
    let output = runner
        .run(
            &["--list".into(), "--quiet".into()],
            Duration::from_secs(10),
        )
        .map_err(|_| "无法读取 WSL 发行版，请确认 Windows WSL 已安装并可运行。")?;
    if !output.success {
        return Err("WSL 无法列出发行版，请检查其运行状态。".into());
    }
    let names = environment::distributions(&output.stdout).map_err(|_| "WSL 发行版列表无效。")?;
    if names.iter().any(|value| !name(value)) {
        return Err("WSL 发行版列表无效。".into());
    }
    Ok(names)
}
pub fn distributions() -> Result<Vec<String>, String> {
    distribution_list(&mut NativeRunner)
}

fn invoke(
    runner: &mut impl Runner,
    distribution: &str,
    user: &str,
    payload: Value,
) -> Result<Value, String> {
    if !name(distribution) || (!user.is_empty() && !name(user)) {
        return Err("发行版或 Linux 用户无效。".into());
    }
    let mut args = vec!["--distribution".into(), distribution.into()];
    if !user.is_empty() {
        args.extend(["--user".into(), user.into()]);
    }
    args.extend([
        "--exec".into(),
        "/usr/bin/python3".into(),
        "-I".into(),
        "-c".into(),
        HELPER.into(),
    ]);
    let input = serde_json::to_vec(&payload).map_err(|_| failure("payload"))?;
    if input.len() > 256 * 1024 {
        return Err(failure("payload"));
    }
    let output = runner.run_input(&args, input, Duration::from_secs(30))
        .map_err(|_| "WSL 初始化请求未完成；请检查发行版、用户及 Python 3.9+ 后重试。Linux 文件若已部署可安全复用，未覆盖 Windows 配置。")?;
    if !output.success {
        return Err(failure("python"));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| failure("response"))?;
    if let Some(code) = value.get("error").and_then(Value::as_str) {
        return Err(failure(code));
    }
    Ok(value)
}
pub fn identity(distribution: &str, user: &str) -> Result<Identity, String> {
    identity_with(&mut NativeRunner, distribution, user)
}
fn identity_with(
    runner: &mut impl Runner,
    distribution: &str,
    user: &str,
) -> Result<Identity, String> {
    let value = invoke(runner, distribution, user, json!({"action":"identity"}))?;
    let identity: Identity = serde_json::from_value(value).map_err(|_| failure("response"))?;
    if !name(&identity.linux_user)
        || !path(&identity.home)
        || (!identity.node.is_empty() && !path(&identity.node))
        || (!user.is_empty() && identity.linux_user != user)
    {
        return Err(failure("user"));
    }
    Ok(identity)
}
pub fn complete(directory: &Path, legacy: &Path, request: &SetupRequest) -> Result<Config, String> {
    complete_with(&mut NativeRunner, directory, legacy, request)
}
fn complete_with(
    runner: &mut impl Runner,
    directory: &Path,
    legacy: &Path,
    request: &SetupRequest,
) -> Result<Config, String> {
    request.validate()?;
    if !config::needs_setup(directory, legacy) {
        return Err("已有启动配置或旧配置；为防止覆盖，请重新检测并修复已有配置。".into());
    }
    if !distribution_list(runner)?
        .iter()
        .any(|value| value.eq_ignore_ascii_case(&request.distribution))
    {
        return Err("所选 WSL 发行版已不存在，请重新检测发行版。".into());
    }
    let value = invoke(
        runner,
        &request.distribution,
        &request.linux_user,
        json!({
            "action":"install", "request":request, "checks":environment::HELPER, "manager":MANAGER,
        }),
    )?;
    let installed: Installed = serde_json::from_value(value).map_err(|_| failure("response"))?;
    if installed.manager_version != MANAGER_VERSION
        || installed.linux_user != request.linux_user
        || !path(&installed.linux_launcher)
        || !path(&installed.linux_config)
    {
        return Err(failure("response"));
    }
    let config = Config {
        distribution: request.distribution.clone(),
        linux_user: request.linux_user.clone(),
        linux_launcher: installed.linux_launcher,
        linux_config: installed.linux_config,
        port: request.port,
        startup_timeout_seconds: 120,
        probe_timeout_seconds: 15,
        stop_timeout_seconds: 45,
        window_width: 1200,
        window_height: 800,
    };
    if !config::needs_setup(directory, legacy) {
        return Err("配置已被其他操作创建，未覆盖；请重新检测。".into());
    }
    config::save_new(directory, &config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::{ProbeError, ProbeOutput};
    use std::collections::VecDeque;
    struct Fake {
        replies: VecDeque<Value>,
        calls: Vec<(Vec<String>, Option<Value>)>,
    }
    impl Runner for Fake {
        fn run(&mut self, args: &[String], _: Duration) -> Result<ProbeOutput, ProbeError> {
            self.calls.push((args.to_vec(), None));
            Ok(ProbeOutput {
                success: true,
                stdout: b"Ubuntu\r\n".to_vec(),
            })
        }
        fn run_input(
            &mut self,
            args: &[String],
            input: Vec<u8>,
            _: Duration,
        ) -> Result<ProbeOutput, ProbeError> {
            self.calls
                .push((args.to_vec(), Some(serde_json::from_slice(&input).unwrap())));
            Ok(ProbeOutput {
                success: true,
                stdout: serde_json::to_vec(&self.replies.pop_front().unwrap()).unwrap(),
            })
        }
    }
    fn fake(value: Value) -> Fake {
        Fake {
            replies: VecDeque::from([value]),
            calls: vec![],
        }
    }
    #[test]
    fn default_user_discovery_is_read_only_and_does_not_use_shell() {
        let mut f = fake(json!({"linux_user":"test", "home":"/home/test", "node":""}));
        assert_eq!(
            identity_with(&mut f, "Ubuntu", "").unwrap().linux_user,
            "test"
        );
        assert!(!f.calls[0]
            .0
            .iter()
            .any(|arg| arg == "--user" || arg == "bash"));
        assert_eq!(
            f.calls[0].1.as_ref().unwrap(),
            &json!({"action":"identity"})
        );
    }
    #[test]
    fn invalid_inputs_and_identity_mismatch_fail_closed() {
        let mut f =
            fake(json!({"linux_user":"other", "home":"/home/other", "node":"/usr/bin/node"}));
        assert!(identity_with(&mut f, "--shutdown", "test").is_err());
        assert!(f.calls.is_empty());
        assert!(identity_with(&mut f, "Ubuntu", "test").is_err());
        let mut f = fake(json!({"error":"unexpected token=private-value"}));
        let error = identity_with(&mut f, "Ubuntu", "test").err().unwrap();
        assert!(!error.contains("private-value"));
    }
    #[test]
    fn completion_commits_last_and_never_overwrites_existing_configuration() {
        let root = std::env::temp_dir().join(format!(
            "dsh-setup-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let directory = root.join("new");
        let legacy = root.join("legacy.json");
        let request = SetupRequest {
            distribution: "Ubuntu".into(),
            linux_user: "test".into(),
            repository: "/home/test/Harness source".into(),
            node: "/home/test/.nvm/node".into(),
            port: 3099,
        };
        let mut f = fake(
            json!({"linux_user":"test", "linux_launcher":"/home/test/manager-1.0.0.py",
            "linux_config":"/home/test/config.json", "manager_version":"1.0.0"}),
        );
        let c = complete_with(&mut f, &directory, &legacy, &request).unwrap();
        assert_eq!(c.port, 3099);
        let bytes = std::fs::read(directory.join("config.json")).unwrap();
        assert_eq!(config::load(&directory, &legacy).unwrap().config.port, 3099);
        let payload = f.calls[1].1.as_ref().unwrap();
        assert_eq!(payload["action"], "install");
        assert!(payload["manager"]
            .as_str()
            .unwrap()
            .contains(MANAGER_VERSION));
        // Bundled manager/check sources travel over stdin, not argv.
        assert!(!f.calls[1]
            .0
            .iter()
            .any(|arg| arg == MANAGER || arg == environment::HELPER));
        assert!(
            f.calls[1]
                .0
                .iter()
                .map(|arg| arg.encode_utf16().count() + 3)
                .sum::<usize>()
                < 30_000
        );
        assert!(complete_with(&mut f, &directory, &legacy, &request).is_err());
        assert_eq!(f.calls.len(), 2);
        assert_eq!(std::fs::read(directory.join("config.json")).unwrap(), bytes);
        assert!(config::save_new(&directory, &c).is_err());
        assert_eq!(std::fs::read(directory.join("config.json")).unwrap(), bytes);
        assert!(
            root.is_absolute()
                && root
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("dsh-setup-test-")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_existing_config_does_not_trigger_onboarding() {
        let root = std::env::temp_dir().join(format!("dsh-setup-invalid-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let legacy = root.join("legacy.json");
        assert!(config::needs_setup(&root, &legacy));
        std::fs::write(&legacy, b"invalid JSON").unwrap();
        assert!(!config::needs_setup(&root, &legacy));
        assert!(config::load(&root, &legacy).is_err());
        assert!(!root.join("config.json").exists());
        assert!(
            root.is_absolute()
                && root
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("dsh-setup-invalid-")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
