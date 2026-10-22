# Privacy policy

Last updated: 2026-10-22

## Scope

This policy describes the DSH WSL Desktop launcher maintained by Evan Yang, an individual. It is not a privacy policy for DeepSeek Harness (DSH), its model providers, extensions, the separately configured WSL helper, Microsoft WebView2, or websites opened in the system browser.

The launcher does not implement its own analytics uploader, account service, or maintainer-operated data-collection endpoint. This does **not** mean that the embedded DSH application, its tools, WebView2, or external services are prevented from communicating with other systems.

## Local configuration and service control

On first launch, the application imports launcher settings from the existing Windows launcher configuration. Settings include the WSL distribution and Linux user, helper/configuration paths, service port, timeouts, and window size. These settings stay in the local application configuration directory; the launcher does not upload them to the maintainer.

The application invokes the configured helper through Windows Subsystem for Linux to check, start, or explicitly stop DSH. It also makes HTTP readiness requests to the configured loopback address, normally http://127.0.0.1:3080/. Starting the desktop app may start the existing DSH service. Stopping or restarting requires a native confirmation and may interrupt existing tasks.

The helper and DSH can access local projects, credentials, conversations, model providers, and other tools according to their own configuration and permissions. Review their settings and upstream documentation before use. This launcher does not audit, replace, or disable those systems' data handling or telemetry.

## Embedded browser and external services

The working window loads the locally running DSH website using WebView2. A launch authentication URL can be passed to that local service, and browser data such as cookies, cached content, or local storage may persist in the WebView profile. Authentication URLs and browser-profile files should be treated as sensitive.

Top-level navigation and popup restrictions are not a network sandbox for page subresources, fetch requests, WebSocket connections, or engine/system services. DSH features may communicate with remote model providers or other configured services. Review the policies of those providers; do not assume conversations remain local merely because the desktop page is served from a loopback address.

Permitted external web links are opened using the system's default handler. Data processing at the destination is governed by that site's and browser's policies. The installer may download/install Microsoft WebView2 Runtime when it is required. Microsoft's [privacy statement](https://privacy.microsoft.com/privacystatement) applies to Microsoft services and components.

## Activity logs

The launcher keeps a recent in-memory activity list and a local activity log for startup stages, service-control actions, and errors. It does not intentionally copy DSH conversations or the existing helper's service log into this activity log. Common token and Bearer forms are redacted, but redaction is not a guarantee that arbitrary user-supplied text is free of sensitive information.

The in-memory list retains up to 120 entries. If the activity-log file is already larger than 512 KiB, the next write truncates it; this is not a strict maximum file size. There is no automatic upload of these launcher activity logs. Review logs before sharing them in support requests.

## Storage and removal

Typical Windows locations are:

~~~text
%APPDATA%\io.local.dsh-wsl-desktop\config.json
%APPDATA%\io.local.dsh-wsl-desktop\launcher.log
%LOCALAPPDATA%\io.local.dsh-wsl-desktop\webview
~~~

The working WebView uses the last directory. WebView2 and the local control window may also use engine/system storage. Existing DSH and helper data remain in their separately configured locations.

Closing a window hides it; quitting the launcher does not by itself delete configuration, activity logs, browser data, or DSH projects. The launcher has no built-in clear-all-data control. An installed copy can be uninstalled using Windows Installed apps. Automatic data cleanup during uninstallation has not been verified; inspect remaining application directories before removing them yourself. Do not delete DSH projects or authentication data unless you intend to remove them.

## Project services and contact

Viewing the public GitHub repository, downloading build artifacts, or filing an issue is subject to GitHub's policies. Applying to or using a signing service is separate from running the launcher and is subject to that service's policies. This policy does not assert that SignPath has approved this project.

For public questions, use the [project issue tracker](https://github.com/elves-ai/dsh-wsl-desktop/issues). Do not post credentials, authentication URLs, private logs, or sensitive project data in public issues.
