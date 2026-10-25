//! Strict read-only installation guidance. This is not inference readiness.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const INSTALL_COMMAND: &str = "sudo apt-get update && sudo apt-get install -y python3 python3-venv git build-essential coreutils bash";
const IDS: [&str; 4] = ["platform", "python", "tools", "gpu"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ready,
    Action,
    Unsupported,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrerequisiteCheck {
    pub id: String,
    pub status: CheckStatus,
    pub detail: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechPrerequisites {
    pub ready: bool,
    pub checks: Vec<PrerequisiteCheck>,
    pub install_command: Option<String>,
}
impl SpeechPrerequisites {
    pub fn parse(value: Value) -> Result<Self, String> {
        if value.get("install_command").is_none() {
            return Err("语音前置检查返回了无效数据。".into());
        }
        let result: Self = serde_json::from_value(value)
            .map_err(|_| "语音前置检查返回了无效数据。".to_string())?;
        if result.checks.len() != IDS.len()
            || result.checks.iter().zip(IDS).any(|(check, id)| {
                check.id != id
                    || check.detail.is_empty()
                    || check.detail.len() > 768
                    || check.detail.chars().any(char::is_control)
            })
            || result.ready != result.checks.iter().all(|c| c.status == CheckStatus::Ready)
            || result
                .install_command
                .as_deref()
                .is_some_and(|c| c != INSTALL_COMMAND)
            || (result.install_command.is_some()
                && !result.checks[1..=2]
                    .iter()
                    .any(|c| c.status == CheckStatus::Action))
        {
            return Err("语音前置检查返回了无效数据。".into());
        }
        Ok(result)
    }

    /// The fixed system-Python bootstrap cannot inspect a WSL without Python.
    /// Never invent distro evidence or offer apt on an unverified distribution.
    pub fn transport_unavailable() -> Self {
        let details = [
            "无法检查所选 WSL；请确认主程序的 WSL 配置与发行版可用后重试。",
            "请确认当前 WSL 的 /usr/bin/python3 可运行且版本 ≥ 3.10，并已安装 python3-venv。",
            "WSL 检查尚未完成；请先修复系统 Python 后重新检查构建工具。",
            "WSL 检查尚未完成；请先修复连接，再检查 Windows 显卡驱动与 WSL2 GPU 桥接。",
        ];
        Self {
            ready: false,
            checks: IDS
                .into_iter()
                .zip(details)
                .map(|(id, detail)| PrerequisiteCheck {
                    id: id.into(),
                    status: CheckStatus::Action,
                    detail: detail.into(),
                })
                .collect(),
            install_command: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn valid() -> Value {
        json!({"ready":true,"checks": IDS.map(|id| json!({"id":id,"status":"ready","detail":"已就绪。"})),"install_command":null})
    }
    #[test]
    fn strict_dto_and_consistent_readiness() {
        let dto = SpeechPrerequisites::parse(valid()).unwrap();
        assert!(dto.ready);
        assert_eq!(serde_json::to_value(dto).unwrap(), valid());
        let mut value = valid();
        value["ready"] = json!(false);
        assert!(SpeechPrerequisites::parse(value).is_err());
        for bad in ["unknown", "READY", "failed"] {
            let mut value = valid();
            value["checks"][0]["status"] = json!(bad);
            assert!(SpeechPrerequisites::parse(value).is_err());
        }
    }
    #[test]
    fn reject_duplicate_missing_extra_and_unsafe_fields() {
        for change in 0..7 {
            let mut value = valid();
            match change {
                0 => value["checks"][1]["id"] = json!("platform"),
                1 => {
                    value["checks"].as_array_mut().unwrap().pop();
                }
                2 => value["path"] = json!("/untrusted"),
                3 => value["checks"][0]["url"] = json!("https://untrusted"),
                4 => value["checks"][0]["detail"] = json!("raw\ntrace"),
                5 => value["install_command"] = json!("sudo apt install injected"),
                _ => {
                    value.as_object_mut().unwrap().remove("install_command");
                }
            }
            assert!(SpeechPrerequisites::parse(value).is_err(), "case {change}");
        }
    }
    #[test]
    fn ipc_is_settings_only_blocking_and_never_consults_running_service() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/speech-settings.json")).unwrap();
        assert_eq!(capability["local"], json!(true));
        assert_eq!(
            capability["webviews"],
            json!(["launcher-settings", "dsh-settings"])
        );
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-check-speech-prerequisites")));
        let source = include_str!("desktop_speech_settings.rs");
        let command = source
            .split("pub(super) async fn check_speech_prerequisites(")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(command.contains("assert_page(&view, false)?"));
        assert!(command.contains("spawn_blocking(move || runtime.check_prerequisites())"));
        assert!(!command.contains("install_controls("));
        assert!(!command.contains("controls(view.app_handle())"));
        let adapter = include_str!("speech_wsl.rs");
        let preflight = adapter
            .split("pub fn check_prerequisites(")
            .nth(1)
            .unwrap()
            .split("fn stage(")
            .next()
            .unwrap();
        assert!(!preflight.contains("status("));
        assert!(preflight
            .split_whitespace()
            .collect::<String>()
            .contains("json!({}),true,"));
        assert!(preflight.contains("Duration::from_secs(20)"));
        assert!(include_str!("desktop.rs").contains("speech_settings::check_speech_prerequisites,"));
        assert!(include_str!("../build.rs").contains("\"check_speech_prerequisites\""));
        assert!(
            include_str!("../permissions/autogenerated/check_speech_prerequisites.toml")
                .contains("commands.allow = [\"check_speech_prerequisites\"]")
        );
    }
    #[test]
    fn command_is_fixed_guidance_only_for_missing_dependencies() {
        let mut value = valid();
        value["install_command"] = json!(INSTALL_COMMAND);
        assert!(SpeechPrerequisites::parse(value.clone()).is_err());
        value["checks"][1]["status"] = json!("action");
        value["ready"] = json!(false);
        assert!(SpeechPrerequisites::parse(value).is_ok());
        let fallback = SpeechPrerequisites::transport_unavailable();
        assert!(!fallback.ready);
        assert!(fallback.install_command.is_none());
        SpeechPrerequisites::parse(serde_json::to_value(fallback).unwrap()).unwrap();
    }
}
