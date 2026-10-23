//! Credential-safe preflight. Inspection never calls the launcher or a service.
//! The only write API is save_repository, for an explicit user save action.
use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const IDS: [&str; 11] = [
    "wsl",
    "config",
    "distribution",
    "user",
    "python",
    "launcher",
    "linux_config",
    "repository",
    "node",
    "dependencies",
    "web_assets",
];
const LINUX_IDS: [&str; 6] = [
    "launcher",
    "linux_config",
    "repository",
    "node",
    "dependencies",
    "web_assets",
];
pub(crate) const HELPER: &str = include_str!("../helpers/check_environment.py");
const MAX_OUTPUT: usize = 64 * 1024;
const SAVE_ERROR: &str = "无法保存项目目录。请确认目标是已有 DSH 项目，Linux 配置是可写的普通 JSON 文件且含有效端口，并检查 WSL 用户权限；服务正在启动或端口仍有监听时请先手动停止。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckItem {
    pub id: String,
    pub label: String,
    pub status: String,
    pub message: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentReport {
    pub checks: Vec<CheckItem>,
    pub repository: Option<String>,
}

// All UI prose is static. Neither command output nor config_error is user-facing.
fn description(id: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    match id {
        "wsl" => (
            "Windows WSL",
            "WSL 可用，已读取发行版列表。",
            "WSL 当前不可用。",
            "请在 Windows 中手动检查 WSL 功能及其运行状态。",
        ),
        "config" => (
            "桌面启动配置",
            "桌面启动配置有效。",
            "桌面启动配置缺失或无效。",
            "请先打开并手动修正桌面启动配置，再重新检测。",
        ),
        "distribution" => (
            "WSL 发行版",
            "配置指定的 WSL 发行版已存在。",
            "找不到配置指定的 WSL 发行版。",
            "请手动检查已安装发行版，并修正 Distribution 配置。",
        ),
        "user" => (
            "Linux 用户",
            "配置指定的 Linux 用户可用。",
            "无法以配置指定的 Linux 用户执行检测。",
            "请手动检查 LinuxUser 以及该用户的访问权限。",
        ),
        "python" => (
            "系统 Python",
            "/usr/bin/python3 可用，版本不低于 3.9。",
            "/usr/bin/python3 不存在、不可用或版本低于 3.9。",
            "请在所选发行版中手动准备 Python 3.9 或更新版本；检测不会安装。",
        ),
        "launcher" => (
            "Linux 管理脚本",
            "管理脚本可读、语法有效，ss 命令可用。",
            "管理脚本缺失、不可读、语法无效或缺少 ss 命令。",
            "请手动检查已有管理脚本及系统 ss 命令；检测不会执行或创建脚本。",
        ),
        "linux_config" => (
            "Linux 配置",
            "Linux 配置有效，端口与桌面一致。",
            "Linux 配置缺失、格式无效或端口不一致。",
            "请手动检查 JSON 的 repository、node、state_directory、port。",
        ),
        "repository" => (
            "DSH 项目目录",
            "DSH 项目入口和项目清单有效。",
            "目录不是有效的 DSH 项目，或入口不可读。",
            "请选择已有 DSH 项目的 WSL 绝对路径。",
        ),
        "node" => (
            "Node.js",
            "Node.js 可执行且满足项目版本要求。",
            "配置指定的 Node.js 不可执行、版本不兼容或版本要求无效。",
            "请手动检查 Node 路径和项目 engines.node；检测不会安装。",
        ),
        "dependencies" => (
            "已安装依赖",
            "已安装的 tsx/esm 入口可解析且可读。",
            "缺少可用的 tsx/esm 依赖入口。",
            "请在项目中手动准备依赖；检测不会安装或导入依赖。",
        ),
        "web_assets" => (
            "Web 构建产物",
            "Web 页面及其本地构建资源可读。",
            "Web 构建产物缺失、不完整或不可读。",
            "请手动构建项目的 Web 产物；检测不会执行构建。",
        ),
        _ => unreachable!("fixed check identifier"),
    }
}

fn check(id: &str, status: &str) -> CheckItem {
    let (label, passed, error, hint) = description(id);
    CheckItem {
        id: id.into(),
        label: label.into(),
        status: status.into(),
        message: match status {
            "passed" => passed,
            "error" => error,
            "pending" => "等待环境检测。",
            _ => "上游检查未通过，暂不检测。",
        }
        .into(),
        hint: if status == "error" { hint } else { "" }.into(),
    }
}

