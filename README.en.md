# DSH · WSL Desktop

[简体中文](<README.md>) | English

A native Windows **Tauri 2 + WebView2** application. DSH, Node.js, sessions, and projects continue to run in WSL. The app controls the service, displays the existing Web workspace, and provides an optional desktop pet and lightweight conversation panel. The development assistant uses an explicitly confirmed independent WSL directory and the same DSH sessions; see the [implementation and validation notes](<ASSISTANT.md>). Windows runtime and live model integration still require qualification.

The application UI is still in Simplified Chinese. Instructions below retain the exact Chinese labels, followed by English glosses. Supporting documentation linked here may also be in Chinese.

## Project and downloads

Maintained by Evan Yang as an individual. First-party code is licensed under the [MIT license](<LICENSE>); third-party code and assets retain their own terms.

Pet code and animations originate from PC2005-cloud’s [dsh-pet](<https://github.com/PC2005-cloud/dsh-pet>). Code is MIT; animation assets allow open-source use but **prohibit commercial use**. Derivative/modified/reskinned works must include this original-author GitHub URL everywhere they are introduced, displayed, or distributed. See [provenance and notices](<third-party/dsh-pet/UPSTREAM.md>). The assistant reuses all 106 original animations and upstream selection/physics code, with Tauri-native window adaptation and no Electron runtime.

- [Download and installation guide](<DOWNLOADS.md>)
- [Privacy policy](<PRIVACY.md>)
- [Local Qwen narration setup](<QWEN_SPEECH.md>): Settings → 桌面宠物 (Desktop pet) → 本地千问语音 uses external WSL Q8 GGUF models, selecting CUDA0 first, then ROCm0. CUDA has an independent Driver + cuBLAS real-compute probe; there is no CPU fallback and NVIDIA hardware acceptance testing is pending. Model/Python/native-library paths are read-only and selected through Windows native `IFileOpenDialog`, not manual entry or a custom browser; results become paths in the selected WSL distribution, rejecting Windows-host and other-distribution paths. Dependencies and native libraries must be prepared externally; model downloads require explicit confirmation. Detection, status, start/audition/stop and GPU-memory release are available; automatic narration defaults off, with volume shared with the pet menu. External services are not taken over, and Windows runtime acceptance remains separate.
- [Code signing policy](<CODE_SIGNING.md>): current builds are unsigned. A SignPath Foundation application was submitted on 2026-10-22 and is pending review; approval has not been granted.

## Quick start

### 1. Prepare the prerequisites

- **Windows x64 with WebView2 Runtime**, plus an existing WSL distribution and Linux user. That user must be able to run `/usr/bin/python3` (Python >= 3.9) and `ss` (usually supplied by iproute2) in WSL. The bundled manager also requires Linux `pidfd` support (WSL 2 is recommended); first-run deployment checks this read-only and refuses to save configuration or fall back to unsafe PID signalling when unavailable.
- **An existing DeepSeek Harness checkout inside WSL.** Use Node.js satisfying its `engines.node` requirement and the pnpm version specified by its `packageManager` field. Read the manifest and upstream build instructions for the exact Harness version you use; additional version-specific native/build prerequisites may apply. These are Harness requirements, not the separate Windows launcher build requirements later in this guide.

  ~~~text
  <WSL Harness root>/package.json
  ~~~

- **Existing Node.js, installed Harness dependencies, and a completed full Harness build.** First-run setup selects an installed Node executable; it does not install one. The launcher bundles its own MIT-licensed Python manager **1.0.0** and can generate both configurations for new setups, so no private script is needed. Legacy users keep their configured manager and data.

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

- **Existing configurations:** use the Windows application configuration when present; otherwise import the legacy Windows configuration without changing the original. Existing invalid configurations report errors rather than being automatically overwritten. Legacy environments keep their configured WSL manager and Linux configuration.
- **New setups:** the first-run wizard appears **only when neither the Windows application configuration nor the legacy configuration exists**. Choose an existing WSL distribution and Linux user, then select the WSL Harness source root through the Windows native `IFileOpenDialog` system picker. It detects the highest installed nvm Node version or system Node; you may instead select an existing Node executable through the same system picker. Both path fields are read-only, with no manual entry or custom browser; results are converted to paths in the selected WSL distribution, rejecting Windows-host and other-distribution paths. The selected version must still meet Harness requirements. The default port is `3080`, adjustable under advanced options.
- Selecting values or checking the environment does not deploy files. Clicking “完成配置并启动” (Complete setup and start) first reuses the read-only environment checks, then deploys the bundled manager and generates the Linux and Windows configurations only after checks pass, before following the existing startup flow. See [Configuration](<#configuration>) for paths and retries. The launcher does not install WSL/software, clone repositories, install dependencies, build Harness, or configure API keys.

For directory changes with an existing configuration, click the separate “设置” (Settings) gear icon next to the upper-left Logo, then select “环境与目录” (Environment & directory) on the settings page in the current window, select the **WSL Harness root** through the Windows native `IFileOpenDialog` system picker, and click “保存并重新检测” (Save and retry). The path field is read-only, with no manual entry. The picker converts the selected distribution’s UNC paths to WSL paths and rejects Windows-host or other-distribution paths. Directory changes require an idle service and free configured port: if a managed service is starting, wait until it is ready, then stop it through the tray right-click menu; manage an external service in its original terminal. This saves only `repository` in the **existing** Linux configuration, preserving other fields and file permissions. It checks the project entry, configured Node.js, resolvable/readable `tsx/esm`, and Web build assets; it does not install, clone, or build anything.

~~~text
Example WSL Harness root: /home/your-user/deepseek-harness
Checked project assets:  package.json
                         apps/cli/src/bin.ts
                         apps/web/dist/index.html and referenced local assets
~~~

After manually fixing dependencies or completing the full Harness build, click “重新检测” (Retry). Retry reads the latest configuration; reopening the application is unnecessary. Once checks pass, the launcher reuses a ready service or starts it through the existing manager, polls readiness, verifies Windows loopback access, and opens the DSH WebView automatically.

The runtime chain is:

~~~text
wsl.exe -> bundled or existing Python service manager -> configured Node.js

# Run by the manager from the configured Harness repository:
<configured-node> --import tsx/esm apps/cli/src/bin.ts web --no-open --host 127.0.0.1 --port 3080
~~~

Here `3080` is the default; the actual port comes from configuration. The Windows and Linux configurations must agree. The manager supplies its configured state and DSH_HOME environment; its state directory is not DSH_HOME. This runtime is not a pnpm development server or the launcher’s own frontend. Checks must pass before startup, but do not establish that every runtime feature works; consult the manager’s service logs if startup still fails.

## Features

- Provides first-run setup with a bundled manager and generated configurations when neither configuration exists; imports legacy configuration and reuses the original manager/data otherwise.
- Checks/starts the service and opens DSH in a WebView after confirming Windows can reach it.
- Single application instance and single DSH workspace window; reopening activates the existing window.
- Startup progress, tray icon, start/stop/restart controls, and redacted operation logs.
- The launcher and DSH workspace use a single-row custom title bar with a passive upper-left Logo, a separate “设置” (Settings) gear icon beside it, the application title, and window controls. The former File / Settings / Help top-level menus are removed. Clicking the gear opens the settings page directly in the current window, without a dropdown. Open Diagnostic logs from that page’s sidebar. The tray menu is unchanged. Drag a blank area to move the window; double-click to maximize/restore. Closing still hides to the tray.
- Closing a window does not stop tasks; “仅退出启动器（保留服务）” (Quit launcher only, keep service) leaves the service running.
- Optional Windows native notifications for background turn completion/failure, with a persistent toggle and test notification; disabled by default.
- Task-scoped automatic sleep prevention, enabled by default and independent of notifications. Configure it and inspect the actual request status under Settings → 电源管理 (Power management). The display can still turn off.
- “停止服务并退出…” (Stop service and quit) exits only after a successful stop is confirmed. Native confirmations for destructive actions default to “否” (No).
- Silently checks stable GitHub releases at startup without interrupting initialization or opening a dialog automatically. Click the Software updates icon beside the Settings gear to open the update page directly. A small red dot indicates a known new version; opening the page does not dismiss it. It is hidden when no update is known. Download, signature verification, and installation require manual confirmation and update only the Windows launcher. See [updates and signing-key setup](<UPDATES.md>).

It does not install/upgrade DSH, modify the old launcher, migrate Edge login data, take over all of WSL, or automatically force-kill processes.

## Everyday use

The upper-left Logo is passive. Click the separate “设置” (Settings) gear icon beside it to open the current window’s settings page directly, without a dropdown, then choose Diagnostic logs from the page sidebar. Tray diagnostics and update entries remain unchanged. Service start/stop/restart and all quit/exit commands are available only in the unchanged tray right-click menu:

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

The page context menu contains only “刷新” (Refresh) and “打开控制台” (Open developer tools). The latter opens the current page’s WebView2 DevTools, including Console, Elements, and Network—not a terminal or launcher diagnostic log. The tray menu is unchanged.

### Task-scoped sleep prevention

After the workspace has authenticated with the configured local DSH service, the launcher checks the read-only session list approximately every three seconds. Any running live session, including a subagent, keeps the Windows system sleep request active; when all are idle, the next successful check releases it. An Agent waiting for user input remains protected while its state is still running. An unfinished long-task goal alone is not considered active work. The preference is saved separately in power.json in the application configuration directory.

Hiding to the tray keeps protection active. Disabling the setting, leaving the service-ready state, or quitting the launcher releases it. “Quit launcher only” leaves WSL running but ends sleep protection. Temporary query failures preserve an existing request only until approximately 30 seconds after the last valid running observation, then release it while retrying. Errors and actual request status appear in the settings page.

This uses a temporary Windows system request, not a change to the power plan. It does not keep the screen on, prevent manual sleep, lid-close actions, shutdown, or forced system sleep, and does not automatically shut down after tasks.

## Architecture and security

~~~text
Trusted local control page + native tray -> Tauri Rust -> wsl.exe -> bundled or existing Python manager -> WSL DSH
                                                                                                 ^
                                                                     DSH WebView without native IPC
~~~

With no configuration, the initialization window offers first-run setup; once configured, it handles startup progress and error recovery. Once ready, it hides automatically and opens the DSH workspace. The separate “设置” (Settings) gear icon next to the passive upper-left Logo directly opens a settings page within the current primary window, without a dropdown or a separate native settings window. It contains “环境与目录” (Environment & directory), “系统通知” (System notifications), “电源管理” (Power management), “桌面宠物” (Desktop pet), “软件更新” (Software updates), and “诊断日志” (Diagnostic logs). Select “诊断日志” (Diagnostic logs) in the page sidebar to open the log category. The upper-left “返回” (Return) button restores the original workspace or initialization page. The native DSH WebView stays alive and is not reloaded when returning. Each window retains its settings form’s unsaved input when switching categories, returning, or reopening settings. Each window’s title bar is a separate trusted local WebView, isolated from its content. Service, notification, power-management, and update commands are granted only to the initialization/settings content WebViews. Title bars can invoke only fixed settings/update-page navigation, read minimal update/pet-visibility indicators, toggle the pet window, and perform their own window operations; they cannot check, download, or install updates. Rust validates the view label, parent window, local origin, page path, and parameters. Remote DSH content has no native permissions and receives no injected title-bar script.

Launch URLs must strictly match the configured loopback address and port. Tokens are passed to the WebView only in memory, never sent to the control page or written to operation logs. WSL requests use argument arrays without a shell, with bounded response sizes and timeouts. External links permit only HTTP(S) URLs without a launch token or user information.

The configured manager handles deduplication, readiness detection, identity checks, SIGTERM, and waiting for exit. The embedded [guarded-stop adapter](<src-tauri/helpers/guarded_stop.py>) additionally verifies the expected PID, management lock, and process start time while the original manager holds its operation lock, preventing accidental termination of an unrelated process. It runs through Python’s `-c` argument and does not overwrite the legacy script.

“Managed by the launcher” includes services hosted by the same configured Python manager (including legacy setups), not only instances started by this desktop process. Externally launched services are only connected to, not automatically stopped. A new WebView reports an explicit error if no authentication information is available.

## Configuration

The launcher uses an existing Windows application configuration first; if absent, it imports the legacy configuration from the location below without changing the original. Only when both are absent does it offer first-run setup. Invalid existing configurations are not automatically overwritten. Legacy environments keep the Harness directory, Node.js path, and DSH_HOME specified by their original manager/configuration; old scripts and data are not automatically replaced or migrated.

~~~text
Application configuration: %APPDATA%\io.local.dsh-wsl-desktop\config.json
Operation log:             %APPDATA%\io.local.dsh-wsl-desktop\launcher.log
WebView data:              %LOCALAPPDATA%\io.local.dsh-wsl-desktop\webview
Legacy import source:      %LOCALAPPDATA%\DeepSeekHarnessLauncher\config.json
~~~

### First-run generated configuration

New WSL-side application data uses the hidden home directory `~/.dsh-wsl-desktop/`. The pet workspace defaults to `assistant/` beneath that root, without creating a separate transcript store. Local speech uses `speech/models/`, `speech/runtime/`, `speech/service/`, and `speech/config.json` beneath the same root. Python is fixed to `speech/runtime/venv/bin/python`; manually selected and legacy external interpreter paths are not used. The settings page no longer discovers environments automatically; opening it only reads saved configuration and service status. Only explicitly clicking “初始化语音环境” reuses the default Python environment, or creates the missing default virtual environment and local configuration offline; it does not install system Python/CUDA/ROCm, dependencies, or native libraries, or load a model; see the [speech directory layout](<QWEN_SPEECH.md#默认数据目录>). Windows settings retain their native user-configuration locations above. Existing Linux configurations, external environments, Harness checkouts, and DSH_HOME are not automatically migrated.

The project’s own MIT-licensed Python manager **1.0.0** is embedded in the desktop package using Rust `include_str!`. Its version is paired with the desktop application; setup does not download a remote “latest” manager. After you click “完成配置并启动” (Complete setup and start) and the pre-deployment read-only checks pass, it uses these paths under the selected Linux user:

~~~text
Manager:     ~/.dsh-wsl-desktop/manager-1.0.0.py
Linux JSON:  ~/.dsh-wsl-desktop/profiles/<profile-id>/config.json
State/logs:  ~/.dsh-wsl-desktop/state/<profile-id>
~~~

The request-content hash determines `profile-id`, so the same request can be safely retried, reusing deployed files without overwriting old data. The complete Windows configuration is published atomically **last**, after Linux deployment. If Windows publication fails, Linux files may remain and be reused on retry; setup does not roll back by deleting them. Existing scripts/data are not automatically replaced or migrated, and installing a desktop update does not imply replacement of a legacy manager in use.

### Manual configuration (advanced / legacy compatibility)

These examples are for advanced users with an existing compatible manager, not a required step for new users. Adapt the distribution, user, home directory, and all paths. Copying the Windows JSON only points to existing files; it does not create the referenced manager or Linux configuration. The environment check expects absolute WSL `repository`, `node`, and `state_directory` paths plus an integer Linux `port` matching Windows `Port`. Preserve extra fields required by your manager.

Place the following Windows JSON at the application-configuration location above only when manually configuring an existing setup:

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

First-run setup uses the bundled manager and does not require obtaining a legacy script. These manual JSON examples only describe compatibility with an existing manager supporting `probe` / `run` / `stop` / `logs`; they are not the manager program. Setup does not automatically replace scripts at those legacy paths or migrate their data.

If an nvm/Node.js update invalidates the configured absolute executable path, update the WSL manager’s configuration. The application does not rely on interactive shell initialization.

## Startup environment checks

Startup checks cover WSL, launcher configuration, distribution, Linux user, Python, manager script, WSL service configuration, Harness repository, Node.js, installed dependencies, and Web artifacts. Once all checks pass, the launcher checks/starts the service and opens DSH automatically; there is no Continue button to click.

First-run setup collects the required configuration and deploys only after explicit confirmation. Once configured, the initialization view presents three stages: “检查运行环境 → 准备本地服务 → 打开 DSH” (Check runtime environment → Prepare local service → Open DSH). This configured startup view does not mix in notifications, updates, or service controls. The detailed checklist is collapsed by default. Failures show the cause and recovery guidance with “重新检测” (Retry) and “打开设置” (Open settings). Checks depending on an earlier failure show “等待前置项” (Waiting for prerequisites), rather than cascading errors. Checks do not automatically install, clone, or build anything. Retry rereads the latest configuration without restarting the app.

Click the separate “设置” (Settings) gear icon next to the upper-left Logo, then select “环境与目录” (Environment & directory) on the settings page in the current window, select the **DSH root inside WSL** through the Windows native `IFileOpenDialog` system picker (read-only path field, no manual entry; Windows-host and other-distribution paths are rejected), and click “保存并重新检测” (Save and retry). It validates the project entry and updates only `repository` in the existing Linux service configuration, preserving other fields and permissions, then reruns checks. After passing, DSH opens automatically. This existing-configuration directory update does not rerun first-time deployment; missing original manager scripts or Linux configurations require manual repair. Changing directories requires the service to be idle and the configured port free. If a managed service is still starting, wait until ready before stopping it through the tray right-click menu; handle external services in their original terminal. Saving does not automatically stop or restart an existing service.

### Troubleshooting

- **Missing Windows configuration:** check the legacy import source above. Only when both configurations are absent does first-run setup deploy the bundled manager and generate both configurations after confirmation and successful checks. Invalid existing files require manual repair; they are not automatically overwritten.
- **Missing helper, Python, Linux JSON, or `ss`:** first-run setup supplies the manager/configuration, but `/usr/bin/python3` (>= 3.9) and `ss` remain prerequisites. With existing configurations, verify `LinuxLauncher` and `LinuxConfig` are readable absolute WSL paths under the selected user and repair missing original files manually. Ordinary Retry does not redeploy or repair a legacy environment.
- **“已安装依赖” (Installed dependencies) fails / `tsx/esm` cannot resolve:** run `pnpm install` manually in the **Harness repository in WSL**, using its pinned pnpm and compatible Node.js. For a fresh clone, follow with the full `pnpm run build`, then click “重新检测” (Retry). Installing this launcher’s npm dependencies does not install Harness dependencies.
- **“Web 构建产物” (Web build artifacts) fails:** complete the full Harness `pnpm run build` in WSL and ensure the generated HTML and referenced local assets are readable. A fresh clone or a Web-only build may still lack required runtime/native/client assets; `build:web` alone is not guaranteed sufficient. The asset locations are shown in Quick start.
- **“Node.js” fails, especially after nvm changes:** check the Linux configuration’s absolute `node` path exists, is executable by the selected user, and satisfies Harness `engines.node`. A Node version working in an interactive terminal does not prove the configured path works; shell startup files are not loaded. Match the checkout’s `packageManager` and upstream build prerequisites too.
- **Port mismatch, connection timeout, or external service:** ensure Windows `Port` and Linux `port` match, and Windows can reach the configured loopback service. The default is `3080`. A Windows HTTP `401` can be an expected reachable, authenticated-service response, but an externally launched service may not supply credentials for a new WebView. Use its original terminal’s authentication link; the launcher will not stop it or take ownership automatically. Do not kill an unknown listener just to free the port.
- **Invalid directory or save failure:** use the Harness source root’s absolute WSL path, verify the existing Linux configuration is valid, and ensure the service is idle and configured port free. A successful directory save does not mean dependency and build checks have passed.
- **Startup failure or timeout:** click the separate “设置” (Settings) gear icon next to the upper-left Logo, then choose “诊断日志” (Diagnostic logs) in the settings page sidebar; also inspect the original Python manager’s service logs. A timeout does not mean the service has stopped; Retry later rather than starting duplicate manual instances. Passing environment checks is not a full runtime validation. Do not share credentials or authentication links in diagnostics.

## Desktop pet controls

The fish icon beside Software updates in both native titlebars toggles the desktop pet and follows actual visibility changes from settings, the tray and the pet itself. It does not open a chat or start/stop WSL. Settings → 桌面宠物 (Desktop pet) provides current visibility, show at application startup (default off), allow random roaming (default on), and notification bubbles (default on). Only the last three are persisted in the local pet-settings.json; hiding now does not change next-start preference or cancel DSH work. Disabling roaming still allows dragging, throwing and manual animation playback. These are native controls; browser preview is read-only.

Passive pet bubbles reuse real completed/failed/waiting task events, display only session names and fixed status summaries, and open the original session when clicked. They close after about 12 seconds; hover, focus and the action menu pause the timer. Visual cards remain exclusive: a visible pet never creates an automatic Windows toast, but still plays the system notification sound when the system notification switch is enabled, even with bubbles off. A hidden pet uses the existing Windows toast with its own sound, without playing a second sound. Sound-only alerts obey the app notification switch, foreground policy, Windows system volume and sound scheme. Foreground delivery requires the shared explicit opt-in, which can be configured while Windows notifications are off. Hidden pets are not automatically shown and do not replay queued historical bubbles. Native click targets are short-lived, bounded, memory-only; the pet can submit opaque IDs, never arbitrary URLs.

### Answering and confirming inside the pet bubble

With visible enabled bubbles, live requests can be answered directly: single/multiple choices, custom text, complete answer batches, plan approval or continued-planning feedback, and **allow once / reject** for authorization. No option is preselected and no permanent grant is offered. These live interactions remain until processed or explicitly collapsed, independently of passive notification timeout/foreground quiet. Collapsing/hiding never answers or cancels. Other DSH clients may handle the same request first; cancelled/stale controls become unusable.

Approval shows complete reasons and exact tool parameters, including complete root/parent programs for nested calls. Missing or ambiguous details disable allow while keeping rejection/open-in-DSH. Native code correlates opaque IDs with the current authenticated request and never automatically resends an uncertain answer. Requests that have timed out into continued state, unsupported payloads, or unavailable complete details can still be handled in DSH. Answering/authorizing may resume the original task and its normal costs, without creating another conversation or extra prompt.

## System notifications

Click the separate “设置” (Settings) gear icon next to the upper-left Logo, then select “系统通知” (System notifications) on the settings page in the current window, enable “后台任务通知” (Background task notifications), and click “发送测试通知” (Send test notification). Preferences are saved separately at the location below; they are not written back to legacy launcher or DSH configuration.

~~~text
%APPDATA%\io.local.dsh-wsl-desktop\notifications.json
~~~

- Notifications appear only when the DSH workspace is not in the foreground. Checks continue after hiding to the tray and stop when the launcher exits.
- Approximately every three seconds, the launcher uses the signed-in workspace WebView’s same-origin authenticated state to query the local read-only session API. It starts no additional service, does not take over permission confirmations or user questions, and gives the DSH page no native IPC.
- Notifications cover normal completion, failures, and waiting for a user choice, answer, or plan confirmation, including nested tool calls inside `run_code`. Cancellations, truncated output, restored historical completion markers, and subagents do not generate success notifications. Notifications use the Windows default sound and show the matching session title for completion, failure, and pending-answer reminders. Missing or invalid titles fall back to “未命名会话 · short ID”; names are kept on one line and truncated when long. No question/answer bodies, error details, project paths, or credentials are additionally extracted for display. Session titles may be derived from the first user message and may be retained in Windows Notification Center; avoid sensitive information in titles. “本轮结束” (Turn finished) does not mean the entire long-running goal is complete.
- Blocking questions are inferred from running tool calls and their completion events. A question must remain pending for two consecutive checks before notification, usually about 3–6 seconds, filtering calls that fail quickly or have already been answered. This is read-only state inference, not an exact subscription to question-dialog events. Scheduled questions continue to use the pending-answer projection and filter queued answers. Each question is notified only once; answering or canceling prevents further reminders. The launcher never answers for you.
- On initial connection, reconnection, or re-enabling, execution results only establish a baseline; historical results are not replayed. Still-unanswered questions are checked. Network reconnects within one enabled period do not repeat already-consumed questions; re-enabling can notify a currently unanswered question again. Multiple turns within one polling interval in the same session are merged into the most recent result. Notifications consumed in the foreground are not replayed after switching to the background.
- Clicking a task notification restores the existing DSH workspace and selects its session, including from settings or the tray, without restarting the service. This requires a matching Harness frontend that consumes `#session=<encoded session ID>&notification=<nonce>`; updating only the launcher does not add deep-link support to older Harness builds. Missing or unavailable sessions do not create new ones. Test notifications have no session target. Activation works only while the launcher is running; no protocol handler or cold launch is registered. At most 128 clickable task notifications are retained. Overflow and normal exit attempt to remove the oldest or remaining process-owned task notifications respectively; stale system entries may remain if cleanup fails.
- Verify native notifications with the **installed Windows application**. A successful API call only means submission to Windows, not a guaranteed banner. Check Windows “设置 → 系统 → 通知” (Settings → System → Notifications) and Do Not Disturb. Test notifications do not require Harness to be connected.

Suggested acceptance checks: enable notifications and wait for “正在检查” (Checking), then run background success/failure tasks, ordinary questions, nested questions inside `run_code`, and plan confirmations. Verify pending-answer notifications have sound without duplicates, stop after answering, stay silent in the foreground, do not report cancellation as success, stop when disabled, do not replay historical results on reconnect, and preserve the toggle after restart. WSL/Linux unit tests and cross-compilation do not replace real Windows banner tests.

## Installer appearance

Windows installation/uninstallation wizards use Simplified Chinese without a language-selection dialog. Welcome/finish pages have a dark-blue branded sidebar; other pages have a white header banner. The font is Microsoft YaHei UI. The MIT license retains its original English text. Updates continue to use the existing passive installation flow.

Appearance and text are in [appearance.nsh](<src-tauri/installer/appearance.nsh>); bitmap sources are [sidebar.svg](<src-tauri/installer/sidebar.svg>) and [header.svg](<src-tauri/installer/header.svg>). After changing the source artwork, run `npm run installer:assets` and commit the two generated BMP images. Normal packaging uses the committed bitmaps without depending on system fonts or additional image tools. Changes appear only in newly built installers, not previously downloaded packages.

The shared icon source is [app-icon.png](<app-icon.png>): the whale above a centered Windows / opposing arrows / Linux group. After replacing it, run `npm run icons:generate` and commit the generated desktop PNGs, multi-resolution Windows ICO, and installer BMPs. Startup, settings, and the title bar use the same source. DeepSeek, Windows, and Linux marks belong to their respective owners; this launcher is not an official desktop client from those organizations.

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

## Windows first-run acceptance (pending real-machine execution)

This is a checklist, **not a claim of completed Windows testing**. This documentation update did not run the application or any real service. Use an isolated Windows user/test WSL environment; do not remove or replace personal configurations or data.

- **Entry routing:** show setup only with neither Windows configuration present; import a valid legacy configuration unchanged; use an existing new configuration. Invalid new or legacy files must report errors without automatic overwrite.
- **Selection/prerequisites:** cover distribution/user selection, Harness root, highest installed nvm version and system Node detection, native system-picker selection of repo/Node (read-only fields, WSL-path results, Windows-host/other-distribution rejection, no manual entry), default port 3080, and an advanced custom port. Missing `/usr/bin/python3` >= 3.9, `ss`, compatible Node, dependencies, or a full build must produce actionable errors, not installation, cloning, builds, or API-key configuration.
- **Write boundary:** selecting/checking/canceling must not deploy the manager or publish either configuration. “完成配置并启动” (Complete setup and start) must first pass read-only checks. Then verify bundled manager 1.0.0 and profile/state/log paths, with no remote manager download.
- **Failure/retry:** simulate final Windows publication failure in isolation. No partial Windows configuration should be visible; Linux deployment may remain. Retrying the same request must reuse the same `profile-id` without rollback deletion or overwrite of old scripts/data, then atomically publish the complete Windows configuration.
- **Startup/compatibility:** successful deployment follows existing check/start/readiness/Windows-loopback verification. Reopening uses the published configuration without repeating setup. Legacy scripts/data and advanced manual configurations remain usable without automatic replacement or migration.

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

Windows acceptance testing still needs to cover initial authentication and persisted login after reopening, streaming responses, background execution after closing, tray restore, single-instance behavior, upload/download, external links and previews, multiple monitors/DPI, cancellation confirmations, stop failures, and refusal to stop external instances. Custom title bars additionally require native checks for mouse/keyboard operation of the settings gear, a passive Logo with no dropdown, edge resizing, dragging, double-click maximize/restore, minimizing, close-to-tray, and ensuring the title bar does not obscure content after display scaling changes. Browser previews and Windows-target source checks do not replace these native acceptance tests.

## Main source files

- [Native lifecycle](<src-tauri/src/desktop.rs>)
- [Native update adapter](<src-tauri/src/desktop_updates.rs>) and [update policy](<src-tauri/src/update.rs>)
- [Configuration import](<src-tauri/src/config.rs>)
- [WSL adapter](<src-tauri/src/backend.rs>)
- [Protocol and credential redaction](<src-tauri/src/protocol.rs>)
- [Local control page](<src/main.ts>)
- [Least-privilege capabilities](<src-tauri/capabilities/launcher.json>)
