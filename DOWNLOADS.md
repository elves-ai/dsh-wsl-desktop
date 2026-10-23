# Download DSH WSL Desktop

DSH WSL Desktop is a Windows desktop launcher for an existing DeepSeek Harness installation in WSL. It provides a local startup/status window, an embedded DSH workspace, a tray icon, and explicit start/stop/restart controls. It does not bundle or install DSH itself.

## Windows x64 releases

Use the [GitHub Releases page](https://github.com/elves-ai/dsh-wsl-desktop/releases) for versioned downloads. Each published release contains the standalone executable, an NSIS installer, and SHA256SUMS.txt. Releases enabling in-app updates also include the installer signature and latest.json update manifest. These public release assets do not use the 30-day Actions artifact retention period and normally do not require GitHub login. A release appears only after its version-tag workflow completes successfully; prereleases are marked separately.

## Development builds and fallback

- [Successful Windows build and tests](https://github.com/elves-ai/dsh-wsl-desktop/actions/runs/39783119532) — source commit a414bb3fa0134116ae5a0fa00f0d1da1f0e4c93c.
- [Download executable, NSIS installer and SHA256 checksums](https://github.com/elves-ai/dsh-wsl-desktop/actions/runs/39783119532/artifacts/12428775314).
- [All build runs and newer artifacts](https://github.com/elves-ai/dsh-wsl-desktop/actions/workflows/windows-build.yml).

The development builds linked above are historical. New CI builds run only when a `v*` version tag is pushed and publish a Release after successful verification; branch pushes, pull requests, and manual dispatch do not trigger builds. The historical artifacts normally require GitHub login and expire after 30 days; they are separate from GitHub Release assets. If a development artifact has expired, use a published Release, select a newer successful run, or build the reviewed source. A successful CI build verifies compilation/tests/packaging, not end-to-end operation against every user's WSL installation.

Unpack the downloaded artifact. Run the NSIS setup executable to install, or use the standalone executable with WebView2 Runtime available. Keep the checksums with the exact downloaded build. Use Windows Installed apps to uninstall an installed copy; see [data retention notes](<PRIVACY.md#storage-and-removal>) before removing data directories.

## First-run setup

The launcher uses an existing Windows application configuration or imports the legacy launcher configuration unchanged. Only when neither exists does first-run setup ask for the WSL distribution/user and Harness root, detect an installed Node (or accept a manual path), and offer port `3080` with an advanced override. Invalid existing configurations are not automatically overwritten.

After you click “完成配置并启动” (Complete setup and start), read-only checks must pass before the bundled MIT-licensed Python manager 1.0.0 is deployed and Linux/Windows configurations are generated. This manager version is paired with the desktop package, not remotely downloaded as “latest”; legacy scripts/data are not automatically replaced or migrated.

WSL, `/usr/bin/python3` (>= 3.9), `ss`, Node, and a dependency-installed, fully built Harness checkout remain prerequisites. Setup does not install WSL/software, clone, install dependencies, build, or configure API keys. See the [usage guide](<README.md#配置>) for paths, retry behavior, and advanced/legacy manual examples.

## In-app launcher updates

The new updater checks GitHub Releases once at startup, or on request from the tray/control page. Downloads and installation require explicit confirmation; installation verifies a version-bound update signature first. It updates only the Windows launcher, not the WSL DSH installation. DSH windows temporarily close, but WSL service tasks are not stopped. Network/signature failures do not run an installer.

v0.1.0 has no updater: manually install the first updater-enabled release. Updates use the NSIS installer, not in-place replacement of a standalone downloaded EXE; use the installed application for subsequent launches. See [update setup and behavior](<UPDATES.md>). An update signature is separate from Windows Authenticode code signing.

## Code signing policy

**Current downloads are unsigned.** Windows SmartScreen may show an unknown-publisher or reputation warning. Verify the source commit, build status and checksum before deciding whether to run them; do not bypass a malware detection merely because a checksum matches.

An application for SignPath Foundation support was submitted on 2026-10-22 and is pending review. Approval has not been granted and no existing download is claimed to carry its signature. If the project is approved and signed builds become available, their attribution will be: “Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).” This conditional attribution is not evidence of present sponsorship or signing.

Read the complete [code signing policy](<CODE_SIGNING.md>), [privacy policy](<PRIVACY.md>), and [MIT license](<LICENSE>). This project is maintained by Evan Yang as an individual; third-party components retain their own licenses and policies.