impl EnvironmentReport {
    pub fn passed(&self) -> bool {
        self.checks.len() == IDS.len()
            && IDS.iter().all(|id| {
                self.checks
                    .iter()
                    .filter(|item| item.id == *id && item.status == "passed")
                    .count()
                    == 1
            })
    }

    pub fn pending() -> Self {
        Self {
            checks: IDS.iter().map(|id| check(id, "pending")).collect(),
            repository: None,
        }
    }

    fn skipped() -> Self {
        Self {
            checks: IDS.iter().map(|id| check(id, "skipped")).collect(),
            repository: None,
        }
    }

    fn set(&mut self, id: &str, status: &str) {
        if let Some(item) = self.checks.iter_mut().find(|item| item.id == id) {
            *item = check(id, status);
        }
    }

    fn failure(&mut self, id: &str, message: &'static str, hint: &'static str) {
        self.set(id, "error");
        if let Some(item) = self.checks.iter_mut().find(|item| item.id == id) {
            item.message = message.into();
            item.hint = hint.into();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeError {
    Missing,
    Unavailable,
    Timeout,
    TooLarge,
    Unsupported,
}

pub(crate) struct ProbeOutput {
    pub(crate) success: bool,
    pub(crate) stdout: Vec<u8>,
}

pub(crate) trait Runner {
    fn run(&mut self, args: &[String], timeout: Duration) -> Result<ProbeOutput, ProbeError>;
    fn run_input(
        &mut self,
        args: &[String],
        input: Vec<u8>,
        timeout: Duration,
    ) -> Result<ProbeOutput, ProbeError> {
        let _ = (args, input, timeout);
        Err(ProbeError::Unsupported)
    }
}

pub(crate) struct NativeRunner;
impl Runner for NativeRunner {
    fn run(&mut self, args: &[String], timeout: Duration) -> Result<ProbeOutput, ProbeError> {
        NativeRunner::run_input(self, args, None, timeout)
    }
    fn run_input(
        &mut self,
        args: &[String],
        input: Vec<u8>,
        timeout: Duration,
    ) -> Result<ProbeOutput, ProbeError> {
        NativeRunner::run_input(self, args, Some(input), timeout)
    }
}
impl NativeRunner {
    pub(crate) fn run_input(
        &mut self,
        args: &[String],
        input: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<ProbeOutput, ProbeError> {
        #[cfg(windows)]
        {
            use std::{
                io::{Read, Write},
                os::windows::process::CommandExt,
                path::PathBuf,
                process::{Command, Stdio},
                sync::mpsc,
                thread,
                time::Instant,
            };
            let root = std::env::var_os("SystemRoot").ok_or(ProbeError::Unavailable)?;
            let executable = PathBuf::from(root).join("System32").join("wsl.exe");
            if !executable.is_absolute() {
                return Err(ProbeError::Unavailable);
            }
            let mut child = Command::new(executable)
                .args(args)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .stdin(if input.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        ProbeError::Missing
                    } else {
                        ProbeError::Unavailable
                    }
                })?;
            if let Some(input) = input {
                let mut stdin = child.stdin.take().ok_or(ProbeError::Unavailable)?;
                // Feed the bundled sources over stdin, not the Windows 32K command line.
                // A stalled WSL is still bounded by the same process deadline below.
                thread::spawn(move || {
                    let _ = stdin.write_all(&input);
                });
            }
            let stdout = child.stdout.take().ok_or(ProbeError::Unavailable)?;
            let (sender, receiver) = mpsc::sync_channel(1);
            // Reading is capped even when a misbehaving process writes indefinitely.
            // Never join a blocked pipe reader after the deadline.
            thread::spawn(move || {
                let mut bytes = Vec::new();
                let result = stdout.take((MAX_OUTPUT + 1) as u64).read_to_end(&mut bytes);
                let _ = sender.send(result.map(|_| bytes));
            });
            let deadline = Instant::now() + timeout;
            let mut bytes = None;
            let mut exit = None;
            loop {
                if bytes.is_none() {
                    match receiver.try_recv() {
                        Ok(Ok(output)) if output.len() <= MAX_OUTPUT => bytes = Some(output),
                        Ok(Ok(_)) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(ProbeError::TooLarge);
                        }
                        Ok(Err(_)) | Err(mpsc::TryRecvError::Disconnected) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(ProbeError::Unavailable);
                        }
                        Err(mpsc::TryRecvError::Empty) => {}
                    }
                }
                if exit.is_none() {
                    match child.try_wait() {
                        Ok(status) => exit = status,
                        Err(_) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(ProbeError::Unavailable);
                        }
                    }
                }
                if let (Some(output), Some(status)) = (bytes.as_ref(), exit.as_ref()) {
                    return Ok(ProbeOutput {
                        success: status.success(),
                        stdout: output.clone(),
                    });
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProbeError::Timeout);
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (args, input, timeout);
            Err(ProbeError::Unsupported)
        }
    }
}

