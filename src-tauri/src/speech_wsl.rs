//! Windows adapter: fixed helper code/argv and fixed loopback HTTP, no shell.
#[cfg(test)]
#[path = "speech_wsl_tests.rs"]
mod tests;
use crate::{
    config::Config,
    speech_settings::{
        Cancellation, Inspection, ManagedSession, ModelState, Runtime, ServiceState, ServiceStatus,
        SpeechConfig,
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const ENDPOINT: &str = "http://127.0.0.1:18765";
const HELPER: &str = include_str!("../helpers/speech_runtime.py");
const BOOTSTRAP: &str = r#"import sys,json,base64
try:
 line=sys.stdin.buffer.readline(262145)
 if len(line)>262144: raise ValueError()
 obj=json.loads(line)
 if set(obj)!={'source'}: raise ValueError()
 code=base64.b64decode(obj['source'],validate=True)
 if len(code)>131072: raise ValueError()
except Exception:
 print('{"ok":false,"error":"bootstrap_failed"}',flush=True);sys.exit(2)
exec(compile(code,'<dsh-speech-runtime>','exec'),{'__name__':'__main__'})
"#;

type Provider = Arc<dyn Fn() -> Result<Config, String> + Send + Sync>;
struct Owned {
    config: Config,
    child: Child,
    input: Option<ChildStdin>,
}
struct Spawned {
    child: Child,
    output: mpsc::Receiver<Result<Option<Vec<u8>>, ()>>,
    writer: mpsc::Receiver<Result<Option<ChildStdin>, ()>>,
}
pub struct WslSpeechRuntime {
    provider: Provider,
    client: Client,
    owned: Mutex<HashMap<String, Owned>>,
}
impl WslSpeechRuntime {
    pub fn new(provider: Provider) -> Result<Self, String> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| "无法初始化语音服务连接。")?;
        Ok(Self {
            provider,
            client,
            owned: Mutex::new(HashMap::new()),
        })
    }
    fn config(&self) -> Result<Config, String> {
        let c = (self.provider)()?;
        c.validate()?;
        Ok(c)
    }
    fn command(config: &Config, mode: &str) -> Result<Command, String> {
        if ![
            "--stage",
            "--inspect",
            "--launch-held",
            "--stop",
            "--probe-owned",
            "--resources-discover",
            "--resources-browse",
            "--resources-download",
        ]
        .contains(&mode)
        {
            return Err("不支持的语音运行操作。".into());
        }
        #[cfg(windows)]
        let mut c = {
            let root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录。")?;
            Command::new(std::path::PathBuf::from(root).join("System32/wsl.exe"))
        };
        // Only compiled in test builds on Linux; never a configurable executable.
        #[cfg(not(windows))]
        let mut c = Command::new("/mnt/c/Windows/System32/wsl.exe");
        c.args([
            "--distribution",
            &config.distribution,
            "--user",
            &config.linux_user,
            "--exec",
            "/usr/bin/python3",
            "-c",
            BOOTSTRAP,
            mode,
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        Ok(c)
    }
    fn spawn(config: &Config, mode: &str, payload: &Value, hold: bool) -> Result<Spawned, String> {
        let source = if mode.starts_with("--resources-") {
            include_str!("../helpers/speech_resources.py")
        } else {
            HELPER
        };
        let mut bytes = serde_json::to_vec(&json!({"source":STANDARD.encode(source)}))
            .map_err(|_| "无法编码语音操作。")?;
        bytes.push(b'\n');
        bytes.extend(serde_json::to_vec(payload).map_err(|_| "无法编码语音操作。")?);
        bytes.push(b'\n');
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("语音操作数据超出限制。".into());
        }
        let mut child = Self::command(config, mode)?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动所选 WSL 用户的语音操作。")?;
        let mut input = child.stdin.take().ok_or("无法建立语音控制通道。")?;
        let stdout = child.stdout.take().ok_or("无法读取语音操作结果。")?;
        let (wt, writer) = mpsc::channel();
        thread::spawn(move || {
            let r = input.write_all(&bytes).and_then(|_| input.flush());
            let _ = wt.send(if r.is_ok() {
                Ok(if hold { Some(input) } else { None })
            } else {
                Err(())
            });
        });
        let resource = mode.starts_with("--resources-");
        let (tx, output) = mpsc::sync_channel(32);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut total = 0usize;
            loop {
                let mut line = Vec::new();
                match (&mut reader)
                    .take(if resource { 65537 } else { 8193 })
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => {
                        let _ = tx.send(Ok(None));
                        break;
                    }
                    Ok(_) => {
                        total += line.len();
                        if line.len() > (if resource { 65536 } else { 8192 })
                            || total > (if resource { 8 * 1024 * 1024 } else { 65536 })
                        {
                            let _ = tx.send(Err(()));
                            break;
                        }
                        if tx.send(Ok(Some(line))).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Err(()));
                        break;
                    }
                }
            }
        });
        Ok(Spawned {
            child,
            output,
            writer,
        })
    }
    fn exchange(
        &self,
        config: &Config,
        mode: &str,
        payload: Value,
        hold: bool,
        cancel: &Cancellation,
        timeout: Duration,
        on_line: &dyn Fn(&Value),
    ) -> Result<Value, String> {
        cancel.check()?;
        let mut p = Self::spawn(config, mode, &payload, hold)?;
        let start = Instant::now();
        let mut input = None;
        let mut writer_done = false;
        let mut read_done = false;
        let mut final_value = None;
        let mut failure = None;
        let mut cancelled_at = None;
        let mut exited = false;
        loop {
            if !writer_done {
                if let Ok(r) = p.writer.try_recv() {
                    writer_done = true;
                    match r {
                        Ok(v) => input = v,
                        Err(_) => failure = Some("无法传递语音操作配置。".to_string()),
                    }
                }
            }
            if (cancel.is_cancelled() || start.elapsed() > timeout || failure.is_some())
                && cancelled_at.is_none()
            {
                input.take();
                cancelled_at = Some(Instant::now());
                if !hold {
                    let _ = p.child.kill();
                }
            }
            if cancelled_at.is_some() {
                input.take();
                let grace = if mode == "--resources-download" {
                    20
                } else {
                    2
                };
                if cancelled_at.unwrap().elapsed() > Duration::from_secs(grace) {
                    let _ = p.child.kill();
                }
            }
            match p.output.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(Some(line))) => match serde_json::from_slice::<Value>(&line) {
                    Ok(v) => {
                        on_line(&v);
                        final_value = Some(v)
                    }
                    Err(_) => {
                        failure = Some("语音操作返回了无效数据。".into());
                    }
                },
                Ok(Ok(None)) => read_done = true,
                Ok(Err(())) => {
                    failure = Some("语音操作输出无效或过大。".into());
                    read_done = true
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => read_done = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Ok(Some(status)) = p.child.try_wait() {
                exited = true;
                if !status.success() && failure.is_none() && mode != "--inspect" {
                    failure = Some("WSL 语音操作未成功完成。".into())
                }
            }
            if exited && read_done {
                break;
            }
            let limit = if mode == "--resources-download" {
                25
            } else {
                5
            };
            if cancelled_at.is_some_and(|t| t.elapsed() > Duration::from_secs(limit)) {
                let _ = p.child.kill();
                break;
            }
        }
        input.take();
        if !exited {
            let _ = p.child.kill();
        }
        let _ = p.child.wait();
        cancel.check()?;
        if start.elapsed() > timeout {
            return Err("语音操作超时，可重试。".into());
        }
        if let Some(e) = failure {
            return Err(e);
        }
        final_value.ok_or("语音操作没有返回结果。".into())
    }
    fn stage(&self, c: &Config, cancel: &Cancellation) -> Result<String, String> {
        let files = json!({
   "server.py":STANDARD.encode(include_bytes!("../../services/qwen_tts/server.py")),
   "native_q8.py":STANDARD.encode(include_bytes!("../../services/qwen_tts/native_q8.py")),
   "runtime_check.py":STANDARD.encode(include_bytes!("../../services/qwen_tts/runtime_check.py")),
   "voice/profile.json":STANDARD.encode(include_bytes!("../../services/qwen_tts/voice/profile.json")),
   "voice/reference.wav":STANDARD.encode(include_bytes!("../../services/qwen_tts/voice/reference.wav")),
   "managed_runtime.py":STANDARD.encode(HELPER)});
        let v = self.exchange(
            c,
            "--stage",
            json!({"files":files}),
            false,
            cancel,
            Duration::from_secs(30),
            &|_| {},
        )?;
        if v.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("无法准备 WSL 语音桥接文件，请查看诊断。".into());
        }
        let path = v
            .get("script_path")
            .and_then(Value::as_str)
            .ok_or("语音桥接路径无效。")?;
        if !path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control) {
            return Err("语音桥接路径无效。".into());
        }
        Ok(path.into())
    }
    fn body(response: reqwest::blocking::Response) -> Result<Value, String> {
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > 8192) {
            return Err("语音服务响应无效。".into());
        }
        let mut b = Vec::new();
        response
            .take(8193)
            .read_to_end(&mut b)
            .map_err(|_| "读取语音状态失败。")?;
        if b.len() > 8192 {
            return Err("语音服务响应过大。".into());
        }
        serde_json::from_slice(&b).map_err(|_| "语音服务返回无效状态。".into())
    }
    fn authenticated(
        &self,
        s: &ManagedSession,
        action: &str,
        timeout: Duration,
    ) -> Result<Value, String> {
        Self::body(
            self.client
                .post(format!("{ENDPOINT}/v1/control"))
                .header("X-DSH-Speech-Control", s.control_token())
                .header("Content-Type", "application/json")
                .body(json!({"instance_id":s.instance_id(),"action":action}).to_string())
                .timeout(timeout)
                .send()
                .map_err(|_| "语音控制连接未完成。")?,
        )
    }
    fn parse_status(v: &Value) -> ServiceStatus {
        let valid = v.get("service").and_then(Value::as_str) == Some("dsh-pet-qwen")
            && v.get("protocol").and_then(Value::as_u64) == Some(1)
            && v.get("voice_id").and_then(Value::as_str) == Some("pet-airhead-v1");
        let modern = valid
            && v.get("status_protocol").and_then(Value::as_u64) == Some(1)
            && v.get("backend").and_then(Value::as_str) == Some("rocm")
            && v.get("device").and_then(Value::as_str) == Some("ROCm0");
        let model = if modern {
            match v.get("model_state").and_then(Value::as_str) {
                Some("unloaded") => ModelState::Unloaded,
                Some("loading") => ModelState::Loading,
                Some("ready") => ModelState::Ready,
                Some("generating") => ModelState::Generating,
                Some("error") => ModelState::Error,
                _ => ModelState::Unknown,
            }
        } else {
            ModelState::Unknown
        };
        ServiceStatus {
            identity_valid: valid,
            instance_id: if modern {
                v.get("instance_id")
                    .and_then(Value::as_str)
                    .filter(|s| s.len() <= 128)
                    .map(str::to_string)
            } else {
                None
            },
            service_state: ServiceState::Running,
            model_state: model,
            gpu_name: if modern {
                v.get("gpu_name")
                    .and_then(Value::as_str)
                    .filter(|s| s.len() <= 256 && !s.chars().any(char::is_control))
                    .map(str::to_string)
            } else {
                None
            },
        }
    }
}
fn resource_result(value: Value) -> Result<Value, String> {
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    let message = match value.get("error").and_then(Value::as_str) {
        Some("existing_model_mismatch") => "目标目录已有不兼容模型，未覆盖；请选择新目录。",
        Some("model_hash_mismatch") => "下载模型的 SHA256 不匹配，未发布文件，可重试。",
        Some("unsafe_download_directory" | "unsafe_model_file" | "unsafe_path") => {
            "路径不安全；请使用当前 WSL 用户拥有的非共享目录。"
        }
        Some("download_busy") => "此目录已有模型下载，请稍后重试。",
        Some("untrusted_download_redirect") => "模型服务器重定向不在可信 HTTPS 白名单内。",
        Some("cancelled") => "模型下载已取消。",
        Some("incomplete_download") => "模型下载不完整，未发布文件，可重试。",
        _ => "资源操作失败，请检查路径、权限或网络后重试。",
    };
    Err(message.into())
}
impl crate::speech_resources::Runtime for WslSpeechRuntime {
    fn discover(
        &self,
        config: &SpeechConfig,
    ) -> Result<crate::speech_resources::Discovery, String> {
        let result = self.exchange(
            &self.config()?,
            "--resources-discover",
            json!({"python_path":config.python_path,"model_dir":config.model_dir,"native_lib":config.native_lib}),
            false,
            &Cancellation::default(),
            Duration::from_secs(110),
            &|_| {},
        )?;
        serde_json::from_value(resource_result(result)?).map_err(|_| "Python 候选结果无效。".into())
    }
    fn browse(
        &self,
        path: Option<String>,
        kind: crate::speech_resources::PathKind,
    ) -> Result<crate::speech_resources::Directory, String> {
        let result = self.exchange(
            &self.config()?,
            "--resources-browse",
            json!({"path":path,"kind":kind}),
            false,
            &Cancellation::default(),
            Duration::from_secs(10),
            &|_| {},
        )?;
        serde_json::from_value(resource_result(result)?).map_err(|_| "目录浏览结果无效。".into())
    }
    fn download(
        &self,
        path: &str,
        cancel: &Cancellation,
        progress: &dyn Fn(crate::speech_resources::Progress),
    ) -> Result<(), String> {
        let result = self.exchange(
            &self.config()?,
            "--resources-download",
            json!({"model_dir":path}),
            true,
            cancel,
            Duration::from_secs(3600),
            &|value| {
                if let Ok(update) =
                    serde_json::from_value::<crate::speech_resources::Progress>(value.clone())
                {
                    if update.downloaded_bytes <= 6 * 1024 * 1024 * 1024u64
                        && update
                            .total_bytes
                            .is_none_or(|n| n <= 6 * 1024 * 1024 * 1024u64)
                        && update.file.as_deref().is_none_or(|name| {
                            matches!(
                                name,
                                "qwen-talker-1.7b-base-Q8_0.gguf" | "qwen-tokenizer-12hz-Q8_0.gguf"
                            )
                        })
                    {
                        progress(update);
                    }
                }
            },
        )?;
        resource_result(result).map(|_| ())
    }
}
impl Runtime for WslSpeechRuntime {
    fn distribution(&self) -> Option<String> {
        self.config().ok().map(|c| c.distribution)
    }
    fn inspect(
        &self,
        config: &SpeechConfig,
        cancel: &Cancellation,
        progress: &dyn Fn(u8),
    ) -> Result<Inspection, String> {
        config.validate()?;
        let launcher = self.config()?;
        let script = self.stage(&launcher, cancel)?;
        let v=self.exchange(&launcher,"--inspect",json!({"script_path":script,"python_path":config.python_path,"model_dir":config.model_dir,"native_lib":config.native_lib}),true,cancel,Duration::from_secs(190),&|v|{if v.get("kind").and_then(Value::as_str)==Some("progress"){if let Some(p)=v.get("progress").and_then(Value::as_u64).filter(|p|*p<=100){progress(p as u8)}}})?;
        if v.get("kind").and_then(Value::as_str) != Some("result") {
            return Err("检测没有返回有效结果。".into());
        }
        let env = v
            .get("environment_ok")
            .and_then(Value::as_bool)
            .ok_or("检测结果缺少环境状态。")?;
        let models = v
            .get("models_ok")
            .and_then(Value::as_bool)
            .ok_or("检测结果缺少模型状态。")?;
        let error = v.get("error_code").and_then(Value::as_str).map(|c| {
            match c {
                "missing_talker" => "缺少主模型文件 qwen-talker-1.7b-base-Q8_0.gguf。",
                "missing_codec" => "缺少声码器文件 qwen-tokenizer-12hz-Q8_0.gguf。",
                "hash_mismatch_talker" => "主模型 SHA256 不匹配，请重新检查下载文件。",
                "hash_mismatch_codec" => "声码器 SHA256 不匹配，请重新检查下载文件。",
                "native_unavailable" => "原生推理库不可用或 ABI 版本不匹配，请按配置说明检查。",
                "rocm_sdk_not_installed" => "所选 Python 环境尚未安装匹配的 ROCm 运行时。",
                "wsl2_gpu_bridge_required" => "需要可用的 WSL2 GPU 桥接。",
                "gpu_compute_failed" | "gpu_device_unavailable" | "gpu_probe_failed" => {
                    "ROCm GPU 计算检测未通过，请检查所选运行环境。"
                }
                "models_unavailable" => "模型目录不可读，请检查两个模型文件及权限。",
                "check_cancelled" => "检测已取消。",
                "check_timeout" | "gpu_probe_timeout" => "环境或模型检测超时，可重试。",
                _ => "语音配置检测未通过，请检查运行时、推理库和模型文件。",
            }
            .to_string()
        });
        Ok(Inspection {
            environment_ok: env,
            models_ok: models,
            gpu_name: v
                .get("gpu_name")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 256 && !s.chars().any(char::is_control))
                .map(str::to_string),
            error,
        })
    }
    fn status(&self, cancel: &Cancellation) -> Result<ServiceStatus, String> {
        cancel.check()?;
        let request = self
            .client
            .get(format!("{ENDPOINT}/v1/status"))
            .timeout(Duration::from_secs(3))
            .send();
        let result = match request {
            Ok(r) if r.status().is_success() => Self::parse_status(&Self::body(r)?),
            Ok(_) => {
                let r = self
                    .client
                    .get(format!("{ENDPOINT}/health"))
                    .timeout(Duration::from_secs(3))
                    .send()
                    .map_err(|_| "无法确认语音服务状态。")?;
                Self::parse_status(&Self::body(r)?)
            }
            Err(e) if e.is_connect() && !e.is_timeout() => ServiceStatus {
                identity_valid: false,
                instance_id: None,
                service_state: ServiceState::Stopped,
                model_state: ModelState::Unloaded,
                gpu_name: None,
            },
            Err(_) => return Err("语音服务无响应，暂不能确认运行状态。".into()),
        };
        cancel.check()?;
        Ok(result)
    }
    fn start(
        &self,
        config: &SpeechConfig,
        cancel: &Cancellation,
    ) -> Result<ManagedSession, String> {
        config.validate()?;
        cancel.check()?;
        let launcher = self.config()?;
        let script = self.stage(&launcher, cancel)?;
        cancel.check()?;
        let mut p = Self::spawn(
            &launcher,
            "--launch-held",
            &json!({"script_path":script,"python_path":config.python_path,"model_dir":config.model_dir,"native_lib":config.native_lib}),
            true,
        )?;
        let start = Instant::now();
        let mut input = None;
        let mut result = None;
        while start.elapsed() < Duration::from_secs(30) {
            if let Ok(r) = p.writer.try_recv() {
                input = r.map_err(|_| "无法建立语音托管通道。")?;
            }
            if cancel.is_cancelled() {
                input.take();
            }
            match p.output.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(Some(line))) => {
                    result = serde_json::from_slice::<Value>(&line).ok();
                    break;
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if p.child.try_wait().ok().flatten().is_some() {
                break;
            }
        }
        if input.is_none() {
            if let Ok(Ok(i)) = p.writer.recv_timeout(Duration::from_secs(1)) {
                input = i
            }
        }
        let parsed = (|| {
            let v = result.as_ref().ok_or("未取得语音托管身份。")?;
            if v.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err("无法启动托管语音服务。".into());
            }
            ManagedSession::new(
                v.get("instance_id")
                    .and_then(Value::as_str)
                    .ok_or("托管身份无效。")?
                    .into(),
                v.get("control_token")
                    .and_then(Value::as_str)
                    .ok_or("托管身份无效。")?
                    .into(),
            )
        })();
        let session = match parsed {
            Ok(s) if input.is_some() => s,
            _ => {
                drop(input);
                let until = Instant::now() + Duration::from_secs(3);
                while Instant::now() < until && p.child.try_wait().ok().flatten().is_none() {
                    thread::sleep(Duration::from_millis(20));
                }
                let _ = p.child.kill();
                let _ = p.child.wait();
                return Err("语音服务启动失败或已取消。".into());
            }
        };
        self.owned.lock().unwrap_or_else(|e| e.into_inner()).insert(
            session.instance_id().into(),
            Owned {
                config: launcher,
                child: p.child,
                input,
            },
        );
        if cancel.is_cancelled() {
            let _ = self.stop(&session);
            return Err("语音操作已取消。".into());
        }
        Ok(session)
    }
    fn prepare(&self, s: &ManagedSession, cancel: &Cancellation) -> Result<ServiceStatus, String> {
        let start = Instant::now();
        loop {
            cancel.check()?;
            let status = self.status(cancel)?;
            if status.service_state == ServiceState::Running {
                if !status.identity_valid || status.instance_id.as_deref() != Some(s.instance_id())
                {
                    return Err("语音端口已被其他服务占用，不会接管。".into());
                }
                break;
            }
            if start.elapsed() > Duration::from_secs(45) {
                return Err("语音服务启动超时。".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
        cancel.check()?;
        let v = self.authenticated(s, "prepare", Duration::from_secs(185))?;
        cancel.check()?;
        let status = Self::parse_status(&v);
        if status.instance_id.as_deref() != Some(s.instance_id())
            || status.model_state != ModelState::Ready
        {
            return Err("模型未完成加载，请查看诊断后重试。".into());
        }
        Ok(status)
    }
    fn stop(&self, s: &ManagedSession) -> Result<(), String> {
        // Retain the exact lease after a failed stop so a retry cannot lose ownership.
        let mut entries = self.owned.lock().unwrap_or_else(|e| e.into_inner());
        let owned = entries
            .get_mut(s.instance_id())
            .ok_or("无法确认此服务的托管归属，不会停止外部服务。")?;
        let _ = self.authenticated(s, "shutdown", Duration::from_secs(3));
        owned.input.take();
        let until = Instant::now() + Duration::from_secs(4);
        let mut success = false;
        while Instant::now() < until {
            if let Ok(Some(status)) = owned.child.try_wait() {
                success = status.success();
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        if !success {
            let result = self.exchange(
                &owned.config,
                "--stop",
                json!({"instance_id":s.instance_id(),"control_token":s.control_token()}),
                false,
                &Cancellation::default(),
                Duration::from_secs(8),
                &|_| {},
            );
            success = result
                .as_ref()
                .is_ok_and(|v| v.get("ok").and_then(Value::as_bool) == Some(true));
            let _ = owned.child.kill();
            let _ = owned.child.wait();
        }
        if success {
            entries.remove(s.instance_id());
            Ok(())
        } else {
            Err("停止尚未完成，托管身份仍按原实例保护，请重新检测。".into())
        }
    }
    fn cancel_requests(&self, id: &str) -> Result<(), String> {
        crate::assistant_speech::SpeechBridge::cancel_remote(id)
    }
}
