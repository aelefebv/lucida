[CmdletBinding()]
param(
    [string]$ReleaseTag = $(if ($env:RELEASE_TAG) { $env:RELEASE_TAG } else { $env:GITHUB_REF_NAME }),
    [string]$DistDir = $(if ($env:DIST_DIR) { $env:DIST_DIR } else { "" }),
    [switch]$DryRun,
    [switch]$Unsigned
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $ReleaseTag) {
    throw "Missing release tag (set RELEASE_TAG/GITHUB_REF_NAME or pass -ReleaseTag)."
}
if (-not $DistDir) {
    $DistDir = Join-Path $repoRoot "dist\release"
}

$parseScript = Join-Path $repoRoot "scripts\release\parse_tag_version.py"
$parsedJson = & python $parseScript --tag $ReleaseTag --format json
if ($LASTEXITCODE -ne 0) {
    throw "Failed to parse release tag '$ReleaseTag'."
}
$meta = $parsedJson | ConvertFrom-Json
$rcComponent = 0
if ($meta.rc -and $meta.rc -ne "") {
    $rcComponent = [int]$meta.rc
}
$msiVersion = "$($meta.major).$($meta.minor).$($meta.patch).$rcComponent"

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$artifactPath = Join-Path $DistDir "lucida-render-shell-v$($meta.semver)-windows-x86_64.msi"

if ($DryRun.IsPresent -or $env:DRY_RUN -eq "1") {
    "dry-run placeholder for $artifactPath" | Out-File -FilePath $artifactPath -Encoding ascii -NoNewline
    Write-Output $artifactPath
    exit 0
}

if (-not ($IsWindows -or $env:OS -eq "Windows_NT")) {
    throw "build_windows_msi.ps1 must run on Windows."
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    throw "cargo is required but not found in PATH."
}
$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix) {
    throw "wix CLI is required but not found in PATH."
}

& cargo build --manifest-path (Join-Path $repoRoot "rust\Cargo.toml") --package lucida-render-shell --bin lucida-render-shell --release
if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed"
}

$binPath = Join-Path $repoRoot "rust\target\release\lucida-render-shell.exe"
if (-not (Test-Path $binPath)) {
    throw "Expected binary not found: $binPath"
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lucida-msi-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$wxsPath = Join-Path $workDir "lucida-render-shell.wxs"

$escapedBinary = $binPath.Replace("&", "&amp;")
$wxs = @"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Lucida Render Shell" Manufacturer="Lucida" Version="$msiVersion" UpgradeCode="8A20B189-4B10-4755-92C8-6F509A262F5C" Scope="perMachine" Language="1033">
    <SummaryInformation Description="Lucida Render Shell" />
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Lucida Render Shell" />
    </StandardDirectory>
    <Feature Id="MainFeature" Title="Lucida Render Shell" Level="1">
      <ComponentRef Id="LucidaRenderShellComponent" />
    </Feature>
    <Component Id="LucidaRenderShellComponent" Guid="5B8E8A69-0C42-4C66-B5E5-52C2B21E6CCB" Directory="INSTALLFOLDER">
      <File Id="LucidaRenderShellExe" Source="$escapedBinary" KeyPath="yes" />
    </Component>
  </Package>
</Wix>
"@
$wxs | Set-Content -Encoding utf8 -Path $wxsPath

& wix build $wxsPath -arch x64 -o $artifactPath
if ($LASTEXITCODE -ne 0) {
    throw "wix build failed"
}

$unsignedMode = $Unsigned.IsPresent -or $env:UNSIGNED -eq "1"
if (-not $unsignedMode) {
    if (-not $env:WINDOWS_SIGNING_CERT_PFX_BASE64) {
        throw "Missing required environment variable: WINDOWS_SIGNING_CERT_PFX_BASE64"
    }
    if (-not $env:WINDOWS_SIGNING_CERT_PASSWORD) {
        throw "Missing required environment variable: WINDOWS_SIGNING_CERT_PASSWORD"
    }
    if (-not $env:WINDOWS_SIGNING_TIMESTAMP_URL) {
        throw "Missing required environment variable: WINDOWS_SIGNING_TIMESTAMP_URL"
    }

    $signtool = Get-Command signtool -ErrorAction SilentlyContinue
    if (-not $signtool) {
        throw "signtool is required for signed release builds."
    }

    $pfxPath = Join-Path $workDir "lucida-signing-cert.pfx"
    [System.IO.File]::WriteAllBytes($pfxPath, [System.Convert]::FromBase64String($env:WINDOWS_SIGNING_CERT_PFX_BASE64))

    & signtool sign /fd SHA256 /f $pfxPath /p $env:WINDOWS_SIGNING_CERT_PASSWORD /tr $env:WINDOWS_SIGNING_TIMESTAMP_URL /td SHA256 $artifactPath
    if ($LASTEXITCODE -ne 0) {
        throw "signtool sign failed"
    }
    & signtool verify /pa /v $artifactPath
    if ($LASTEXITCODE -ne 0) {
        throw "signtool verify failed"
    }
}

Write-Output $artifactPath
