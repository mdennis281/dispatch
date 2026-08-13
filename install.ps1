$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Dispatch requires Node.js 20 or newer. Install Node, then run this command again."
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

try {
  Write-Host "Downloading the Dispatch release installer..."
  $headers = @{}
  $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -Headers $headers -OutFile $installerPath
  & node $installerPath @args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
