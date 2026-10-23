# v0.1.14

## 发布修复

- 固定跨平台检出规则，防止 Windows CRLF 转换改写上游代码和许可证字节；新增启用 core.autocrlf 的真实 Git 检出回归测试。
- 修复 Windows 保存桌宠偏好时遇到短暂文件占用直接失败的问题：只在有限范围内重试原子替换，保留旧文件保护，不删除或截断原设置。增加真实 Win32 共享冲突、重试边界及完整字节并发读取回归。
- v0.1.12、v0.1.13 标签分别在 Windows 素材和并发保存校验失败，均未发布安装包；保留标签以便审计，本版包含全部新功能。

## 新增

- 新增“鲸鱼娘”桌面宠物，复用 dsh-pet 的 106 个原始动画与动作/漫游物理；支持标题栏入口、显示/启动显示/漫游开关和本次运行置顶切换。
- 新增轻量对话面板，连接真实 DSH Workspace/Session，支持流式输出、历史切换、停止任务及打开原会话。
- 接入任务完成、失败和待回答气泡。桌宠显示时不再重复发送 Windows 通知；桌宠隐藏时按系统通知设置提醒。
- 在气泡内完成单选、多选、文字回答和计划确认。权限请求可查看完整参数并选择“允许一次/拒绝”；缺少完整详情时禁止允许，可转到 DSH 处理。
- 待处理交互不会自动消失；收起不等于同意或取消。原 DSH 已处理的请求会同步失效，结果不明时只读重连，不自动重发授权。

## 使用与验证边界

- 需要已有的 WSL DSH 环境和 Microsoft WebView2 Runtime；不会自动安装或升级 WSL 内 DSH。回答/授权可能继续原任务并产生正常模型和工具费用。
- 已通过本地前端、Rust、Python 自动测试、Windows 目标源码检查及浏览器无副作用布局演示；真实 Windows 输入/IME、审批竞争和安装升级仍需按环境实机验证。
- 提供 NSIS 安装包、独立 EXE、更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。
