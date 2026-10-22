use crate::{
    config::Config,
    protocol::{parse_reply, BackendReply},
};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub struct Backend {
    pub config: Config,
}
impl Backend {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
    fn command(&self, action: &str) -> Result<Command, String> {
        let args = self.config.wsl_args(action)?;
        #[cfg(windows)]
        {
            let root = std::env::var_os("SystemRoot").ok_or("找不到 Windows 系统目录。")?;
            let mut command = Command::new(std::path::PathBuf::from(root).join("System32/wsl.exe"));
            command.args(args);
            Ok(command)
        }
        #[cfg(not(windows))]
        {
            let _ = args;
            Err("WSL 服务控制只支持 Windows。".into())
        }
    }
    pub fn invoke(&self, action: &str) -> Result<BackendReply, String> {
        if action == "run" {
            return Err("持久服务必须使用独立启动接口。".into());
        }
        if action == "stop" {
            return Err("停止操作必须提供预期进程身份。".into());
        }
        let command = self.command(action)?;
        self.request(command, action)
    }
    pub fn stop(&self, expected_pid: u32) -> Result<BackendReply, String> {
        if expected_pid == 0 {
            return Err("无法确认待停止的服务身份。".into());
        }
        let mut command = self.command("probe")?;
        // Start from a fresh command to replace (rather than append to) helper argv.
        let program = command.get_program().to_owned();
        command = Command::new(program);
        let mut args = self.config.wsl_args("probe")?;
        args.truncate(6);
        args.extend([
            "-c".into(),
            include_str!("../helpers/guarded_stop.py").into(),
            self.config.linux_launcher.clone(),
            self.config.linux_config.clone(),
            expected_pid.to_string(),
        ]);
        command.args(args);
        self.request(command, "stop")
    }
    fn request(&self, mut command: Command, action: &str) -> Result<BackendReply, String> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command
            .spawn()
            .map_err(|_| "无法执行 WSL，请检查发行版和 Linux 用户配置。")?;
        let timeout = if action == "stop" {
            self.config.stop_timeout_seconds
        } else {
            self.config.probe_timeout_seconds
        };
        let bytes = capture(child, Duration::from_secs(timeout))?;
        parse_reply(&bytes)
    }
    /// No pipes or job object tie the persistent WSL supervisor to this UI process.
    pub fn start(&self) -> Result<Child, String> {
        let mut command = self.command("run")?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000008 | 0x00000200);
        }
        command
            .spawn()
            .map_err(|_| "无法启动独立的 WSL 后台进程。".into())
    }
}

fn capture(mut child: Child, timeout: Duration) -> Result<Vec<u8>, String> {
    let stdout = child.stdout.take().ok_or("无法读取 WSL 操作结果。")?;
    // Bounded memory even if a misconfigured script emits unlimited output.
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut stdout = stdout;
        loop {
            let count = stdout
                .read(&mut chunk)
                .map_err(|_| "读取 WSL 操作结果失败。")?;
            if count == 0 {
                break;
            }
            if bytes.len() + count > 65536 {
                return Err("WSL 操作结果过大。".to_string());
            }
            bytes
                .write_all(&chunk[..count])
                .map_err(|_| "读取 WSL 操作结果失败。")?;
        }
        Ok(bytes)
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // stdout can remain inherited by a descendant; do not join indefinitely.
                while !reader.is_finished() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(20));
                }
                if !reader.is_finished() {
                    return Err("WSL 操作输出未结束，服务状态尚未确认。".into());
                }
                let output = reader.join().map_err(|_| "读取 WSL 操作结果失败。")??;
                if !status.success() {
                    // Recover a safe mapped error, never raw stderr or authentication links.
                    return match parse_reply(&output) {
                        Err(error) => Err(error),
                        Ok(_) => Err("WSL 操作执行失败。".into()),
                    };
                }
                return Ok(output);
            }
            Ok(None) => (),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("无法确认 WSL 操作状态。".into());
            }
        }
        if Instant::now() >= deadline {
            // Kill only the short-lived wsl.exe control request, not DSH or the distribution.
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "WSL 操作超时，服务可能仍在运行；请刷新状态，不会自动重启或强制停止。".into(),
            );
        }
        thread::sleep(Duration::from_millis(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_collects_short_output() {
        #[cfg(unix)]
        {
            let child = Command::new("printf")
                .arg("hello")
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            assert_eq!(capture(child, Duration::from_secs(2)).unwrap(), b"hello");
        }
        #[cfg(windows)]
        {
            let root = std::env::var_os("SystemRoot").expect("Windows system directory");
            let child = Command::new(std::path::PathBuf::from(root).join("System32/cmd.exe"))
                .args(["/d", "/c", "echo hello"])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let output = capture(child, Duration::from_secs(5)).unwrap();
            assert_eq!(String::from_utf8(output).unwrap().trim(), "hello");
        }
    }
    #[test]
    fn capture_times_out_without_touching_other_processes() {
        #[cfg(unix)]
        {
            let child = Command::new("sleep")
                .arg("3")
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let now = Instant::now();
            assert!(capture(child, Duration::from_millis(30)).is_err());
            assert!(now.elapsed() < Duration::from_secs(2));
        }
        #[cfg(windows)]
        {
            let root = std::env::var_os("SystemRoot").expect("Windows system directory");
            let child = Command::new(
                std::path::PathBuf::from(root)
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            )
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 5",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
            let now = Instant::now();
            assert!(capture(child, Duration::from_millis(100)).is_err());
            assert!(now.elapsed() < Duration::from_secs(4));
        }
    }
}
