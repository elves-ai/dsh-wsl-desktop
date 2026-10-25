# v0.1.20

## 发布兼容性修复

- 修复默认 umask 为 0002 或基础 Python 激活模板带组写权限时，离线虚拟环境未能通过安全校验的问题。仅为 venv / ensurepip 子进程设置私有 umask；对受控子进程新生成的受管输出，逐级钉住目录与文件句柄、拒绝符号/硬链接并核对所有者后收紧写权限。不修改父进程 umask、外部环境或既有用户目录，已有不安全树仍先拒绝。
- 新增在组可写 umask 下创建真实离线虚拟环境的回归条件；保留全部 CUDA、系统路径选择、统一目录与离线初始化改动。v0.1.19 标签的构建未通过且未发布资产，本版不改写旧标签。

## CUDA 与 ROCm 本地语音

- 接入 NVIDIA CUDA 原生 Q8 推理，保留 AMD ROCm。自动模式先验证 CUDA0，再尝试 ROCm0；支持外部 CLI 显式指定设备，不回退 CPU 或其他显式设备。
- CUDA 使用独立子进程执行 NVIDIA Driver API 分配、拷贝和 cuBLAS 矩阵计算，检查结果及资源释放后才报告计算就绪；设备和实际加载的原生后端必须匹配。
- 根据显卡类型显示对应的 CUDA / ROCm 环境要求，区分 Python 版本、缺少运行库、检测失败与未识别显卡，不再统一误报缺少 ROCm。
- 增加 CUDA 原生构建选项及独立构建目录，严格检查固定源码/子模块版本并隔离后端缓存；不隐式下载依赖、源码或模型。

## 系统路径选择与统一数据目录

- 设置中的模型目录、Python、原生库和 Harness 项目目录，以及首次配置的项目和 Node.js 路径，均改为只读展示与 Windows 原生文件/目录选择弹窗，取消选择不改变草稿。
- 选择器定位已配置 WSL 发行版的 UNC 目录并返回 WSL 绝对路径，拒绝其他发行版和直接 Windows 主机路径，保留隐藏目录可见、忙碌锁及过期结果保护。已有 Python 环境下拉保留为快捷选择。
- WSL 数据统一以 `~/.dsh-wsl-desktop/` 为根：默认助手工作目录为 assistant，语音模型、运行环境和托管服务位于 speech。已有显式路径、虚拟环境和已绑定对话不自动搬迁或覆盖。
- 新增显式“初始化语音环境”：优先复用已有 Python / CUDA / ROCm 环境，否则使用已安装 Python 离线创建虚拟环境和本地路径配置；不会安装系统组件、联网 pip、加载模型、开启自动朗读或替换已验证设置。
- 修复刷新时助手引导状态覆盖已选目录的问题，以及先启用默认助手目录时数据根权限不匹配、导致后续语音初始化失败的问题；不更改已有自定义目录权限。模型下载仍需用户确认，并校验固定 SHA256。

## 验证与使用边界

- 本地前端、Python、Rust 回归测试、生产前端构建与 Windows MSVC 目标编译检查通过；发布流水线将再次执行 Linux / Windows 检查并构建安装包。
- CUDA 正向路径已通过模拟测试，无 NVIDIA 实机推理验收；Windows 系统选择弹窗的真实交互与桌宠音频播放仍需人工验收，不将编译和模拟测试等同于实机通过。
- CUDA / ROCm 驱动、运行库、匹配的原生库及模型仍需另行准备。自动模式优先 CUDA 时，所选原生库也必须是 CUDA 构建。更新后请停止旧托管服务并重启应用；旧服务运行记录不迁移。
- 交互请求仍需明确选择“允许一次/拒绝”；关闭、收起或选择路径都不代表授权，不自动执行请求。
- 配置步骤见[本地语音说明](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.20/QWEN_SPEECH.md)。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
