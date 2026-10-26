# v0.1.31

## 修复桌宠朗读

- 修复手动朗读已取消或中断回合的可见回复时，后续相同终态刷新会误停语音生成的问题；普通元数据刷新不再打断该次朗读。
- 对话状态变化导致朗读停止时显示说明，不再只有生成提示消失。新消息、待确认、断连、隐藏、会话切换及显式停止的取消保护保持不变，不取消 DSH 任务。
- 合成或播放失败时保留气泡内的错误提示，不再随普通阅读计时自动收起；可点击朗读重试，或主动关闭。原回复正文不受影响。

## 验证与使用边界

- 新增重复终态快照、正常刷新、新取消状态及错误气泡保留的回归测试；本地 922 项前端测试与生产构建通过。
- 在 RX 9070 XT / ROCm0 已运行服务上验证了真实非静音语音合成、指定请求取消及后续请求恢复；这不等于 Windows WebView2 到声卡的端到端播放验收。
- 更新不会自动升级或重启 WSL 中的 Harness，不自动开启语音或记忆扩展。更新后请重新测试手动朗读；如仍无声，请提供保留下来的错误提示。
- 提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

- 交互权限请求仍需明确选择“允许一次/拒绝”；显示宠物或开始朗读不代表授权。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
