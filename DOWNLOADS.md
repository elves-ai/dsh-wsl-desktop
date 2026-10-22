# Download DSH WSL Desktop

DSH WSL Desktop is a Windows desktop launcher for an existing DeepSeek Harness installation in WSL. It provides a local startup/status window, an embedded DSH workspace, a tray icon, and explicit start/stop/restart controls. It does not bundle or install DSH itself.

## Available Windows x64 build

- [Successful Windows build and tests](https://github.com/elves-ai/dsh-wsl-desktop/actions/runs/39783119532) — source commit a414bb3fa0134116ae5a0fa00f0d1da1f0e4c93c.
- [Download executable, NSIS installer and SHA256 checksums](https://github.com/elves-ai/dsh-wsl-desktop/actions/runs/39783119532/artifacts/12428775314).
- [All build runs and newer artifacts](https://github.com/elves-ai/dsh-wsl-desktop/actions/workflows/windows-build.yml).

GitHub Actions artifacts normally require GitHub login and expire after 30 days. This is not a permanent GitHub Release asset. If the linked artifact has expired, select a newer successful run or build the reviewed source. A successful CI build verifies compilation/tests/packaging, not end-to-end operation against every user's WSL installation.

Unpack the downloaded artifact. Run the NSIS setup executable to install, or use the standalone executable with WebView2 Runtime available. The launcher imports the existing Windows launcher's configuration; users without that setup must configure the helper and paths as described in the [usage guide](<README.md#配置>). Keep the checksums with the exact downloaded build. Use Windows Installed apps to uninstall an installed copy; see [data retention notes](<PRIVACY.md#storage-and-removal>) before removing data directories.

## Code signing policy

**Current downloads are unsigned.** Windows SmartScreen may show an unknown-publisher or reputation warning. Verify the source commit, build status and checksum before deciding whether to run them; do not bypass a malware detection merely because a checksum matches.

An application for SignPath Foundation support was submitted on 2026-10-22 and is pending review. Approval has not been granted and no existing download is claimed to carry its signature. If the project is approved and signed builds become available, their attribution will be: “Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).” This conditional attribution is not evidence of present sponsorship or signing.

Read the complete [code signing policy](<CODE_SIGNING.md>), [privacy policy](<PRIVACY.md>), and [MIT license](<LICENSE>). This project is maintained by Evan Yang as an individual; third-party components retain their own licenses and policies.
