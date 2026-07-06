# 9Router installer (Windows / PowerShell).
#
# 9Router is distributed as a prebuilt tarball on GitHub Releases (not on npm).
# This script installs the latest release globally via npm.
#
#   powershell -c "irm https://github.com/vibecoder11200/9router/raw/master/install.ps1 | iex"
#
# Requires Node.js >= 18 and npm.

$ErrorActionPreference = "Stop"

$GH_OWNER = "vibecoder11200"
$GH_REPO  = "9router"
$TARBALL_URL = "https://github.com/$GH_OWNER/$GH_REPO/releases/latest/download/9router.tgz"

# --- preflight: node + npm ---------------------------------------------------
try { $nodeVer = (& node -v) } catch {
    Write-Error "Node.js is not installed (or not on PATH). Install Node.js >= 18 from https://nodejs.org then re-run."
    exit 1
}
$major = [int]($nodeVer -replace '^v(\d+).*','$1')
if ($major -lt 18) {
    Write-Error "Node.js $nodeVer is too old. 9Router requires Node.js >= 18."
    exit 1
}
try { & npm -v | Out-Null } catch {
    Write-Error "npm is not installed (or not on PATH)."
    exit 1
}

# Resolve the latest version for display (best-effort).
$LATEST_VERSION = ""
try {
    $headers = @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "9router-installer" }
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$GH_OWNER/$GH_REPO/releases/latest" -Headers $headers -ErrorAction Stop
    $LATEST_VERSION = $rel.tag_name
} catch { }

$suffix = if ($LATEST_VERSION) { " ($LATEST_VERSION)" } else { "" }
Write-Host "Installing 9Router$suffix from GitHub Releases..."
Write-Host "   $TARBALL_URL"

& npm install -g $TARBALL_URL
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed."; exit $LASTEXITCODE }

$cmd = Get-Command 9router -ErrorAction SilentlyContinue
if (-not $cmd) {
    $npmBin = (& npm prefix -g)
    Write-Warning "9Router installed, but '9router' is not on your PATH."
    Write-Warning "Add the npm global bin dir to PATH, or run: $npmBin\9router.cmd"
    exit 0
}

Write-Host ""
Write-Host "9Router installed. Run: 9router" -ForegroundColor Green
