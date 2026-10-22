# DSH · WSL Desktop

Windows 原生 **Tauri 2 + WebView2** 启动器。DSH、Node、会话与项目继续运行在 WSL，桌面应用只负责服务控制和展示现有 Web 页面。

## 项目与下载

个人维护者：Evan Yang。项目代码采用 [MIT 许可证](<LICENSE>)；第三方组件保留各自许可证。

- [下载与安装说明](<DOWNLOADS.md>)
- [隐私说明](<PRIVACY.md>)
- [Code signing policy](<CODE_SIGNING.md>)：当前构建未签名；已于 2026-10-22 提交 SignPath Foundation 申请，等待审核，尚未获得批准。

## 第一版

- 自动导入旧启动器配置，复用现有 WSL Python 管理器。
- 自动检查/启动服务，确认 Windows 可访问后在 WebView 中打开 DSH。
- 单实例、单工作窗口，重复打开唤起原窗口。
- 启动进度、托盘、启动/停止/重启与脱敏操作日志。
- 关窗隐藏到托盘，不停止任务；“仅退出启动器”保留服务。
- “停止服务并退出”先确认停止成功再退出；危险操作原生确认框默认选中“否”。

不安装/升级 DSH，不修改原启动器，不迁移 Edge 登录数据，不接管整个 WSL，不自动强杀进程。

## 架构与安全

~~~text
可信本地控制页 + 原生托盘 → Tauri Rust → wsl.exe → 原 Python 管理器 → WSL DSH
                                                                        ↑
                                                 无原生 IPC 的 DSH WebView
~~~

本地控制页与 DSH 是两个独立窗口。只有本地控制页获得命令权限，Rust 还校验窗口标签和页面来源。DSH 页面不能直接执行本机命令。

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

没有旧配置时，在上述新配置位置放置以下内容。修改后重新启动应用，Windows 与 WSL 配置端口必须一致。

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

## GitHub Actions 构建（推荐）

[Windows build 工作流](<.github/workflows/windows-build.yml>)在推送 main、推送 v 开头标签或创建面向 main 的 PR 时运行，也支持手动触发。

1. Ubuntu runner 验证前端、Rust 和 fake-service Python 测试。
2. 测试通过后，Windows Server 2022 runner 使用 MSVC 编译，执行 Windows 单元测试并生成 x64 NSIS 安装包。
3. 普通 main、PR 和手动构建上传 Artifacts；推送版本标签时，在测试和 Windows 打包成功后创建 GitHub Release 并上传长期下载附件。

每份产物包含独立可执行文件、NSIS 安装包和 SHA256SUMS.txt。Actions Artifacts 保留 30 天，下载通常需要登录 GitHub；正式版本请从 [Releases 页面](https://github.com/elves-ai/dsh-wsl-desktop/releases)下载，公开 Release 附件不受这 30 天保留期限制。

默认 GitHub Token 为 contents:read，仅标签发布 job 获得 contents:write；PR、main 和手动构建不会发布 Release。不需要额外仓库 Secrets，第三方 Actions 固定到提交 SHA。

### 发布新版本

版本标签必须匹配四份元数据：[package.json](<package.json>)、[package-lock.json](<package-lock.json>)、[Cargo.toml](<src-tauri/Cargo.toml>)、[tauri.conf.json](<src-tauri/tauri.conf.json>)。支持 vX.Y.Z 和 vX.Y.Z-预发布标识；版本不一致会在构建前失败。修改版本并提交后，例如：

~~~bash
git tag v0.1.0
git push origin v0.1.0
~~~

发布 job 先下载同一次工作流的 Windows 产物并重新验证全部 EXE 校验和，再创建草稿 Release、上传三个附件、核对附件清单，最后公开 Release。预发布标签会标记为 Pre-release，不取代最新稳定版。失败时可能留下草稿，重跑可继续；已经公开的版本拒绝覆盖，应修复后发布新版本，不移动旧标签。维护者应限制版本标签的推送权限。

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
npm run desktop:build
~~~

不要在 WSL 中执行普通 tauri build 并期待 Windows 应用。本项目不提供 Linux GUI；Linux 仅用于编辑、纯逻辑测试和交叉编译检查。

## 自动验证

~~~bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_guarded_stop.py -v
~~~

前端测试使用 Node TypeScript stripping，推荐 Node 24。Rust Linux 单测不依赖 GTK/WebKit；Python 测试使用 fake helper，不操作真实服务。

本次开发使用项目内隔离的 Rust/LLVM，未更改系统 PATH。当前环境复现 Windows 目标源码检查：

~~~bash
PATH="$PWD/.tools/bin:$PWD/.tools/cargo/bin:$PATH" CARGO_HOME="$PWD/.tools/cargo" RUSTUP_HOME="$PWD/.tools/rustup" cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
~~~

### 验证边界

已完成前端生产构建、Rust 单测、Python 停止归属测试与 Windows 目标源码编译检查。已确认原服务 WSL ready、Windows 同地址返回预期的 401。原服务没有被停止/重启，旧快捷方式没有被替换。

Windows 安装包由 GitHub Actions 的 Windows runner 生成，以对应运行的成功状态和实际上传产物为准。本机交叉 cargo check 不代表链接、打包成功；CI 的编译/打包成功也不代表真实 WSL + WebView 已完成端到端验证。

Windows 验收还需覆盖：首次认证及重开登录状态、流式响应、关窗后台运行、托盘恢复、单实例、文件上传/下载、外链与预览、多显示器/DPI，以及确认取消/停止失败/拒绝外部实例等流程。

## 主要代码

- [原生生命周期](<src-tauri/src/desktop.rs>)
- [配置导入](<src-tauri/src/config.rs>)
- [WSL 适配](<src-tauri/src/backend.rs>)
- [协议与凭证脱敏](<src-tauri/src/protocol.rs>)
- [本地控制页](<src/main.ts>)
- [最小权限](<src-tauri/capabilities/launcher.json>)
