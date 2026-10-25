# v0.1.27

## 修复本地语音依赖安装

- 修复 AMD ROCm 10.1.0 元包仅提供源码归档、被旧版“仅接受 wheel”规则拒绝，导致“AMD 官方 ROCm 开发依赖安装失败”的问题。仅对 `rocm` 元包开放源码构建，SDK 核心、库、开发组件和 gfx1201 设备依赖仍限定官方固定版本 wheel。
- 元包构建前单独准备固定版本 setuptools，不混用 SDK 下载索引，不修改系统 GPU 驱动。安装仍需显式点击，支持失败重试，不自动加载模型或开启朗读。
- 本地语音页面明确显示语音模型 **Qwen3-TTS-12Hz-1.7B-Base**、音频编解码模型 **Qwen3-TTS-Tokenizer-12Hz**，两者均为 **GGUF · Q8_0**，不再只显示“Q8 模型”。

## 统一宠物目录初始化入口

- 开启显示桌宠时自动准备固定的 WSL 宠物工作目录并连接专属会话；设置 → 桌面宠物 → 对话工作目录增加“初始化宠物目录”，可手动初始化或修复目录。
- 未初始化、目录丢失或绑定失效时，气泡和对话面板引导前往设置初始化；菜单“启用与历史”改为“对话历史”，不再在对话面板中重复确认目录。
- 重复初始化保留已有目录内容和有效会话，不发送消息、不调用付费模型；普通重连、重试和发送不会静默重建丢失目录或项目。旧自定义目录及历史不搬移、不删除，前端不能传入任意初始化路径。

## 使用与验证边界

- 修复取消安装回归测试读取进程状态时的竞争：子进程被系统回收视为已停止，仍存活的子进程继续判定失败，避免 CI 偶发报错。
- 交互权限请求仍需明确选择“允许一次/拒绝”；显示宠物、初始化目录或关闭气泡均不代表授权，不会自动执行待确认请求。
- 已在本机 Ubuntu 26.04 / Python 3.14.4 / RX 9070 XT 环境执行修正后的依赖安装、gfx1201 原生库编译与两份模型校验，生产检测器确认真实 GPU 运算、原生 ABI 和模型检查通过。该 WSL 检测不等于 Windows Tauri 页面操作、应用内配置保存或声卡播放验收；其他 GPU/驱动组合及 NVIDIA CUDA 实机验收仍待完成。
- 安装此版 Windows 应用后才会更新界面与内置安装脚本；更新不会自动安装、升级或重启 WSL 中的 Harness，不自动开启朗读或记忆扩展。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
