# DSH · WSL Desktop

Windows 原生 **Tauri 2 + WebView2** 启动器。DSH、Node、会话与项目继续运行在 WSL，桌面应用只负责服务控制和展示现有 Web 页面。

## 项目与下载

个人维护者：Evan Yang。项目代码采用 [MIT 许可证](<LICENSE>)；第三方组件保留各自许可证。

- [下载与安装说明](<DOWNLOADS.md>)
- [隐私说明](<PRIVACY.md>)
- [Code signing policy](<CODE_SIGNING.md>)：当前构建未签名；已于 2026-10-22 提交 SignPath Foundation 申请，等待审核，尚未获得批准。

## 功能

- 自动导入旧启动器配置，复用现有 WSL Python 管理器。
- 自动检查/启动服务，确认 Windows 可访问后在 WebView 中打开 DSH。
- 单实例、单工作窗口，重复打开唤起原窗口。
- 启动进度、托盘、启动/停止/重启与脱敏操作日志。
- 启动器和 DSH 工作窗口使用单行自定义标题栏：图标、文件 / 设置 / 帮助、软件标题和窗口按钮同一行。菜单下拉仍为原生菜单，功能和更新入口不变；空白区可拖动、双击最大化或还原，关闭按钮仍隐藏到托盘。
- 关窗隐藏到托盘，不停止任务；“仅退出启动器”保留服务。
- 可选 Windows 原生系统通知：后台本轮正常结束／失败提醒、持久化开关与测试通知；默认关闭。
- “停止服务并退出”先确认停止成功再退出；危险操作原生确认框默认选中“否”。
- 启动时静默检查 GitHub 正式版本，不打断初始化、不自动弹窗；从菜单“设置 → 检查启动器更新”查看，手动确认后下载、验签、安装，仅更新 Windows 启动器。详见[更新与密钥配置](<UPDATES.md>)。

不安装/升级 DSH，不修改原启动器，不迁移 Edge 登录数据，不接管整个 WSL，不自动强杀进程。

## 架构与安全

~~~text
可信本地控制页 + 原生托盘 → Tauri Rust → wsl.exe → 原 Python 管理器 → WSL DSH
                                                                        ↑
                                                 无原生 IPC 的 DSH WebView
~~~

初始化窗口只负责启动进度与异常恢复；环境就绪后自动隐藏，进入 DSH 工作窗口。目录、通知、更新和诊断日志集中在菜单打开的单例设置窗口，切换分类不会重载页面或丢失未保存输入。每个窗口的标题栏是单独的可信本地 WebView，与内容区隔离。服务、通知和更新命令只授予初始化与设置内容 WebView；标题栏只有固定菜单和自身窗口操作权限。Rust 校验视图标签、父窗口、本地来源及页面路径和参数；远程 DSH 内容没有原生权限，也不注入标题栏脚本。

启动 URL 必须严格匹配配置的回环地址/端口。token 仅在内存中传给 WebView，不发送给控制页或写入操作日志。WSL 请求使用参数数组，不经过 shell，响应大小和等待时间有上限。外链只允许无启动 token、无用户信息的 HTTP(S) 地址。

旧管理器负责去重、就绪检测、身份校验、SIGTERM 与等待退出。[安全停止适配器](<src-tauri/helpers/guarded_stop.py>)在原管理器持有操作锁时额外核对预期 PID、管理锁和进程启动时间，防止误停外部进程。适配器内嵌在应用中，经 Python 的 -c 参数执行，不覆盖旧脚本。

“由启动器管理”包括同一旧 Python 管理器托管的服务，并非仅本次桌面进程创建的实例。外部手动启动的服务只尝试连接，不自动停止；新 WebView 无认证信息时明确报错。

## 配置

首次运行自动导入旧 Windows 启动器配置（位置见下方），旧文件不变。DSH 目录、Node 路径和 DSH_HOME 继续使用旧配置指定的 WSL Python 管理器与 Linux 配置。下方示例中的发行版、用户和家目录请按实际环境调整。

~~~text
应用配置：%APPDATA%\io.local.dsh-wsl-desktop\config.json
操作日志：%APPDATA%\io.local.dsh-wsl-desktop\launcher.log
WebView 数据：%LOCALAPPDATA%\io.local.dsh-wsl-desktop\webview
旧配置来源：%LOCALAPPDATA%\DeepSeekHarnessLauncher\config.json
~~~

没有旧配置时，在上述新配置位置放置以下内容。修改后点击“重新检测”，Windows 与 WSL 配置端口必须一致。

~~~json
{
  "Distribution": "Ubuntu-26.04",
  "LinuxUser": "yangzhe",
  "LinuxLauncher": "/home/yangzhe/.local/share/dsh-windows-launcher/launcher.py",
  "LinuxConfig": "/home/yangzhe/.local/share/dsh-windows-launcher/config.json",
  "StartupTimeoutSeconds": 120,
  "ProbeTimeoutSeconds": 15,
  "StopTimeoutSeconds": 45,
  "Port": 3080,
  "WindowWidth": 1200,
  "WindowHeight": 800
}
~~~

