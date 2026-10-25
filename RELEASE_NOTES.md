# v0.1.21

## 设置与桌宠菜单

- 统一设置页与桌宠菜单的字体、间距、控件、焦点和状态样式；设置页采用石墨灰布局，桌宠菜单采用紧凑浅色浮层。优化窄窗口导航、长路径和菜单滚动，不改变原有授权及确认流程。
- 调整桌宠菜单操作分组，明确显示自动朗读、置顶的异步状态与失败提示，保留动作选择和上游署名。

## 默认语音环境

- 本地语音仅使用当前 WSL 用户的 ~/.dsh-wsl-desktop/speech/runtime/venv/bin/python；移除 Python 路径选择和自动环境发现。初始化为显式离线操作，仅检查、复用或创建默认环境。
- 旧配置中的外置 Python 不再执行；保留模型与原生库选择，提示重新初始化默认环境。读取配置本身不覆盖原文件，不自动安装依赖、加载模型或开启朗读。
- 在原生端与 WSL helper 分层验证默认路径，拒绝其他用户目录或非默认解释器，补充旧配置与运行时回归测试。

## 通知音效

- 桌宠可见时不创建 Windows 通知卡片或通知中心记录；系统通知开启时仍播放系统提示音，气泡开关不影响这一路音效。
- 桌宠隐藏时沿用 Windows 通知卡片及其音效，不额外双播。提示音遵循系统通知总开关、前台静默与聚焦提醒设置；切换显隐不重放历史事件。

## 使用与验证边界

- 交互请求仍需明确选择“允许一次/拒绝”；关闭、收起或选择路径都不代表授权，不自动执行请求。

- 发布前运行前端、Python、Rust 回归、生产前端构建和 Windows MSVC 目标源码检查；发布流水线再次验证并构建 Windows 安装包。自动测试和交叉编译不等于 Windows 实机安装、透明窗口焦点或真实 GPU 推理验收。
- CUDA / ROCm 驱动、运行库、匹配的原生库及模型仍需另行准备；不提供 CPU 或系统音色生产回退。旧外置 Python 用户需显式初始化默认语音环境并准备依赖后再保存、检测。
- 配置步骤见[本地语音说明](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.21/QWEN_SPEECH.md)。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
