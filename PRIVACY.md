# Privacy policy

Last updated: 2026-10-22

## Scope

This policy describes the DSH WSL Desktop launcher maintained by Evan Yang, an individual. It is not a privacy policy for DeepSeek Harness (DSH), its model providers, extensions, the separately configured WSL helper, Microsoft WebView2, or websites opened in the system browser.

The launcher does not implement its own analytics uploader, account service, or maintainer-operated data-collection endpoint. This does **not** mean that the embedded DSH application, its tools, WebView2, or external services are prevented from communicating with other systems.

## Local configuration and service control

On first launch, the application imports launcher settings from the existing Windows launcher configuration. Settings include the WSL distribution and Linux user, helper/configuration paths, service port, timeouts, and window size. These settings stay in the local application configuration directory; the launcher does not upload them to the maintainer.

The application invokes the configured helper through Windows Subsystem for Linux to check, start, or explicitly stop DSH. It also makes HTTP readiness requests to the configured loopback address, normally http://127.0.0.1:3080/. Starting the desktop app may start the existing DSH service. Stopping or restarting requires a native confirmation and may interrupt existing tasks.

The helper and DSH can access local projects, credentials, conversations, model providers, and other tools according to their own configuration and permissions. Review their settings and upstream documentation before use. This launcher does not audit, replace, or disable those systems' data handling or telemetry.

Startup environment checks read WSL availability, the configured Linux files and project metadata, and run bounded Node version/module-resolution probes without importing project code. They do not install software, clone repositories, or build the project. Only when you explicitly save a DSH project directory does the launcher update the repository field in the existing Linux helper configuration; other fields and file permissions are preserved. Detection results and the configured project path are shown locally and are not uploaded to the maintainer.

## Embedded browser and external services

The working window loads the locally running DSH website using WebView2. A launch authentication URL can be passed to that local service, and browser data such as cookies, cached content, or local storage may persist in the WebView profile. Authentication URLs and browser-profile files should be treated as sensitive.

Top-level navigation and popup restrictions are not a network sandbox for page subresources, fetch requests, WebSocket connections, or engine/system services. DSH features may communicate with remote model providers or other configured services. Review the policies of those providers; do not assume conversations remain local merely because the desktop page is served from a loopback address.