/// WSL --list --quiet commonly emits UTF-16LE, with or without a BOM.
pub(crate) fn distributions(bytes: &[u8]) -> Result<Vec<String>, ProbeError> {
    if bytes.len() > MAX_OUTPUT {
        return Err(ProbeError::TooLarge);
    }
    let utf16 =
        bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) || bytes.contains(&0);
    let text = if utf16 {
        let big_endian = bytes.starts_with(&[0xfe, 0xff]);
        let data = if bytes.starts_with(&[0xff, 0xfe]) || big_endian {
            &bytes[2..]
        } else {
            bytes
        };
        if data.len() % 2 != 0 {
            return Err(ProbeError::Unavailable);
        }
        let words: Vec<u16> = data
            .chunks_exact(2)
            .map(|chunk| {
                if big_endian {
                    u16::from_be_bytes([chunk[0], chunk[1]])
                } else {
                    u16::from_le_bytes([chunk[0], chunk[1]])
                }
            })
            .collect();
        String::from_utf16(&words).map_err(|_| ProbeError::Unavailable)?
    } else {
        std::str::from_utf8(bytes)
            .map_err(|_| ProbeError::Unavailable)?
            .to_owned()
    };
    let mut names = Vec::new();
    for line in text.trim_matches(['\u{feff}', '\0']).lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if name.len() > 4096 || name.chars().any(char::is_control) || names.len() >= 128 {
            return Err(ProbeError::Unavailable);
        }
        names.push(name.to_owned());
    }
    Ok(names)
}

fn linux_args(config: &Config, program: &str, args: &[&str]) -> Vec<String> {
    let mut result = vec![
        "--distribution".into(),
        config.distribution.clone(),
        "--user".into(),
        config.linux_user.clone(),
        "--exec".into(),
        program.into(),
    ];
    result.extend(args.iter().map(|arg| (*arg).to_owned()));
    result
}

fn successful(output: Result<ProbeOutput, ProbeError>, expected: &[u8]) -> bool {
    matches!(output, Ok(ref result) if result.success && result.stdout == expected)
}

#[derive(Deserialize)]
struct LinuxCheck {
    id: String,
    status: String,
}
#[derive(Deserialize)]
struct LinuxReport {
    checks: Vec<LinuxCheck>,
    repository: Option<String>,
}

fn safe_repository(value: &str) -> bool {
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || value.contains("://")
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    // A filesystem path is never a URL or a credential assignment.
    ![
        "token",
        "api_key",
        "api-key",
        "apikey",
        "password",
        "secret",
        "authorization",
    ]
    .iter()
    .any(|key| {
        lower.match_indices(*key).any(|(index, _)| {
            lower[index + key.len()..]
                .trim_start()
                .starts_with(['=', ':'])
        })
    }) && !value
        .chars()
        .any(|c| matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}'))
}

fn parse_linux(bytes: &[u8]) -> Result<LinuxReport, ProbeError> {
    if bytes.len() > MAX_OUTPUT {
        return Err(ProbeError::TooLarge);
    }
    let mut report: LinuxReport =
        serde_json::from_slice(bytes).map_err(|_| ProbeError::Unavailable)?;
    if report.checks.len() != LINUX_IDS.len()
        || !LINUX_IDS.iter().all(|id| {
            report
                .checks
                .iter()
                .filter(|item| {
                    item.id == *id && matches!(item.status.as_str(), "passed" | "error" | "skipped")
                })
                .count()
                == 1
        })
    {
        return Err(ProbeError::Unavailable);
    }
    report.repository = report.repository.filter(|value| safe_repository(value));
    Ok(report)
}

/// Inspect WSL independently of the desktop config. config_error is never echoed.
pub fn inspect(config: Option<&Config>, config_error: Option<&str>) -> EnvironmentReport {
    inspect_with(config, config_error, &mut NativeRunner)
}

