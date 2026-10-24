# v0.1.16

## 桌宠原位对话

- 在桌宠气泡中直接输入、发送和重试，无需另开对话窗口；沿用当前绑定会话，不开放项目或会话配置权限。
- 输入时才获取焦点，关闭输入或隐藏桌宠后释放；气泡、菜单和输入区域按实际可见空间定位，保留原有拖动与动作交互。
- 交互请求仍需明确选择“允许一次/拒绝”；关闭或收起不代表同意，不会自动授权。

## 本地 Qwen 朗读与语音设置

- 新增“设置 → 语音”：配置 WSL 模型目录、Python 解释器与原生推理库，检测真实 ROCm GPU 计算、原生 ABI 和两份模型文件校验值。
- 分别显示环境、模型文件、服务、模型加载与托管归属状态；支持启动、固定音色试听、取消检测、停止并释放显存。
- 模型只在 WSL 使用原生 Q8 / ROCm 推理。保留已确认的参考音色及完整参考台词，不回退 CPU、Windows 原生推理或系统语音。
- 自动朗读默认关闭，与桌宠右键菜单共用原生偏好；支持独立音量和一次性迁移已有 Qwen 自动朗读选择，不继承旧系统语音开关。
- 停止、隐藏、切换会话和关闭试听会作废旧请求及迟到音频；只管理自己托管的服务，不接管或按端口猜测并终止外部进程。

## 安装与验证边界

- 模型权重、ROCm SDK、Python 环境和原生推理库仍需单独准备，不随安装包捆绑或自动下载；仅随软件提供小型安全桥、管理代码及已批准的合成参考音频。运行说明见[语音配置文档](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.16/QWEN_SPEECH.md)。
- 已完成本机自动测试、前端生产构建，以及真实 AMD GPU 的环境校验、托管启动、模型加载、合成、停止和释放流程联调。Windows 标签流水线另执行前端与 Rust 测试、MSVC 编译和 NSIS 打包。
- 自动测试和服务联调不等于真实 Windows 桌宠窗口、声卡播放权限、不同显示器/DPI 或安装升级的人工验收；首次使用仍需检查本机运行环境和音频权限。
- 提供 NSIS 安装包、独立 EXE、更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
