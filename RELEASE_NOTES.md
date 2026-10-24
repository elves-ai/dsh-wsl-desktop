# v0.1.18

## 修复语音设置闪烁和操作被打断

- 修复宠物语音设置每隔 2.5 秒在“可操作”和“暂停资源选择”之间切换的问题：只读状态刷新不再触发资源操作锁。
- 后台刷新期间，Python 下拉选择、模型与原生库路径浏览、路径草稿及模型下载确认框保持稳定，不再被刷新关闭或禁用。
- 保存、检测、启动和模型下载可安全让后台刷新让出执行机会，不再因慢速状态请求误报“另一项操作正在进行中”。迟到的刷新结果或错误不会覆盖较新的操作状态。
- 保留真实检测、模型启动、下载及服务归属的互斥保护；外部服务不会被接管或停止，退出时仍等待只读请求安全结束。

## 验证与使用

- 新增连续刷新、真实前端组件联动、路径选择与下载确认保留、后台请求抢占及迟到结果隔离的回归测试。
- 本地前端构建、前端回归、Rust 核心测试及 Windows MSVC 交叉检查通过。真实 WSL / GPU 测试仍为显式启用项目，不将自动测试等同于 Windows 桌面和音频设备的人工验收。
- 模型下载仍须用户确认，不自动安装 Python / ROCm 或编译原生库，不更改已有有效配置。配置说明见[语音配置文档](https://github.com/elves-ai/dsh-wsl-desktop/blob/v0.1.18/QWEN_SPEECH.md)。
- 交互请求仍需明确选择“允许一次/拒绝”；关闭或收起不代表同意，不会自动授权。
- 提供 NSIS 安装包、独立 EXE、更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