fn inspect_with(
    config: Option<&Config>,
    config_error: Option<&str>,
    runner: &mut impl Runner,
) -> EnvironmentReport {
    let mut report = EnvironmentReport::skipped();
    let config = config.filter(|config| config_error.is_none() && config.validate().is_ok());
    report.set("config", if config.is_some() { "passed" } else { "error" });
    let names = match runner.run(
        &["--list".into(), "--quiet".into()],
        Duration::from_secs(10),
    ) {
        Ok(output) if output.success => distributions(&output.stdout),
        Ok(_) => Err(ProbeError::Unavailable),
        Err(error) => Err(error),
    };
    let names = match names {
        Ok(names) => {
            report.set("wsl", "passed");
            names
        }
        Err(ProbeError::Missing) => {
            report.failure(
                "wsl",
                "未找到 Windows WSL 程序，可能尚未安装 WSL。",
                "请先在 Windows 中手动安装或启用 WSL，然后重新检测。",
            );
            return report;
        }
        Err(ProbeError::Unsupported) => {
            report.failure(
                "wsl",
                "此环境检测仅支持 Windows WSL。",
                "请在 Windows 桌面应用中进行实际环境检测。",
            );
            return report;
        }
        Err(ProbeError::Timeout) => {
            report.failure(
                "wsl",
                "读取 WSL 发行版列表超时。",
                "请手动检查 Windows WSL 状态，然后重新检测。",
            );
            return report;
        }
        Err(_) => {
            report.set("wsl", "error");
            return report;
        }
    };
    let Some(config) = config else {
        return report;
    };
    if !names
        .iter()
        .any(|name| name.eq_ignore_ascii_case(&config.distribution))
    {
        report.set("distribution", "error");
        return report;
    }
    report.set("distribution", "passed");
    let timeout = Duration::from_secs(config.probe_timeout_seconds.clamp(1, 60));
    let user = runner.run(&linux_args(config, "/usr/bin/id", &["-un"]), timeout);
    let user_ok = match user {
        Ok(output) if output.success => std::str::from_utf8(&output.stdout)
            .map(|name| name.trim_end_matches(['\r', '\n']) == config.linux_user)
            .unwrap_or(false),
        _ => false,
    };
    report.set("user", if user_ok { "passed" } else { "error" });
    if !user_ok {
        return report;
    }
    let python = runner.run(
        &linux_args(
            config,
            "/usr/bin/python3",
            &["-I", "-c", "import sys;sys.exit(1) if sys.version_info < (3,9) else sys.stdout.write('dsh-python-ok')"],
        ),
        timeout,
    );
    let python_ok = successful(python, b"dsh-python-ok");
    report.set("python", if python_ok { "passed" } else { "error" });
    if !python_ok {
        return report;
    }
    let port = config.port.to_string();
    let args = linux_args(
        config,
        "/usr/bin/python3",
        &[
            "-I",
            "-c",
            HELPER,
            "inspect",
            &config.linux_launcher,
            &config.linux_config,
            &port,
        ],
    );
    // Two separately bounded Node probes may take up to eight seconds.
    let output = runner.run(&args, timeout.max(Duration::from_secs(12)));
    let linux = match output {
        Ok(output) if output.success => parse_linux(&output.stdout),
        _ => Err(ProbeError::Unavailable),
    };
    match linux {
        Ok(linux) => {
            for item in linux.checks {
                report.set(&item.id, &item.status);
            }
            report.repository = linux.repository;
        }
        Err(_) => report.failure(
            "launcher",
            "Linux 环境检测未能完成或返回了无效结果。",
            "请检查 WSL 和文件读取权限后重试；检测不会执行管理脚本。",
        ),
    }
    report
}

/// Explicit user save only. It does not run the launcher, install, build or start anything.
pub fn save_repository(config: &Config, repository: &str) -> Result<(), String> {
    save_with(config, repository, &mut NativeRunner)
}