更新 nvm/Node 后，若原绝对路径失效，需要更新 WSL 管理配置；应用不依赖交互 shell 初始化。

## 启动环境检查

启动时自动检查 WSL、启动配置、发行版、Linux 用户、Python、管理脚本、WSL 服务配置、DSH 项目目录、Node.js、已安装依赖与 Web 产物。全部通过后检查/启动服务并自动打开 DSH，无需点击继续。

初始化画面只展示“检查运行环境 → 准备本地服务 → 打开 DSH”三个阶段，不再混放配置表单、通知、更新及服务控制。详细检查列表默认收起；失败时直接显示异常原因和处理提示，提供“重新检测”和“打开设置”。依赖上游的项目显示“等待前置项”，不连锁全部报错。只检测，不自动安装、克隆或执行构建；重新检测会读取最新配置，无需重开应用。

从菜单“设置 → 运行环境与项目目录”打开设置，填写 **WSL 内的 DSH 绝对路径**（不是 Windows 路径）。点击“保存并重新检测”验证项目入口，只更新已有 Linux 服务配置的 repository 字段，保留其他字段与文件权限；通过后自动进入 DSH。缺少管理脚本或 Linux 配置仍需手动准备。运行时须先通过“文件”菜单停止服务才能改目录，不会自动停止或重启已有服务。

## 系统通知

从菜单“设置 → 系统通知设置”打开通知分类，开启“后台任务通知”，点击“发送测试通知”。设置独立保存在 `%APPDATA%\io.local.dsh-wsl-desktop\notifications.json`，不会回写旧启动器或 DSH 配置。

- 仅在 DSH 工作窗口不处于前台时提醒；关窗隐藏到托盘后仍检查，退出启动器后停止。
- 后台约每 3 秒通过已登录工作 WebView 的同源认证状态调用本机只读会话接口；不启动额外服务、不接管权限确认或用户提问，不给 DSH 页面开放原生 IPC。
- 正常结束、失败，以及等待用户选择、回答问题或确认计划时会提醒；支持 `run_code` 内嵌套调用。取消、输出截断、恢复的历史结束标记及子代理不报成功。通知使用 Windows 默认提示音，不含问题／回答正文、错误详情、项目路径或凭据。“本轮结束”不等于整个长任务目标完成。
- 阻塞问答根据运行中的工具调用及其结束事件判断，连续两次检查仍待处理才提醒，通常约 3–6 秒，过滤很快失败或已回答的调用；这是一种只读状态推断，不是问答弹窗的精确事件订阅。定时问答继续沿用待答投影，并过滤已排队的回答。同一个问题只提醒一次，回答或取消后不再提醒，不会代替用户作答。
- 执行结果在首次连接、重连或重新启用时只建立基线，不补发历史结果；仍待回答的问题会被检查。同一启用周期内网络重连不会重复提醒已消费的问题；重新启用可提醒当前仍待答的问题。同一会话一次检查间隔内多轮执行合并为最近一轮结果，前台已消费的提醒不会在切后台后补发。
- Windows 系统通知需用 **安装后的应用** 验证。调用成功只表示提交给系统，不保证横幅出现；请检查“设置 → 系统 → 通知”以及勿扰模式。测试通知不要求 Harness 已连接。

验收建议：开启后等待状态显示“正在检查”，后台执行正常／失败任务，以及普通问答、`run_code` 内嵌套问答和计划确认；检查待答提醒有音效且不重复、回答后停止提醒、前台静默、取消不报成功、关闭后不提醒、重连不补历史结果、重启后保留开关。WSL/Linux 单测和交叉编译不能替代 Windows 通知横幅实测。

## 安装向导外观

Windows 安装与卸载向导使用简体中文，不再弹出语言选择框；欢迎页和完成页使用深蓝品牌侧栏，其他页面使用白色顶部横幅，字体为微软雅黑 UI。MIT 许可证保留英文原文。更新仍使用原有被动安装流程。

外观与文案位于 [appearance.nsh](<src-tauri/installer/appearance.nsh>)，位图源稿为 [sidebar.svg](<src-tauri/installer/sidebar.svg>) 和 [header.svg](<src-tauri/installer/header.svg>)。修改源稿后运行 `npm run installer:assets`，提交生成的两张 BMP；正常打包直接使用已提交的位图，不依赖系统字体或额外图片工具。修改只会出现在重新构建的安装包中，不会改变已经下载的旧安装包。

## GitHub Actions 构建（推荐）

[Windows build 工作流](<.github/workflows/windows-build.yml>)仅在推送 `v*` 版本标签时运行。普通分支推送、PR 和手动触发均不启动工作流；日常开发请在本地运行测试。

1. Ubuntu runner 验证前端、Rust 和 fake-service Python 测试。
2. 测试通过后，Windows Server 2022 runner 使用 MSVC 编译，执行 Windows 单元测试并生成 x64 NSIS 安装包。
3. 测试和 Windows 打包成功后，验证更新签名并自动创建 GitHub Release，上传完整下载附件后公开。

