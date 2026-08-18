$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Dispatch requires Node.js 24 or newer. Install Node, then run this command again."
}

$installerUrl = if ($env:DISPATCH_INSTALLER_URL) {
  $env:DISPATCH_INSTALLER_URL
} else {
  $versionIndex = [Array]::IndexOf([object[]]$args, "--version")
  if ($versionIndex -ge 0 -and $versionIndex + 1 -lt $args.Count) {
    $tag = [string]$args[$versionIndex + 1]
    if (-not $tag.StartsWith("v")) { $tag = "v$tag" }
    "https://github.com/mdennis281/dispatch/releases/download/$tag/install.mjs"
  } else {
    "https://github.com/mdennis281/dispatch/releases/latest/download/install.mjs"
  }
}
$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dispatch-installer-{0}.mjs" -f [guid]::NewGuid())
$previousLocation = Get-Location
$previousInstallCwd = $env:DISPATCH_INSTALL_CWD

try {
  Write-Host "Downloading the Dispatch release installer..."
  $headers = @{}
  $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -Headers $headers -OutFile $installerPath
  # Windows will not rename a directory while this PowerShell process has its
  # current location inside it. The one-line installer is often launched from
  # an integrated terminal under app/, so step outside before Node swaps it.
  # Preserve this location separately so relative --target values still resolve
  # as the caller intended after moving to the temporary directory.
  $env:DISPATCH_INSTALL_CWD = $previousLocation.Path
  Set-Location ([System.IO.Path]::GetTempPath())
  & node $installerPath @args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Set-Location $previousLocation -ErrorAction SilentlyContinue
  if ($null -eq $previousInstallCwd) {
    Remove-Item Env:DISPATCH_INSTALL_CWD -ErrorAction SilentlyContinue
  } else {
    $env:DISPATCH_INSTALL_CWD = $previousInstallCwd
  }
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