fn save_with(config: &Config, repository: &str, runner: &mut impl Runner) -> Result<(), String> {
    config
        .validate()
        .map_err(|_| "桌面启动配置无效，请先修正配置。".to_owned())?;
    if !safe_repository(repository) {
        return Err("项目目录必须是有效的 WSL 绝对路径，不能包含控制字符或认证信息。".into());
    }
    let args = linux_args(
        config,
        "/usr/bin/python3",
        &["-I", "-c", HELPER, "save", &config.linux_config, repository],
    );
    let output = runner
        .run(
            &args,
            Duration::from_secs(config.probe_timeout_seconds.clamp(1, 60)),
        )
        .map_err(|_| SAVE_ERROR.to_owned())?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Saved {
        saved: bool,
    }
    let saved =
        serde_json::from_slice::<Saved>(&output.stdout).map_err(|_| SAVE_ERROR.to_owned())?;
    if output.success && saved.saved {
        Ok(())
    } else {
        Err(SAVE_ERROR.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct FakeRunner {
        replies: VecDeque<Result<ProbeOutput, ProbeError>>,
        calls: Vec<Vec<String>>,
    }
    impl Runner for FakeRunner {
        fn run(&mut self, args: &[String], _: Duration) -> Result<ProbeOutput, ProbeError> {
            self.calls.push(args.to_vec());
            self.replies
                .pop_front()
                .expect("unexpected real/extra command")
        }
    }
    fn output(bytes: &[u8]) -> Result<ProbeOutput, ProbeError> {
        Ok(ProbeOutput {
            success: true,
            stdout: bytes.to_vec(),
        })
    }
    fn fake(replies: Vec<Result<ProbeOutput, ProbeError>>) -> FakeRunner {
        FakeRunner {
            replies: replies.into(),
            calls: Vec::new(),
        }
    }
    fn config() -> Config {
        Config::parse(br#"{"Distribution":"Ubuntu-24.04","LinuxUser":"tester","LinuxLauncher":"/home/tester/launcher.py","LinuxConfig":"/home/tester/config.json"}"#).unwrap()
    }
    fn state<'a>(report: &'a EnvironmentReport, id: &str) -> &'a str {
        &report
            .checks
            .iter()
            .find(|check| check.id == id)
            .unwrap()
            .status
    }
    fn linux_json(status: &str, repository: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"checks": LINUX_IDS.iter().map(|id| {
            serde_json::json!({"id": id, "status": status, "message":"token=DO-NOT-ECHO", "hint":"DO-NOT-ECHO"})
        }).collect::<Vec<_>>(), "repository":repository})).unwrap()
    }

    #[test]
    fn utf16_wsl_list_bom_and_no_bom_and_utf8() {
        let text = "Ubuntu-24.04\r\n测试发行版\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        for data in [
            bytes.clone(),
            [vec![0xff, 0xfe], bytes].concat(),
            text.as_bytes().to_vec(),
        ] {
            assert_eq!(
                distributions(&data).unwrap(),
                vec!["Ubuntu-24.04", "测试发行版"]
            );
        }
        let big: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        assert_eq!(
            distributions(&[vec![0xfe, 0xff], big].concat())
                .unwrap()
                .len(),
            2
        );
        assert!(distributions(&[0xff, 0xfe, 0x00]).is_err());
        assert!(distributions(&vec![b'x'; MAX_OUTPUT + 1]).is_err());
    }

    #[test]
    fn missing_config_still_checks_wsl_without_exposing_error() {
        let mut runner = fake(vec![output(b"Ubuntu-24.04\n")]);
        let report = inspect_with(None, Some("token=DO-NOT-ECHO"), &mut runner);
        assert_eq!(state(&report, "wsl"), "passed");
        assert_eq!(state(&report, "config"), "error");
        assert_eq!(state(&report, "distribution"), "skipped");
        assert_eq!(runner.calls, vec![vec!["--list", "--quiet"]]);
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("DO-NOT-ECHO"));
    }

    #[test]
    fn wsl_missing_unavailable_and_timeout_have_static_distinct_messages() {
        let cfg = config();
        let mut messages = Vec::new();
        for error in [
            ProbeError::Missing,
            ProbeError::Unavailable,
            ProbeError::Timeout,
        ] {
            let mut runner = fake(vec![Err(error)]);
            let report = inspect_with(Some(&cfg), None, &mut runner);
            assert_eq!(state(&report, "config"), "passed");
            assert_eq!(state(&report, "wsl"), "error");
            assert_eq!(state(&report, "distribution"), "skipped");
            messages.push(report.checks[0].message.clone());
        }
        assert_ne!(messages[0], messages[1]);
        assert_ne!(messages[1], messages[2]);
    }

    #[test]
    fn absent_distribution_or_user_does_not_turn_all_rows_red() {
        let cfg = config();
        let mut runner = fake(vec![output(b"Debian\n")]);
        let report = inspect_with(Some(&cfg), None, &mut runner);
        assert_eq!(state(&report, "distribution"), "error");
        assert_eq!(state(&report, "user"), "skipped");
        let mut runner = fake(vec![
            output(b"Ubuntu-24.04\n"),
            Err(ProbeError::Unavailable),
        ]);
        let report = inspect_with(Some(&cfg), None, &mut runner);
        assert_eq!(state(&report, "user"), "error");
        assert_eq!(state(&report, "python"), "skipped");
        assert_eq!(state(&report, "launcher"), "skipped");
    }

    #[test]
    fn python_failure_skips_linux_checks() {
        let cfg = config();
        let mut runner = fake(vec![
            output(b"Ubuntu-24.04\n"),
            output(b"tester\n"),
            Err(ProbeError::Unavailable),
        ]);
        let report = inspect_with(Some(&cfg), None, &mut runner);
        assert_eq!(state(&report, "python"), "error");
        assert_eq!(state(&report, "launcher"), "skipped");
        assert_eq!(runner.calls[2][5], "/usr/bin/python3");
    }

    #[test]
    fn success_requires_all_fixed_checks_and_ignores_untrusted_prose() {
        let cfg = config();
        let mut runner = fake(vec![
            output(b"Ubuntu-24.04\n"),
            output(b"tester\n"),
            output(b"dsh-python-ok"),
            output(&linux_json("passed", "/home/tester/DSH with spaces")),
        ]);
        let report = inspect_with(Some(&cfg), None, &mut runner);
        assert!(report.passed());
        assert_eq!(
            report.repository.as_deref(),
            Some("/home/tester/DSH with spaces")
        );
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("DO-NOT-ECHO"));
        assert_eq!(runner.calls[3][5], "/usr/bin/python3");
        assert_eq!(runner.calls[3][9], "inspect");
        assert_ne!(runner.calls[3][8], cfg.linux_launcher);
        assert!(!EnvironmentReport::pending().passed());
        let mut invalid = report.clone();
        invalid.checks.pop();
        assert!(!invalid.passed());
        invalid = report;
        invalid.checks[0] = invalid.checks[1].clone();
        assert!(!invalid.passed());
    }

    #[test]
    fn protocol_failures_and_credentials_are_not_exposed() {
        assert!(parse_linux(br#"{"checks":[],"repository":null}"#).is_err());
        let mut bad = linux_json("passed", "/?token=DO-NOT-ECHO");
        assert!(parse_linux(&bad).unwrap().repository.is_none());
        bad = linux_json("unknown", "/tmp/dsh");
        assert!(parse_linux(&bad).is_err());
        let cfg = config();
        let mut runner = fake(vec![
            output(b"Ubuntu-24.04\n"),
            output(b"tester\n"),
            output(b"dsh-python-ok"),
            output(b"raw token=DO-NOT-ECHO"),
        ]);
        let report = inspect_with(Some(&cfg), None, &mut runner);
        assert_eq!(state(&report, "launcher"), "error");
        assert_eq!(state(&report, "linux_config"), "skipped");
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("DO-NOT-ECHO"));
    }

    #[test]
    fn explicit_save_passes_repository_as_one_argument() {
        let cfg = config();
        let path = "/home/tester/DSH with spaces;not-a-shell-command";
        let mut runner = fake(vec![output(br#"{"saved":true}"#)]);
        assert!(save_with(&cfg, path, &mut runner).is_ok());
        assert_eq!(runner.calls[0].last().unwrap(), path);
        assert_eq!(runner.calls[0][9], "save");
        let mut runner = fake(vec![]);
        for bad in ["relative", "/bad\npath", "/?token=DO-NOT-ECHO"] {
            assert!(save_with(&cfg, bad, &mut runner).is_err());
        }
        assert!(runner.calls.is_empty());
        let mut runner = fake(vec![output(br#"{"saved":false,"token":"DO-NOT-ECHO"}"#)]);
        assert!(!save_with(&cfg, path, &mut runner)
            .unwrap_err()
            .contains("DO-NOT-ECHO"));
    }

    #[cfg(not(windows))]
    #[test]
    fn linux_native_inspection_does_not_invoke_wsl_or_services() {
        let report = inspect(None, None);
        assert_eq!(state(&report, "wsl"), "error");
        assert_eq!(state(&report, "config"), "error");
        assert_eq!(state(&report, "distribution"), "skipped");
    }
}
