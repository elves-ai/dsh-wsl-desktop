# v0.1.17

## 宠物语音设置

- 将原“语音”设置整合到“设置 → 桌面宠物 → 本地千问语音”，旧入口仍可跳转。
- 模型目录、Python 可执行文件和原生库支持直接浏览当前 WSL 的路径，也保留手动输入。
- 自动发现已保存的 Python、常见 venv / Conda 环境及 PATH 中的解释器，支持下拉选择和重新检测。发现仅检查版本及包元数据，不会安装依赖或加载模型；保存后仍需执行 GPU / ABI / 模型校验。
- 新增显式模型下载：确认目标目录后，从固定 Hugging Face 版本下载两份兼容的 Q8 GGUF，显示已下载字节，支持取消和重新确认后重试。总体积未知时显示不定进度。
- 模型文件经过固定 SHA256 校验后原子发布，不覆盖已有文件；下载与路径校验、模型启动互斥，不自动替换有效配置。

## 桌宠右键菜单

- 菜单完整显示现有操作，无需滚动。
- 保留既有交互安全边界：请求仍需明确选择“允许一次/拒绝”，关闭或收起不代表同意，不会自动授权。
- 移除右键菜单底部素材说明；来源与许可仍保留在宠物设置、对话页及随附文档中。

## 使用与验证边界

- 模型下载只在用户确认后联网，不在后台自动进行，不下载或编译原生库，不安装 Python / ROCm 或其他依赖。推荐使用当前 WSL 用户拥有的非共享目录；目录符号链接不参与浏览。
- 当前语音仍使用 WSL 原生 Q8 / ROCm 与固定参考音色，不回退 CPU、CUDA、Windows 原生推理或系统语音。配置说明见[语音配置文档](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.17/QWEN_SPEECH.md)。
- 已完成前端构建、自动回归测试、真实 Chromium 菜单布局验证和 Windows MSVC 交叉编译检查。下载协议与取消使用小型离线测试文件验证，未实际下载数 GB 模型；真实 Windows 桌宠、声卡播放及不同显示器 / DPI 仍需本机验收。
- 提供 NSIS 安装包、独立 EXE、更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
