//! Read-only workspace policy. No DSH RPC, directory creation, or history access.
#[cfg(test)]
#[path = "pet_workspace_tests.rs"]
mod tests;
use crate::{
    assistant::{BackendIdentity, Binding},
    settings_path::to_unc,
};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    Ready,
    Unbound,
    BackendChanged,
    Invalid,
    Missing,
    Unavailable,
}
#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceSnapshot {
    pub status: WorkspaceStatus,
    pub distribution: Option<String>,
    pub path: Option<String>,
    pub message: String,
}

/// Only native binding supplies the target; a changed user/origin also fails closed.
pub fn inspect(
    binding: Option<&Binding>,
    current: Option<&BackendIdentity>,
    probe: impl FnOnce(&str) -> Result<bool, ()>,
) -> WorkspaceSnapshot {
    let mut result = WorkspaceSnapshot {
        status: WorkspaceStatus::Unbound,
        distribution: None,
        path: None,
        message: "尚未绑定对话工作目录；查看此页不会创建目录或启用聊天。".into(),
    };
    let Some(binding) = binding else {
        return result;
    };
    let target = match to_unc(&binding.backend.distribution, &binding.workspace_path) {
        Ok(target) => target,
        Err(_) => {
            result.status = WorkspaceStatus::Invalid;
            result.message = "绑定的 WSL 工作目录无效或不支持安全打开。".into();
            return result;
        }
    };
    result.distribution = Some(binding.backend.distribution.clone());
    result.path = Some(binding.workspace_path.clone());
    if current != Some(&binding.backend) {
        result.status = WorkspaceStatus::BackendChanged;
        result.message = "当前后端身份与绑定不一致或配置不可用；显示原绑定目录，禁止打开。".into();
        return result;
    }
    (result.status, result.message) = match probe(&target) {
        Ok(true) => (
            WorkspaceStatus::Ready,
            "当前实际绑定的 WSL Workspace 工作目录（只读）。".into(),
        ),
        Ok(false) => (
            WorkspaceStatus::Missing,
            "工作目录不存在或不是文件夹；不会自动创建。".into(),
        ),
        Err(()) => (
            WorkspaceStatus::Unavailable,
            "无法访问工作目录，请检查 WSL 状态或目录权限后刷新。".into(),
        ),
    };
    result
}

/// Compare the complete native snapshot again after slow filesystem I/O.
pub fn unchanged(
    binding: Option<&Binding>,
    current: Option<&BackendIdentity>,
    latest_binding: Option<&Binding>,
    latest_current: Option<&BackendIdentity>,
) -> Result<(), String> {
    if binding != latest_binding || current != latest_current {
        return Err("绑定或后端配置已变化，请刷新工作目录后重试。".into());
    }
    Ok(())
}

pub fn open_bound(
    binding: Option<&Binding>,
    current: Option<&BackendIdentity>,
    probe: impl FnOnce(&str) -> Result<bool, ()>,
    open: impl FnOnce(&str) -> Result<(), ()>,
) -> Result<WorkspaceSnapshot, String> {
    let result = inspect(binding, current, probe);
    if result.status != WorkspaceStatus::Ready {
        return Err(result.message);
    }
    // Reuse the validated native binding, never a path received from JavaScript.
    let binding = binding.ok_or("尚未绑定对话工作目录。")?;
    let target = to_unc(&binding.backend.distribution, &binding.workspace_path)?;
    open(&target).map_err(|()| "打开目录失败，请检查资源管理器和 WSL 后重试。".to_owned())?;
    Ok(result)
}