Permitted external web links are opened using the system's default handler. Data processing at the destination is governed by that site's and browser's policies. The installer may download/install Microsoft WebView2 Runtime when it is required. Microsoft's [privacy statement](https://privacy.microsoft.com/privacystatement) applies to Microsoft services and components.

## Optional desktop notifications

Desktop notifications are off by default. If enabled, the native launcher reads only the HttpOnly authentication cookie bound to the configured loopback service authority from the DSH working WebView and uses it in memory for read-only session-list and recent-history requests, approximately every three seconds. These requests bypass proxies and do not follow redirects. No launch token is reused and no authentication data is exposed to the local control page, notification text, or launcher logs.

The session API may return conversation data in the inspected history page. The launcher classifies the latest turn-ending reason and sequence, and checks running tool starts/results and pending-question projections for a request to choose, answer, or review a plan. Its cursor/deduplication state retains only opaque session/call identifiers, not question arguments or conversation text. For each reminder it also reads the matching session's title string from the session-list title projection, normalizes it to one line, and truncates long names; a missing or invalid title falls back to an unnamed-session label with a short session ID. It does not use conversation bodies, question arguments, error payloads, workspace paths, or authentication fields to build notification text, and does not persist API responses or copy task names to launcher snapshots or activity logs. DSH may generate a session title from the first user message, so the title itself can contain a conversation excerpt or sensitive text. Windows may retain the displayed title and notification in its notification center according to system settings; avoid sensitive information in session titles. Disabling notifications stops new checks and submissions, but does not remove notifications already submitted to Windows. Quitting the launcher stops notification monitoring without stopping DSH. Task notifications retain a native Windows handle and an in-memory callback containing an opaque session ID and the original loopback service target. Clicking one restores the existing workspace using an encoded URL fragment; the fragment may appear in WebView/browser navigation history, but is not sent in an HTTP request or recorded in launcher logs. No arbitrary activation URL is accepted, no script is injected into DSH, and no service is started or restarted on click. The matching frontend must support this fragment navigation. Activation is only supported while the launcher is running, including in the tray; no OS protocol/cold-start registration is made. At most 128 task notifications are retained. The oldest is removed on overflow; dismissing or activating a notification releases its handle, while banner timeout retains it for Notification Center. Normal exit attempts to remove this process's remaining task notifications. Generic test notifications are not session-bound.

Only the non-secret enabled preference is stored in a separate local notifications.json file. Initial connections and reconnections establish a fresh baseline rather than replaying old completed results. Still-pending questions can produce a reminder; deduplication across network reconnections prevents repeating an already-consumed reminder within the current enabled period. The read-only inference never answers a question, submits a plan decision, or joins the interaction-answerer stream.

## Task-scoped power management

Sleep prevention is enabled by default and can be disabled under Settings → 电源管理 (Power management). Independently of notifications, this worker uses the same authority-bound HttpOnly cookie and bounded, proxy-free, non-redirecting local RPC transport to read only session/list approximately every three seconds after service readiness. It uses live running flags, including subagents, to control a temporary Windows system sleep request. It does not request conversation-history pages, expose credentials to the settings page, or persist session-list responses. Only the enabled preference is saved in a separate local power.json file; generic status transitions and errors can appear in the launcher activity log.

Hiding the workspace to the tray does not stop monitoring. Disabling notifications stops notification checks only, not this independent power worker. Disabling power management stops its session checks and releases the request; quitting the launcher ends both workers even if WSL keeps running. Temporary query errors keep an existing request only for a bounded grace period of approximately 30 seconds after the last valid running observation. No system power plan is changed.

## Update checks and downloads

Updater-enabled versions check this project’s latest stable GitHub Release once at launcher startup and when requested. These requests expose the client IP address and ordinary HTTP/TLS metadata to GitHub and its download infrastructure. The launcher does not attach DSH tokens, conversations, launcher configuration, or activity logs to these requests. It uses system network/proxy settings and Windows TLS trust; an environment-controlled proxy may also observe connection metadata.

After explicit native confirmation, the launcher downloads an NSIS update package from this project’s GitHub Release, verifies its version-bound update signature, and runs the installer. The Windows launcher/workspace closes and restarts, but this operation does not stop or upgrade the WSL service. Installer temporary files may remain in Windows temporary storage, especially after failures; automatic cleanup is not guaranteed. There is no mirror or maintainer-operated update server. See [update behavior](<UPDATES.md>).

## Activity logs

The launcher keeps a recent in-memory activity list and a local activity log for startup stages, service-control actions, and errors. It does not intentionally copy DSH conversations or the existing helper's service log into this activity log. Common token and Bearer forms are redacted, but redaction is not a guarantee that arbitrary user-supplied text is free of sensitive information.

The in-memory list retains up to 120 entries. If the activity-log file is already larger than 512 KiB, the next write truncates it; this is not a strict maximum file size. There is no automatic upload of these launcher activity logs. Review logs before sharing them in support requests.

## Storage and removal

Typical Windows locations are:

~~~text
%APPDATA%\io.local.dsh-wsl-desktop\config.json
%APPDATA%\io.local.dsh-wsl-desktop\notifications.json
%APPDATA%\io.local.dsh-wsl-desktop\launcher.log
%LOCALAPPDATA%\io.local.dsh-wsl-desktop\webview
~~~

The working WebView uses the last directory. WebView2 and the local control window may also use engine/system storage. Existing DSH and helper data remain in their separately configured locations.

Closing a window hides it; quitting the launcher does not by itself delete configuration, activity logs, browser data, or DSH projects. The launcher has no built-in clear-all-data control. An installed copy can be uninstalled using Windows Installed apps. Automatic data cleanup during uninstallation has not been verified; inspect remaining application directories before removing them yourself. Do not delete DSH projects or authentication data unless you intend to remove them.

## Project services and contact

Viewing the public GitHub repository, downloading build artifacts, or filing an issue is subject to GitHub's policies. Applying to or using a signing service is separate from running the launcher and is subject to that service's policies. This policy does not assert that SignPath has approved this project.

For public questions, use the [project issue tracker](https://github.com/elves-ai/dsh-wsl-desktop/issues). Do not post credentials, authentication URLs, private logs, or sensitive project data in public issues.
