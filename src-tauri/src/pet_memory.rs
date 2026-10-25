//! Native-scoped pet memory contract. No UI-selected paths, backend RPC, or model calls.
use crate::{
    assistant::{BackendIdentity, Binding},
    config::Config,
    environment::Runner,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{sync::Mutex, time::Duration};

#[cfg(test)]
#[path = "pet_memory_tests.rs"]
mod tests;

/// Shared admission gate: assistant send / binding changes must acquire this before their
/// own operation/data locks. Never acquire it while holding assistant data or backend locks.
static MEMORY_OPERATION: Mutex<()> = Mutex::new(());
pub fn operation_mutex() -> &'static Mutex<()> {
    &MEMORY_OPERATION
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Fact,
    Preference,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum MemoryAction {
    List { offset: usize, query: String },
    SetEnabled { enabled: bool },
    UpdatePersona { name: String, persona: String },
    Add { kind: MemoryKind, content: String },
    Correct { id: String, content: String },
    Forget { id: String, confirm: bool },
    Clear { confirm: bool },
}

fn text(value: &str, max: usize, empty: bool) -> bool {
    (empty || !value.trim().is_empty())
        && value.chars().count() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn entry_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
impl MemoryAction {
    pub fn validate(&self) -> Result<(), String> {
        let valid = match self {
            Self::List { offset, query } => *offset <= 1000 && text(query, 200, true),
            Self::SetEnabled { .. } => true,
            Self::UpdatePersona { name, persona } => {
                text(name, 40, false)
                    && !name.chars().any(char::is_control)
                    && text(persona, 240, true)
            }
            Self::Add { content, .. } => text(content, 1000, false),
            Self::Correct { id, content } => entry_id(id) && text(content, 1000, false),
            Self::Forget { id, confirm } => *confirm && entry_id(id),
            Self::Clear { confirm } => *confirm,
        };
        if valid {
            Ok(())
        } else {
            Err("记忆操作参数无效或超出长度限制。".into())
        }
    }
}

/// Stored records may include legacy episode entries; UI additions remain fact/preference only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEntryKind {
    Fact,
    Preference,
    Episode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryEntry {
    pub id: String,
    pub kind: MemoryEntryKind,
    pub content: String,
    pub source_session_id: Option<String>,
    pub updated_at: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemorySnapshot {
    pub available: bool,
    pub enabled: bool,
    pub pet_id: String,
    pub name: String,
    pub persona: String,
    pub entries: Vec<MemoryEntry>,
    pub message: Option<String>,
    #[serde(default)]
    pub runtime_ready: bool,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub next_offset: Option<usize>,
    #[serde(default)]
    pub total: usize,
}
impl MemorySnapshot {
    pub fn unavailable(message: &str) -> Self {
        Self {
            available: false,
            enabled: false,
            pet_id: String::new(),
            name: String::new(),
            persona: String::new(),
            entries: vec![],
            message: Some(message.into()),
            runtime_ready: false,
            mode: "explicit".into(),
            next_offset: None,
            total: 0,
        }
    }
}

pub fn backend_identity(config: &Config) -> BackendIdentity {
    BackendIdentity {
        distribution: config.distribution.clone(),
        user: config.linux_user.clone(),
        origin: config.origin(),
    }
}

/// SHA-256 of a JSON array, not delimiter-concatenated identifiers.
/// Session and filesystem path deliberately do not affect identity.
pub fn scope(binding: &Binding, current: &BackendIdentity) -> Result<String, String> {
    if &binding.backend != current
        || binding.workspace_id.trim().is_empty()
        || binding.workspace_id.len() > 4096
        || binding.workspace_id.chars().any(char::is_control)
    {
        return Err("当前后端与工作目录绑定不一致，请刷新后重试。".into());
    }
    let bytes = serde_json::to_vec(&[
        &current.distribution,
        &current.user,
        &current.origin,
        &binding.workspace_id,
    ])
    .map_err(|_| "无法编码记忆作用域。".to_owned())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

const HELPER: &str = include_str!("../helpers/pet_memory.py");

/// Fixed interpreter and bundled source; only data travels over stdin.
/// Isolated Python resolves the store under the selected WSL user's own home.
fn helper_args(config: &Config) -> Result<Vec<String>, String> {
    config.validate()?;
    Ok(vec![
        "--distribution".into(),
        config.distribution.clone(),
        "--user".into(),
        config.linux_user.clone(),
        "--exec".into(),
        "/usr/bin/python3".into(),
        "-I".into(),
        "-c".into(),
        HELPER.into(),
    ])
}

pub(crate) fn run_with(
    runner: &mut impl Runner,
    config: &Config,
    binding: &Binding,
    request: Option<&MemoryAction>,
) -> Result<MemorySnapshot, String> {
    if let Some(action) = request {
        action.validate()?;
    }
    let scope = scope(binding, &backend_identity(config))?;
    let request = request
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| "无法编码记忆操作。".to_owned())?
        .unwrap_or_else(|| serde_json::json!({"action":"get"}));
    let input = serde_json::to_vec(&serde_json::json!({"scope":scope,"request":request}))
        .map_err(|_| "无法编码记忆操作。".to_owned())?;
    let args = helper_args(config)?;
    let output = runner
        .run_input(&args, input, Duration::from_secs(15))
        .map_err(|_| "无法访问 WSL 本地记忆，请检查 WSL 和 Python 后重试。".to_owned())?;
    // Never surface helper stderr, raw stdout, config, scope, or process details.
    if !output.success {
        return Err("本地记忆操作未完成，请刷新后重试。".into());
    }
    let mut snapshot: MemorySnapshot = serde_json::from_slice(&output.stdout)
        .map_err(|_| "本地记忆返回了无效结果，请刷新后重试。".to_owned())?;
    snapshot.runtime_ready = false;
    if snapshot.available && snapshot.enabled {
        snapshot.message =
            Some("本地记忆已启用；使用需安装桌宠专属 Agent 扩展并开始新对话。".into());
    }
    Ok(snapshot)
}
