# v0.1.15

## 桌宠拖动与性能

- 普通拖动改为直接跟随鼠标抓取点，按约 60Hz 帧预算调度并扣除原生调用耗时；慢调用不堆积过期移动指令，保留抛掷、反弹和弹弓效果。
- 普通拖动将鼠标采样与窗口移动合并为一次专属原生调用；屏幕工作区使用 350ms 缓存，在 DPI、窗口尺寸或当前工作区变化时提前刷新。目标与实际窗口位置一致时跳过重复定位，继续检测松键。
- 修复左右无法贴边：按角色范围限制水平位置，不再把视频两侧透明留白当作角色边界；位置恢复和不同 DPI 下重新夹取沿用相同规则。贴边不会自动收起宠物。

## 气泡与菜单

- 通知、交互气泡和收起入口根据角色锚点、实际内容尺寸及当前可见区域自动定位；空间不足时在现有窗口内调整，尖角跟随，位置变化后同步点击区域。
- 移除底部常驻操作栏、署名条和头顶状态标签；聊天、打开 DSH、动作、置顶、设置和隐藏集中到约 172px 宽的紧凑右键菜单。作者与素材许可信息保留在菜单内。
- 菜单支持关闭按钮、Esc、再次右键、外部左键和失焦关闭，执行操作后自动收起；通过专属原生只读输入状态补充透明区域穿透时的关闭处理。

## 使用与验证边界

- 需要已有的 WSL DSH 环境和 Microsoft WebView2 Runtime；不会安装或升级 WSL 内 DSH，也不会因更新自动启用对话或调用模型。
- 交互气泡仍保留“允许一次/拒绝”及完整参数确认；收起不代表同意，原 DSH 已处理的请求会同步失效。回答或授权可能继续原任务并产生正常模型和工具费用。
- 本地前端与 Rust 自动测试、前端生产构建和浏览器无副作用布局/菜单演示已验证；真实 Windows 拖动手感、CPU/GPU 收益、不同显示器与 DPI、中文输入及安装升级仍需实机确认。标签流水线另执行 Windows MSVC 编译与测试后发布。
- 提供 NSIS 安装包、独立 EXE、更新签名、latest.json 和 SHA256SUMS.txt。更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。
