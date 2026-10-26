# v0.1.32

## 移除不可用的桌宠朗读

- 移除回复气泡的“朗读”、右键菜单的“自动朗读”和本地千问语音设置。
- 删除朗读后端、模型与组件安装下载逻辑、专用权限及相关文档，不再启动本地朗读服务。
- 保留文字聊天、流式回复、气泡展开与收起、宠物记忆和随包内置的通知提示音。

## 旧版语音数据

- 更新不会自动删除旧模型、专用 Python 环境或语音配置。需要释放空间时，先退出旧版启动器并确认其语音服务已停止，再删除当前 WSL 用户的 `~/.dsh-wsl-desktop/speech/`。
- 只删除 `speech` 子目录，不要删除 `~/.dsh-wsl-desktop/assistant/` 或整个根目录；助手数据和对话历史应保留。
- 本次维护已在当前开发环境清理默认语音目录，释放约 9.3 GiB；这不代表更新安装器会自动清理其他用户的数据。

## 验证与使用边界

- 本地 771 项前端、172 项 Python、315 项 Rust 测试通过；前端生产构建、Rust 格式及 Windows MSVC 目标源码检查通过。
- 更新仅更新 Windows 启动器，不自动升级或重启 WSL 中的 Harness。交互权限仍需明确选择“允许一次/拒绝”，不会自动授权。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示；Windows 原生安装升级仍需实机验证。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。
