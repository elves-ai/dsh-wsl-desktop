# v0.1.23

## 桌宠弹弓开关与固定工作目录

- 设置页和桌宠右键菜单新增“允许弹弓”，共用本机偏好并同步保存，默认开启。关闭后立即取消蓄力或弹射，不影响普通拖拽、甩抛和漫游。
- 宠物对话工作目录固定为 `~/.dsh-wsl-desktop/assistant`，只读展示，不再提供自定义目录入口。旧自定义绑定停用后需重新确认启用默认目录；旧目录、Workspace/Session 及其历史不搬移、不删除，聊天记录仍由 DSH 保存。

## 本地语音分步安装

- 先只读检查 WSL、Python、系统构建工具与 GPU 桥接；缺依赖时提供处理提示和 Ubuntu/Debian 可复制安装命令，由用户在 WSL 终端执行后重新检查，不自动执行管理员命令或修改系统显卡驱动。
- 环境就绪后显式安装语音组件，自动继续下载并校验固定模型，通过检测才保存配置。支持阶段进度、取消和失败重试；打开设置或刷新不会安装，安装完成不自动加载模型或开启朗读。CUDA0 优先、ROCm0 次之，不回退 CPU；支持范围见[本地语音说明](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.23/QWEN_SPEECH.md)。

## 内置三连敲盆通知音

- 提示音统一使用程序内置的“不锈钢饭盆三连敲”（1.65 秒），由系统通知开关控制，沿用 Windows 系统声音会话的音量与静音，无需外部音频文件。
- 桌宠显示时不弹 Windows 通知卡片，系统通知开启时仍播放提示音；隐藏时卡片自身静音，避免双播。关闭气泡不关闭提示音；应用单独播放的音效不保证随 Windows 勿扰横幅策略一起被抑制。

## 使用与验证边界

- 交互请求仍需明确选择“允许一次/拒绝”；关闭、收起、安装组件或重新启用默认工作目录均不代表工具授权，不自动执行请求。
- 自动测试与 Windows 目标源码检查不等于 Windows 实机验收；透明窗口、弹弓交互、通知音、安装取消重试与真实朗读仍需实机验证，NVIDIA CUDA 编译和 Q8 合成尚未完成实机验收。
- Windows 应用更新不会自动安装、升级或重启 WSL 中的 Harness，不会激活宠物记忆扩展。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
