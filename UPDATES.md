# 启动器更新

## 使用方式

- 桌面启动器每次启动静默检查一次正式版本，不会自动下载，不打断初始化或自动弹出窗口。可点击桌面窗口左上角应用图标，选择“设置…”，再在独立设置窗口中进入“软件更新 → 检查更新”；也可使用保持不变的托盘“检查启动器更新…”入口。
- 新版本号及纯文本更新说明在设置窗口的“软件更新”分类显示。点击“下载并安装”后，Windows 原生确认框默认选择“否”。确认后下载并验证签名，随后运行 NSIS 安装器、重启启动器。
- 仅更新 Windows 启动器。不会安装、升级、停止或重启 WSL 中的 DSH 服务。DSH 工作窗口会暂时关闭，未提交的输入可能丢失，请先保存；后台任务仍由原 WSL 管理器运行。
- 检查失败可重试；下载或签名验证失败不会执行安装器，需重新检查后再试。不提供静默强制更新、自动降级、预发布通道或镜像。
- 使用系统网络/代理与 Windows 系统证书，不关闭 TLS 校验。GitHub 不可达时不能更新，但不影响本机服务控制。

**v0.1.0 没有内置更新功能**，需手动安装 v0.1.2 或更新版本。v0.1.2 起正式提供应用内更新；v0.1.1 标签因 Windows 测试失败未发布，保留该标签以便审计。已经公开的旧 Release 不会被覆盖；更新源暂时不可用时可重试或手动下载。

更新使用 NSIS 安装包，不是便携 EXE 的原地替换机制。独立 EXE 用户建议先运行安装包，以后从已安装的应用启动；旧下载目录中的 EXE 不会因此自动变成新版。

## 发布维护者首次配置

[应用配置](<src-tauri/tauri.conf.json>)已固定 GitHub 正式版本清单地址并内置更新公钥：

~~~text
https://github.com/elves-ai/dsh-wsl-desktop/releases/latest/download/latest.json
~~~

首次开发已在本机忽略目录生成配套密钥：私钥为 [.tools/updater-signing.key](<.tools/updater-signing.key>)，公钥备份为 [.tools/updater-signing.key.pub](<.tools/updater-signing.key.pub>)。私钥文件权限为仅当前用户可读写，未设置密码。私钥不进入源码、Actions 产物或聊天内容。请先备份到安全位置，不要上传到 Issue 或公开网盘。

在项目 GitHub Settings → Secrets and variables → Actions 添加：

| Secret | 内容 |
| --- | --- |
| TAURI_SIGNING_PRIVATE_KEY | 配套私钥文件的完整内容，不是文件路径 |
| TAURI_SIGNING_PRIVATE_KEY_PASSWORD | 仅加密私钥需要；本次生成的私钥密码为空，不必创建这个 Secret |

私钥只能用于受信任版本标签构建。工作流仅在推送 `v*` 标签时运行，普通分支推送、PR 和手动触发均不启动构建。推送版本标签表示维护者批准该版本发布；请限制标签推送权限，审核工作流改动。本仓库的更新私钥已于 2026-10-22 配置到 GitHub Actions Secret；空密码无需单独创建 Secret。私钥内容未写入源码。

公钥已嵌入客户端：不要为每个版本重新生成密钥。丢失私钥后，旧客户端无法信任新密钥签名的版本，通常需要用户手动重新安装。若密钥泄漏，应暂停发布并制定信任迁移方案，不能仅删除公开仓库中的某个文件。

## 后续版本发布

1. 同步修改 [package.json](<package.json>)、[package-lock.json](<package-lock.json>)、[Cargo.toml](<src-tauri/Cargo.toml>)、[tauri.conf.json](<src-tauri/tauri.conf.json>) 中的版本并提交，例如 0.1.3。
2. 确认 Secrets 已设置后推送对应标签，例如 v0.1.3。已公开版本不可覆盖。
3. [Windows 工作流](<.github/workflows/windows-build.yml>)运行测试、构建 NSIS，并用更新私钥签名；缺少私钥时标签构建明确失败，不退回无签名发布。
4. 发布前验证所有附件校验和、更新签名、公钥、签名绑定的版本和清单 URL。先上传草稿、核对完整附件，再公开 Release。
5. 稳定版成为 GitHub latest，客户端下次启动或手动检查时可发现。预发布仅作为 Pre-release 发布，不替换正式更新源。

更新版正式 Release 包含独立 EXE、NSIS 安装包、安装包签名、latest.json 和 SHA256SUMS.txt。版本清单和安装包来自同一构建，签名要求包含该版本，拒绝将旧签名包伪装成高版本。签名校验发生在客户端安装前；SHA256 不是更新签名的替代品。

更新说明采用发布脚本生成的简短说明，显示为纯文本，不执行 Markdown/HTML。新增签名只证明更新包来自配套私钥持有者，**不代表获得 SignPath 批准或 Windows 代码签名证书**；见 [代码签名政策](<CODE_SIGNING.md>)。

## 本机开发构建

本机调试/构建不需要生产更新私钥。[Windows 构建脚本](<scripts/Build-Windows.ps1>)会合并 [本机构建配置](<src-tauri/tauri.local-build.conf.json>)，关闭更新签名产物生成；产出的 EXE 仍能检查正式更新，但不能作为正式更新包发布。直接构建时可使用：

~~~powershell
npm ci
npm run desktop:build -- --config src-tauri/tauri.local-build.conf.json
~~~

## 验证边界

自动测试使用模拟 IPC、假服务、临时签名密钥和合成产物；不运行安装器、不发送真实停止信号、不上传私钥。本机 Windows 目标源码检查不代表真实 Windows 安装更新成功。发布前应在 Windows 安装版上验证新旧两个版本升级、拒绝确认、断网、篡改签名、安装器权限/文件占用失败，以及更新期间 WSL 后台任务持续运行。
