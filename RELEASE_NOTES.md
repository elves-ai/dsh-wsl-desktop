# v0.1.22

## 宠物人格与长期记忆首版

- 设置 → 桌面宠物新增默认关闭的人格与长期记忆管理，支持名字/语气、分页搜索、手动新增、纠正、确认后忘记及来源查看；明确说明资料会发送给当前 DSH 模型，忘记不删除 DSH 原始历史。
- 新增私有 WSL SQLite 记忆存储和非默认 `desktop-pet` Agent 扩展源码，仅用于宠物专属对话；普通 DSH 任务即使处于同一项目，也不读取或写入宠物记忆，不改变其人格、模型参数、预算或工具权限。
- 显式“记住：…”内容可在同一宠物范围的新会话中检索；当前资料替换旧提示快照，模型调用前按已路由窗口、输出上限、完整上下文与工具定义检查估算预算。扩展不自动安装或启用，不修改现有 Harness profile、普通 Agent 或旧会话。
- 本阶段不提供自动滚动摘要、模型推断式归纳或持久提取任务补偿；崩溃前尚未完成的记忆写入可能丢失。扩展安装及限制见[说明](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.22/harness/pet-memory/README.md)。

## 本地语音一键安装

- 以“一键安装”统一准备默认 WSL 目录下的 Python 环境、GPU 依赖、原生库与固定模型，并在检测通过后保存配置；不再要求手选路径或单独保存。
- 提供真实阶段、下载进度、取消和失败重试；安装不修改系统显卡驱动，不自动加载模型或开启朗读，失败保留已有有效配置。仅管理本应用托管的服务，不接管外部服务。
- CUDA0 优先、ROCm0 次之，不提供 CPU 或系统音色生产回退；支持范围与安装告知见[本地语音说明](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.22/QWEN_SPEECH.md)。

## 桌宠设置、菜单与气泡

- 设置页展示当前实际绑定的 WSL 对话工作目录，支持安全打开，不自动创建或迁移目录，也不把工作目录当作聊天记录存储。
- 优化桌宠动作二级菜单、交互卡片、通知气泡和正文可读性，任务标题与描述分开显示；长内容可滚动，确认和权限参数仍完整呈现。
- 修正输入框预留与角色锚点之间的气泡定位，避免短回复因额外留白覆盖角色头部；不缩放角色、不扩大原生窗口。

## 使用与验证边界

- 交互请求仍需明确选择“允许一次/拒绝”；关闭、收起、安装扩展或启用记忆均不代表工具授权，不自动执行请求。
- 发布流水线运行前端、Python、Rust 及独立记忆插件测试，再构建 Windows x64 NSIS 安装包。真实 Harness 记忆隔离和 SQLite 闭环另经离线集成验证，未为验证发起付费模型调用。自动测试不等于 Windows 实机透明窗口、输入法、安装或 GPU 推理验收。
- Windows 应用更新不会自动安装、升级或重启 WSL 中的 Harness，不会激活宠物记忆扩展。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
