# v0.1.30

## 修复桌面端卡死

- 将 WebView2 登录状态读取改为原生异步回调，移除同步 Cookie getter 引入的 UI 嵌套消息循环，修复启动或运行时按钮有点击效果、原生操作却不执行的问题。
- 登录状态读取只在后台线程等待，最多等待 5 秒；读取失败或超时后返回明确错误，迟到回调不会阻塞 UI 或触发重复操作。
- 保留按本机服务端口区分的认证 Cookie 名称，仅读取精确匹配项的值；注册与回调完成时均校验工作页面来源，凭据不交给页面、不写入日志。

## 修复托盘恢复窗口

- 托盘“打开 DSH”、左键图标与重复启动统一使用显式窗口恢复逻辑。已有就绪或忙碌中的工作窗口直接恢复，不重新检测或加载页面。
- 首次配置或启动操作进行中、且尚无工作窗口时，先显示启动器，避免点击托盘后没有可见窗口；自动启动防抢焦点与服务控制的确认规则保持不变。

## 使用与验证边界

- 本版保留 v0.1.29 的宠物语音首段切分、顺序预生成和取消保护等优化。
- 新增 Cookie 精确选择、超时、迟到回调和错误处理的执行型测试，以及窗口恢复状态矩阵回归；Linux 测试与 Windows 目标类型检查不替代新安装包的 WebView2 冷启动、并发读取和托盘恢复实机验收。
- 更新不会自动升级或重启 WSL 中的 Harness，不会自动开启语音或记忆扩展。提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt；更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。
- 交互权限请求仍需明确选择“允许一次/拒绝”；打开窗口、显示宠物或读取登录状态均不代表授权。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
