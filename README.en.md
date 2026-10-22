# DSH · WSL Desktop

[简体中文](<README.md>) | English

A native Windows **Tauri 2 + WebView2** launcher. DSH, Node.js, sessions, and projects continue to run in WSL; the desktop application only controls the service and displays the existing Web interface.

The application UI is still in Simplified Chinese. Instructions below retain the exact Chinese labels, followed by English glosses. Supporting documentation linked here may also be in Chinese.

## Project and downloads

Maintained by Evan Yang as an individual. Project code is licensed under the [MIT license](<LICENSE>); third-party components retain their own licenses.

- [Download and installation guide](<DOWNLOADS.md>)
- [Privacy policy](<PRIVACY.md>)
- [Code signing policy](<CODE_SIGNING.md>): current builds are unsigned. A SignPath Foundation application was submitted on 2026-10-22 and is pending review; approval has not been granted.

## Quick start

### 1. Prepare the prerequisites

- **Windows x64 with WebView2 Runtime**, plus an existing WSL distribution and Linux user. Python 3 and the `ss` command (usually supplied by iproute2) must be available to that user in WSL.
- **An existing DeepSeek Harness checkout inside WSL.** Use Node.js satisfying its `engines.node` requirement and the pnpm version specified by its `packageManager` field. Read the manifest and upstream build instructions for the exact Harness version you use; additional version-specific native/build prerequisites may apply. These are Harness requirements, not the separate Windows launcher build requirements later in this guide.

  ~~~text
  <WSL Harness root>/package.json
  ~~~

