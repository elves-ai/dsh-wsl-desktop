#requires -Version 5.1
[CmdletBinding()]
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
foreach ($tool in @('node.exe', 'npm.cmd', 'cargo.exe')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Missing $tool. Install Windows Node.js 24, Rust stable (MSVC), and Visual Studio C++ Build Tools; reopen PowerShell. No tools or system settings were changed."
    }
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable.' }
# npm/cmd cannot reliably build from a WSL UNC working directory. Stage only
# source files on NTFS; never copy Linux node_modules, target, or private .tools.
$buildRoot = Join-Path $env:LOCALAPPDATA 'DSHWslDesktopBuild'
$stage = Join-Path $buildRoot ('source-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
$rootFiles = @('package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'titlebar.html', 'app-icon.png', 'LICENSE', 'README.md', 'PRIVACY.md', 'CODE_SIGNING.md', 'DOWNLOADS.md', 'UPDATES.md')
foreach ($file in $rootFiles) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $stage $file) }
$folders = @('src', 'tests', 'scripts', '.github/workflows', 'src-tauri/src', 'src-tauri/helpers', 'src-tauri/icons', 'src-tauri/installer', 'src-tauri/capabilities')
foreach ($folder in $folders) {
    $destination = Join-Path $stage $folder
    [void][IO.Directory]::CreateDirectory($destination)
    & robocopy.exe (Join-Path $source $folder) $destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Could not stage $folder (robocopy exit $LASTEXITCODE)." }
}
foreach ($file in @('Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'tauri.local-build.conf.json')) {
    Copy-Item -LiteralPath (Join-Path $source ('src-tauri/' + $file)) -Destination (Join-Path $stage ('src-tauri/' + $file))
}
$oldTarget = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = Join-Path $buildRoot 'cargo-target'
Push-Location $stage
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    if (-not $SkipTests) {
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
        & cargo.exe test --manifest-path src-tauri/Cargo.toml --lib --locked
        if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
    }
    # Local builds do not use the production updater private key or produce update signatures.
    & npm.cmd run desktop:build -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.local-build.conf.json
    if ($LASTEXITCODE -ne 0) { throw 'Windows Tauri build failed. Check the C++ toolchain and Windows SDK.' }
    $artifacts = Join-Path $source 'artifacts/windows'
    [void][IO.Directory]::CreateDirectory($artifacts)
    $release = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/release'
    Copy-Item -LiteralPath (Join-Path $release 'dsh-wsl-desktop.exe') -Destination (Join-Path $artifacts 'dsh-wsl-desktop.exe')
    Get-ChildItem -LiteralPath (Join-Path $release 'bundle/nsis') -Filter '*.exe' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $artifacts $_.Name)
    }
    Write-Host "Artifacts: $artifacts"
    Write-Host 'Build only: no installer was executed and the existing launcher was not changed.'
} finally {
    Pop-Location
    $env:CARGO_TARGET_DIR = $oldTarget
}
