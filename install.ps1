$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Dispatch requires Node.js 20 or newer. Install Node, then run this command again."
}

$installerUrl = if ($env:DISPATCH_INSTALLER_URL) {
  $env:DISPATCH_INSTALLER_URL
} else {
  "https://raw.githubusercontent.com/mdennis281/dispatch/main/tools/install.mjs"
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