标签构建包含独立可执行文件、NSIS 安装包、更新签名、版本清单和 SHA256SUMS.txt。Actions Artifacts 保留 30 天，下载通常需要登录 GitHub；正式版本请从 [Releases 页面](https://github.com/elves-ai/dsh-wsl-desktop/releases)下载，公开 Release 附件不受这 30 天保留期限制。

默认 GitHub Token 为 contents:read，仅标签发布 job 获得 contents:write。标签构建需要更新签名私钥 Secret，缺少私钥时直接失败，不回退为无签名发布；配置见[更新说明](<UPDATES.md#发布维护者首次配置>)。第三方 Actions 固定到提交 SHA。

### 发布新版本

版本标签必须匹配四份元数据：[package.json](<package.json>)、[package-lock.json](<package-lock.json>)、[Cargo.toml](<src-tauri/Cargo.toml>)、[tauri.conf.json](<src-tauri/tauri.conf.json>)。支持 vX.Y.Z 和 vX.Y.Z-预发布标识；版本不一致会在构建前失败。修改版本并提交后，例如：

~~~bash
git tag v0.1.3
git push origin v0.1.3
~~~

发布 job 先下载同一次工作流的 Windows 产物，重新验证全部附件校验和、更新签名和版本清单，再创建草稿 Release、上传完整附件、核对附件清单，最后公开 Release。预发布标签会标记为 Pre-release，不取代最新稳定版。失败时可能留下草稿，重跑可继续；已经公开的版本拒绝覆盖，应修复后发布新版本，不移动旧标签。维护者应限制版本标签的推送权限。

**构建未配置代码签名**：Windows SmartScreen 可能警告，请核对来源和 SHA256。构建机不需要你的 WSL 或 DSH 凭据；CI 不启动应用，不会连接或重启你电脑中的服务。

## 本机 Windows 构建（可选）

Windows 端需要 Node.js 24/npm、Rust stable MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK。当前机器已检测到 WebView2 Runtime。

[构建脚本](<scripts/Build-Windows.ps1>)只检查工具，不自动安装或更改系统配置。它把源码暂存到 Windows 本地目录，避免 npm/cmd 的 WSL UNC 工作目录问题；不会复制 Linux 依赖和隔离工具。

在 Windows PowerShell 执行：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-26.04\home\yangzhe\work\dsh-wsl-desktop\scripts\Build-Windows.ps1"
~~~

成功后可执行文件和 NSIS 安装包写入项目的 artifacts/windows/ 目录。脚本不执行安装包、不启动应用、不替换旧快捷方式。Windows 构建缓存位于 %LOCALAPPDATA%\DSHWslDesktopBuild。

如果源码本来在 Windows 本地目录，也可以执行：

~~~powershell
npm ci
npm run desktop:dev
npm run desktop:build -- --config src-tauri/tauri.local-build.conf.json
~~~

不要在 WSL 中执行普通 tauri build 并期待 Windows 应用。本项目不提供 Linux GUI；Linux 仅用于编辑、纯逻辑测试和交叉编译检查。

## 自动验证

~~~bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
~~~

前端测试使用 Node TypeScript stripping，推荐 Node 24。Rust Linux 单测不依赖 GTK/WebKit；Python 测试使用 fake helper，不操作真实服务。

本次开发使用项目内隔离的 Rust/LLVM，未更改系统 PATH。当前环境复现 Windows 目标源码检查：

~~~bash
PATH="$PWD/.tools/bin:$PWD/.tools/cargo/bin:$PATH" CARGO_HOME="$PWD/.tools/cargo" RUSTUP_HOME="$PWD/.tools/rustup" cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
~~~

### 验证边界

已完成前端生产构建、Rust 单测、Python 停止归属测试与 Windows 目标源码编译检查。已确认原服务 WSL ready、Windows 同地址返回预期的 401。原服务没有被停止/重启，旧快捷方式没有被替换。

Windows 安装包由 GitHub Actions 的 Windows runner 生成，以对应运行的成功状态和实际上传产物为准。本机交叉 cargo check 不代表链接、打包成功；CI 的编译/打包成功也不代表真实 WSL + WebView 已完成端到端验证。

Windows 验收还需覆盖：首次认证及重开登录状态、流式响应、关窗后台运行、托盘恢复、单实例、文件上传/下载、外链与预览、多显示器/DPI，以及确认取消/停止失败/拒绝外部实例等流程。自定义标题栏另需实测原生菜单弹出与键盘选择、边缘缩放、拖动、双击最大化 / 还原、最小化、关闭隐藏到托盘，以及缩放比例变化后标题栏不遮挡内容；浏览器预览和 Windows 目标源码检查不能替代这些原生验收。

## 主要代码

- [原生生命周期](<src-tauri/src/desktop.rs>)
- [原生更新适配](<src-tauri/src/desktop_updates.rs>)与[更新策略](<src-tauri/src/update.rs>)
- [配置导入](<src-tauri/src/config.rs>)
- [WSL 适配](<src-tauri/src/backend.rs>)
- [协议与凭证脱敏](<src-tauri/src/protocol.rs>)
- [本地控制页](<src/main.ts>)
- [最小权限](<src-tauri/capabilities/launcher.json>)