- **An existing compatible Python service manager and its Linux JSON configuration. Neither is bundled with or created by this launcher.** Existing users can reuse the legacy setup; a new setup must manually provide the manager, its Linux configuration, and the Windows configuration described under [Configuration](<#configuration>). Creating only the Windows JSON is not enough.

The launcher runs Harness from its source entry. A global npm installation, an ordinary work project, or a Harness subdirectory is not the required Harness root. This selects the Harness application, not the business project you want the AI to edit; choose work projects inside DSH later.

### 2. Prepare a fresh Harness checkout

If you have not cloned Harness, follow the [upstream run-from-source instructions](<https://github.com/deepseek-ai/deepseek-harness#run-from-source>).

If Harness was freshly cloned, run the following manually **in the WSL Harness repository, not this desktop-launcher repository**, using that version’s required Node.js/pnpm and upstream build prerequisites:

~~~bash
cd /absolute/path/to/deepseek-harness
pnpm install
pnpm run build
~~~

The **full build** prepares runtime, native, and client assets as well as the Web application. `pnpm run build:web` alone is not guaranteed to prepare everything required to run Harness. Running backend source through tsx does not remove the need to build a fresh checkout. This step does not build the Windows launcher or an installer. An already prepared installation can skip it; after updating Harness sources, reinstall/rebuild as required by that version. Resolve any installation/build errors before returning to the launcher. The launcher does not install dependencies, clone repositories, or run builds.

### 3. Install and configure the launcher

Download the Windows x64 installer from the [Releases page](<https://github.com/elves-ai/dsh-wsl-desktop/releases>) and follow the [download guide](<DOWNLOADS.md>). Verify the source and checksums; current downloads are unsigned.

- **Existing legacy-launcher users:** the first run imports the old Windows configuration without changing the original. It continues to use the configured WSL manager and Linux configuration.
- **New setups:** manually provide the compatible manager and Linux JSON configuration first, then the Windows configuration in [Configuration](<#configuration>). This launcher is not a manager installer or a standalone Harness bootstrapper.

If needed, open “设置 → 运行环境与项目目录…” (Settings → Runtime environment and project directory), enter the **absolute WSL Harness root**, and click “保存并重新检测” (Save and retry). Do not enter a Windows drive path or WSL UNC path. Directory changes require an idle service and free configured port: if a managed service is starting, wait until it is ready, then stop it through “文件” (File); manage an external service in its original terminal. This saves only `repository` in the **existing** Linux configuration, preserving other fields and file permissions. It checks the project entry, configured Node.js, resolvable/readable `tsx/esm`, and Web build assets; it does not install, clone, or build anything.

~~~text
Example WSL Harness root: /home/your-user/deepseek-harness
Checked project assets:  package.json
                         apps/cli/src/bin.ts
                         apps/web/dist/index.html and referenced local assets
~~~

After manually fixing dependencies or completing the full Harness build, click “重新检测” (Retry). Retry reads the latest configuration; reopening the application is unnecessary. Once checks pass, the launcher reuses a ready service or starts it through the existing manager, polls readiness, verifies Windows loopback access, and opens the DSH WebView automatically.

The runtime chain is:

~~~text
wsl.exe -> existing Python service manager -> configured Node.js

# Run by the manager from the configured Harness repository:
<configured-node> --import tsx/esm apps/cli/src/bin.ts web --no-open --host 127.0.0.1 --port 3080
~~~

Here `3080` is the default; the actual port comes from configuration. The Windows and Linux configurations must agree. The manager supplies its configured state and DSH_HOME environment; its state directory is not DSH_HOME. This runtime is not a pnpm development server or the launcher’s own frontend. Checks must pass before startup, but do not establish that every runtime feature works; consult the manager’s service logs if startup still fails.

## Features

- Imports legacy launcher configuration automatically and reuses the existing WSL Python manager.
- Checks/starts the service and opens DSH in a WebView after confirming Windows can reach it.
- Single application instance and single DSH workspace window; reopening activates the existing window.
- Startup progress, tray icon, start/stop/restart controls, and redacted operation logs.
- The launcher and DSH workspace use a single-row custom title bar: icon, “文件 / 设置 / 帮助” (File / Settings / Help), application title, and window controls share one row. Dropdowns remain native menus, with the same commands and update entry. Drag a blank area to move the window; double-click to maximize/restore. Closing still hides to the tray.
- Closing a window does not stop tasks; “仅退出启动器（保留服务）” (Quit launcher only, keep service) leaves the service running.
- Optional Windows native notifications for background turn completion/failure, with a persistent toggle and test notification; disabled by default.
- “停止服务并退出…” (Stop service and quit) exits only after a successful stop is confirmed. Native confirmations for destructive actions default to “否” (No).
- Silently checks stable GitHub releases at startup without interrupting initialization or opening a dialog automatically. Use “设置 → 检查启动器更新…” (Settings → Check launcher updates) to view updates. Download, signature verification, and installation require manual confirmation and update only the Windows launcher. See [updates and signing-key setup](<UPDATES.md>).

It does not install/upgrade DSH, modify the old launcher, migrate Edge login data, take over all of WSL, or automatically force-kill processes.

## Everyday use

Use the “文件” (File) menu or tray controls:

| Action | Behavior |
| --- | --- |
| Launch the application / “打开 DSH” (Open DSH) | Check the environment, reuse a ready service or start through the manager if needed, wait for readiness and Windows access, then open/activate the workspace. |
| “启动服务” (Start service) | Ensure the configured service is ready; do not launch a duplicate ready instance. |
| “停止服务…” (Stop service) | Ask for confirmation and safely stop a manager-owned service. This interrupts its active tasks and connections, including sessions opened through the legacy launcher; it does not shut down WSL. |
| “重启服务…” (Restart service) | Ask for confirmation, stop the manager-owned service, then start it again; active work/connections are interrupted. |
| Close button | Hide the window to the tray; keep the launcher, service, and background tasks running. Click the tray icon or reopen the app to restore. |
| “仅退出启动器（保留服务）” (Quit launcher only, keep service) | Exit the desktop application and stop its notification checks, leaving the WSL service/tasks running. |
| “停止服务并退出…” (Stop service and quit) | Ask for confirmation, stop safely, and quit only after success. Canceling or a stop failure does not silently force termination. |

“Managed by the launcher” includes a service hosted by the same legacy Python manager, not just one created by the current desktop process. An externally started service is only connected to, not automatically stopped. See [Architecture and security](<#architecture-and-security>) for ownership and authentication safeguards.

## Architecture and security

~~~text
Trusted local control page + native tray -> Tauri Rust -> wsl.exe -> existing Python manager -> WSL DSH
                                                                                                 ^
                                                                     DSH WebView without native IPC
~~~

The initialization window handles only startup progress and error recovery. Once ready, it hides automatically and opens the DSH workspace. Project directory, notifications, updates, and diagnostic logs live in a singleton settings window opened from the menu; switching categories neither reloads the page nor discards unsaved input. Each window’s title bar is a separate trusted local WebView, isolated from its content. Service, notification, and update commands are granted only to the initialization/settings content WebViews. Title bars can invoke only fixed menu commands and their own window operations. Rust validates the view label, parent window, local origin, page path, and parameters. Remote DSH content has no native permissions and receives no injected title-bar script.

Launch URLs must strictly match the configured loopback address and port. Tokens are passed to the WebView only in memory, never sent to the control page or written to operation logs. WSL requests use argument arrays without a shell, with bounded response sizes and timeouts. External links permit only HTTP(S) URLs without a launch token or user information.

The existing manager handles deduplication, readiness detection, identity checks, SIGTERM, and waiting for exit. The embedded [guarded-stop adapter](<src-tauri/helpers/guarded_stop.py>) additionally verifies the expected PID, management lock, and process start time while the original manager holds its operation lock, preventing accidental termination of an unrelated process. It runs through Python’s `-c` argument and does not overwrite the legacy script.

“Managed by the launcher” includes services hosted by the same legacy Python manager, not only instances started by this desktop process. Externally launched services are only connected to, not automatically stopped. A new WebView reports an explicit error if no authentication information is available.

## Configuration

On first run, the launcher imports the old Windows launcher configuration from the location below, leaving the old file unchanged. The Harness directory, Node.js path, and DSH_HOME continue to come from the configured WSL Python manager and Linux configuration. Adapt the distribution, user, and home directory in the examples to your environment.

~~~text
Application configuration: %APPDATA%\io.local.dsh-wsl-desktop\config.json
Operation log:             %APPDATA%\io.local.dsh-wsl-desktop\launcher.log
WebView data:              %LOCALAPPDATA%\io.local.dsh-wsl-desktop\webview
Legacy import source:      %LOCALAPPDATA%\DeepSeekHarnessLauncher\config.json
~~~

### Without a legacy configuration

You must manually provide **both** a compatible existing Python service manager and its Linux JSON configuration. The desktop launcher bundles neither and does not create them. The Windows configuration below merely points to them; copying it alone cannot produce a working setup. Follow your manager’s own setup/schema requirements. The environment check expects the Linux configuration to contain absolute WSL paths for `repository`, `node`, and `state_directory`, plus an integer `port` matching Windows `Port`. Preserve any additional fields required by the manager.

Then place the following Windows JSON at the application-configuration location above:

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

These paths are examples of an existing setup, not files supplied by this project. After editing, click “重新检测” (Retry). Windows and WSL ports must match.

### Windows configuration versus Linux service configuration

Windows `Distribution` and `LinuxUser` select the WSL distribution and user. `LinuxLauncher` points to the existing Python manager; `LinuxConfig` points to the Linux JSON it reads. Confirm distribution names in Windows PowerShell:

~~~powershell
wsl --list --verbose
~~~

A Linux configuration needs at least the following fields. Replace **all example paths**, including the Node.js version, with real WSL locations suitable for your Harness version:

~~~json
{
  "repository": "/home/your-user/deepseek-harness",
  "node": "/home/your-user/.nvm/versions/node/v24.22.0/bin/node",
  "state_directory": "/home/your-user/.local/state/dsh-windows-launcher",
  "port": 3080
}
~~~

To find the currently selected Node.js executable, run as the selected WSL user:

~~~bash
node -p 'process.execPath'
~~~

`repository` is the Harness source root. `state_directory` is the Python manager’s state/log directory, not a business project directory and **not DSH_HOME**. Preserve additional fields such as `home` (corresponding to DSH_HOME) according to your manager’s conventions. The settings UI changes only `repository`; it does not replace Node.js or migrate session data.

This repository does not distribute the legacy Python manager. The JSON examples are configuration, not a substitute for the program. Without a legacy environment, obtain or prepare a compatible manager supporting the `probe` / `run` / `stop` / `logs` protocol first. A built Harness checkout alone cannot be started by this launcher without that manager.

If an nvm/Node.js update invalidates the configured absolute executable path, update the WSL manager’s configuration. The application does not rely on interactive shell initialization.

## Startup environment checks

Startup checks cover WSL, launcher configuration, distribution, Linux user, Python, manager script, WSL service configuration, Harness repository, Node.js, installed dependencies, and Web artifacts. Once all checks pass, the launcher checks/starts the service and opens DSH automatically; there is no Continue button to click.

The initialization view presents only three stages: “检查运行环境 → 准备本地服务 → 打开 DSH” (Check runtime environment → Prepare local service → Open DSH). It does not mix configuration forms, notifications, updates, or service controls into startup. The detailed checklist is collapsed by default. Failures show the cause and recovery guidance with “重新检测” (Retry) and “打开设置” (Open settings). Checks depending on an earlier failure show “等待前置项” (Waiting for prerequisites), rather than cascading errors. Checks do not automatically install, clone, or build anything. Retry rereads the latest configuration without restarting the app.

Open “设置 → 运行环境与项目目录…” (Settings → Runtime environment and project directory), enter the **absolute DSH path inside WSL**, not a Windows path, and click “保存并重新检测” (Save and retry). It validates the project entry and updates only `repository` in the existing Linux service configuration, preserving other fields and permissions, then reruns checks. After passing, DSH opens automatically. Missing manager scripts or Linux configurations must still be prepared manually. Changing directories requires the service to be idle and the configured port free. If a managed service is still starting, wait until ready before stopping it through “文件” (File); handle external services in their original terminal. Saving does not automatically stop or restart an existing service.

### Troubleshooting

- **Missing Windows configuration:** existing users should check the legacy import source above. New users must manually prepare the compatible manager, its Linux configuration, and then the Windows JSON; there is no automatic manager/configuration bootstrap. Confirm the distribution and Linux user are correct.
- **Missing helper, Python, Linux JSON, or `ss`:** verify `LinuxLauncher` and `LinuxConfig` refer to existing readable absolute WSL paths under the selected user. Prepare Python 3 and `ss` manually, and check the manager’s compatibility and configuration schema. Retry never creates or repairs the manager or Linux configuration.
- **“已安装依赖” (Installed dependencies) fails / `tsx/esm` cannot resolve:** run `pnpm install` manually in the **Harness repository in WSL**, using its pinned pnpm and compatible Node.js. For a fresh clone, follow with the full `pnpm run build`, then click “重新检测” (Retry). Installing this launcher’s npm dependencies does not install Harness dependencies.
- **“Web 构建产物” (Web build artifacts) fails:** complete the full Harness `pnpm run build` in WSL and ensure the generated HTML and referenced local assets are readable. A fresh clone or a Web-only build may still lack required runtime/native/client assets; `build:web` alone is not guaranteed sufficient. The asset locations are shown in Quick start.
- **“Node.js” fails, especially after nvm changes:** check the Linux configuration’s absolute `node` path exists, is executable by the selected user, and satisfies Harness `engines.node`. A Node version working in an interactive terminal does not prove the configured path works; shell startup files are not loaded. Match the checkout’s `packageManager` and upstream build prerequisites too.
- **Port mismatch, connection timeout, or external service:** ensure Windows `Port` and Linux `port` match, and Windows can reach the configured loopback service. The default is `3080`. A Windows HTTP `401` can be an expected reachable, authenticated-service response, but an externally launched service may not supply credentials for a new WebView. Use its original terminal’s authentication link; the launcher will not stop it or take ownership automatically. Do not kill an unknown listener just to free the port.
- **Invalid directory or save failure:** use the Harness source root’s absolute WSL path, verify the existing Linux configuration is valid, and ensure the service is idle and configured port free. A successful directory save does not mean dependency and build checks have passed.
- **Startup failure or timeout:** inspect “诊断日志…” (Diagnostic logs) and the original Python manager’s service logs. A timeout does not mean the service has stopped; Retry later rather than starting duplicate manual instances. Passing environment checks is not a full runtime validation. Do not share credentials or authentication links in diagnostics.

## System notifications

Open “设置 → 系统通知设置…” (Settings → System notification settings), enable “后台任务通知” (Background task notifications), and click “发送测试通知” (Send test notification). Preferences are saved separately at the location below; they are not written back to legacy launcher or DSH configuration.

~~~text
%APPDATA%\io.local.dsh-wsl-desktop\notifications.json
~~~

- Notifications appear only when the DSH workspace is not in the foreground. Checks continue after hiding to the tray and stop when the launcher exits.
- Approximately every three seconds, the launcher uses the signed-in workspace WebView’s same-origin authenticated state to query the local read-only session API. It starts no additional service, does not take over permission confirmations or user questions, and gives the DSH page no native IPC.
- Notifications cover normal completion, failures, and waiting for a user choice, answer, or plan confirmation, including nested tool calls inside `run_code`. Cancellations, truncated output, restored historical completion markers, and subagents do not generate success notifications. Notifications use the Windows default sound and contain no question/answer body, error details, project paths, or credentials. “本轮结束” (Turn finished) does not mean the entire long-running goal is complete.
- Blocking questions are inferred from running tool calls and their completion events. A question must remain pending for two consecutive checks before notification, usually about 3–6 seconds, filtering calls that fail quickly or have already been answered. This is read-only state inference, not an exact subscription to question-dialog events. Scheduled questions continue to use the pending-answer projection and filter queued answers. Each question is notified only once; answering or canceling prevents further reminders. The launcher never answers for you.
- On initial connection, reconnection, or re-enabling, execution results only establish a baseline; historical results are not replayed. Still-unanswered questions are checked. Network reconnects within one enabled period do not repeat already-consumed questions; re-enabling can notify a currently unanswered question again. Multiple turns within one polling interval in the same session are merged into the most recent result. Notifications consumed in the foreground are not replayed after switching to the background.
- Verify native notifications with the **installed Windows application**. A successful API call only means submission to Windows, not a guaranteed banner. Check Windows “设置 → 系统 → 通知” (Settings → System → Notifications) and Do Not Disturb. Test notifications do not require Harness to be connected.

Suggested acceptance checks: enable notifications and wait for “正在检查” (Checking), then run background success/failure tasks, ordinary questions, nested questions inside `run_code`, and plan confirmations. Verify pending-answer notifications have sound without duplicates, stop after answering, stay silent in the foreground, do not report cancellation as success, stop when disabled, do not replay historical results on reconnect, and preserve the toggle after restart. WSL/Linux unit tests and cross-compilation do not replace real Windows banner tests.

## Installer appearance

Windows installation/uninstallation wizards use Simplified Chinese without a language-selection dialog. Welcome/finish pages have a dark-blue branded sidebar; other pages have a white header banner. The font is Microsoft YaHei UI. The MIT license retains its original English text. Updates continue to use the existing passive installation flow.

Appearance and text are in [appearance.nsh](<src-tauri/installer/appearance.nsh>); bitmap sources are [sidebar.svg](<src-tauri/installer/sidebar.svg>) and [header.svg](<src-tauri/installer/header.svg>). After changing the source artwork, run `npm run installer:assets` and commit the two generated BMP images. Normal packaging uses the committed bitmaps without depending on system fonts or additional image tools. Changes appear only in newly built installers, not previously downloaded packages.

## GitHub Actions builds (recommended)

The [Windows build workflow](<.github/workflows/windows-build.yml>) runs only when a `v*` version tag is pushed. Ordinary branch pushes, pull requests, and manual dispatch do not trigger it; run tests locally for everyday development.

1. An Ubuntu runner verifies frontend, Rust, and fake-service Python tests.
2. After tests pass, a Windows Server 2022 runner compiles with MSVC, runs Windows unit tests, and creates the x64 NSIS installer.
3. After tests and Windows packaging succeed, signatures are verified and a GitHub Release is created automatically; it is published only after all download assets are uploaded.

Tag builds include a standalone executable, NSIS installer, update signature, version manifest, and checksum list:

~~~text
SHA256SUMS.txt
~~~

Actions artifacts are retained for 30 days and usually require GitHub login. Use the [Releases page](<https://github.com/elves-ai/dsh-wsl-desktop/releases>) for stable downloads; public Release assets are not subject to that 30-day retention period.

The default GitHub Token has `contents:read`; only the tag-release job receives `contents:write`. Tag builds require the update-signing private-key Secret and fail if it is missing, with no unsigned-release fallback. See [initial maintainer setup](<UPDATES.md#发布维护者首次配置>). Third-party Actions are pinned to commit SHAs.

### Publishing a new version

The version tag must match all four metadata files: [package.json](<package.json>), [package-lock.json](<package-lock.json>), [Cargo.toml](<src-tauri/Cargo.toml>), and [tauri.conf.json](<src-tauri/tauri.conf.json>). Both `vX.Y.Z` and `vX.Y.Z-prerelease` are supported. A version mismatch fails before the build. After updating and committing versions, for example:

~~~bash
git tag v0.1.3
git push origin v0.1.3
~~~

The release job first downloads Windows artifacts from the same workflow run and reverifies all asset checksums, update signatures, and the version manifest. It then creates a draft Release, uploads every asset, checks the asset inventory, and finally publishes. Prerelease tags are marked Pre-release and do not replace the latest stable release. A failure may leave a draft that a rerun can resume. Published versions cannot be overwritten: fix the issue and publish a new version rather than moving an old tag. Maintainers should restrict version-tag push permissions.

**Windows code signing is not configured:** SmartScreen may warn; verify the source and SHA256. Build machines do not need your WSL or DSH credentials. CI does not launch the application or connect to/restart services on your computer.

## Local Windows builds (optional)

This section is only for developers building the **Windows launcher**, not users preparing Harness. The Windows build environment needs Node.js 24/npm, the stable Rust MSVC toolchain, Visual Studio C++ Build Tools, the Windows SDK, and WebView2 Runtime. These launcher-build requirements are separate from your WSL Harness version’s Node.js/pnpm requirements.

The [build script](<scripts/Build-Windows.ps1>) only checks tools; it does not automatically install anything or change system configuration. It stages sources in a Windows-local directory to avoid npm/cmd issues with a WSL UNC working directory, without copying Linux dependencies or isolated toolchains.

Run in Windows PowerShell, adapting the example path to your distribution and checkout:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-26.04\home\yangzhe\work\dsh-wsl-desktop\scripts\Build-Windows.ps1"
~~~

On success, the executable and NSIS installer are written to the project’s Windows artifact directory. The script does not execute the installer, start the app, or replace old shortcuts. Build-cache and output locations:

~~~text
Project output: artifacts/windows/
Windows cache: %LOCALAPPDATA%\DSHWslDesktopBuild
~~~

If the sources already reside in a Windows-local directory, you can instead run:

~~~powershell
npm ci
npm run desktop:dev
npm run desktop:build -- --config src-tauri/tauri.local-build.conf.json
~~~

Do not run an ordinary `tauri build` in WSL expecting a Windows application. This project provides no Linux GUI; Linux is used only for editing, pure-logic tests, and cross-target compilation checks.

## Automated verification

The following are developer verification commands for **this launcher**, not the Harness preparation commands in Quick start:

~~~bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
~~~

Frontend tests use Node.js TypeScript stripping; Node.js 24 is recommended. Rust Linux unit tests do not depend on GTK/WebKit. Python tests use a fake helper and do not operate on real services.

The original development environment used project-local isolated Rust/LLVM tools without changing the system PATH. To reproduce the Windows-target source check in that environment:

~~~bash
PATH="$PWD/.tools/bin:$PWD/.tools/cargo/bin:$PATH" CARGO_HOME="$PWD/.tools/cargo" RUSTUP_HOME="$PWD/.tools/rustup" cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
~~~

### Verification boundaries

The [original Chinese README](<README.md#验证边界>) records completed frontend production builds, Rust unit tests, Python stop-ownership tests, and Windows-target source compilation checks. It also records the original WSL service as ready and Windows returning the expected `401` at the same address. The original service was not stopped/restarted and old shortcuts were not replaced. These are recorded development results, not a claim that your environment or this documentation-only change has been tested end to end.

Windows installers are generated by the GitHub Actions Windows runner; rely on the corresponding successful run and actual uploaded assets. A local cross-target `cargo check` does not establish successful linking or packaging. CI compilation/packaging success does not establish end-to-end verification with real WSL and WebView.

Windows acceptance testing still needs to cover initial authentication and persisted login after reopening, streaming responses, background execution after closing, tray restore, single-instance behavior, upload/download, external links and previews, multiple monitors/DPI, cancellation confirmations, stop failures, and refusal to stop external instances. Custom title bars additionally require native checks for menu popup/keyboard selection, edge resizing, dragging, double-click maximize/restore, minimizing, close-to-tray, and ensuring the title bar does not obscure content after display scaling changes. Browser previews and Windows-target source checks do not replace these native acceptance tests.

## Main source files

- [Native lifecycle](<src-tauri/src/desktop.rs>)
- [Native update adapter](<src-tauri/src/desktop_updates.rs>) and [update policy](<src-tauri/src/update.rs>)
- [Configuration import](<src-tauri/src/config.rs>)
- [WSL adapter](<src-tauri/src/backend.rs>)
- [Protocol and credential redaction](<src-tauri/src/protocol.rs>)
- [Local control page](<src/main.ts>)
- [Least-privilege capabilities](<src-tauri/capabilities/launcher.json>)
