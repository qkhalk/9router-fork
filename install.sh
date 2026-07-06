#!/usr/bin/env bash
# 9Router installer (macOS / Linux / WSL).
#
# 9Router is distributed as a prebuilt tarball on GitHub Releases (not on npm).
# This script installs the latest release globally via npm.
#
#   curl -fsSL https://github.com/vibecoder11200/9router/raw/master/install.sh | bash
#
# Requires Node.js >= 18 and npm.

set -euo pipefail

GH_OWNER="vibecoder11200"
GH_REPO="9router"
TARBALL_URL="https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download/9router.tgz"

# --- preflight: node + npm ---------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed (or not on PATH)." >&2
  echo "   Install Node.js >= 18 from https://nodejs.org and re-run this script." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm is not installed (or not on PATH)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node.js $(node -v) is too old. 9Router requires Node.js >= 18." >&2
  exit 1
fi

# Resolve the latest version for display (best-effort; not required for install).
LATEST_VERSION="$(curl -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: 9router-installer' \
  "https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest" \
  2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tag_name||"")}catch{console.log("")}})' || true)"

echo "⬇  Installing 9Router${LATEST_VERSION:+ ($LATEST_VERSION)} from GitHub Releases..."
echo "   $TARBALL_URL"

# Global installs may need sudo when node was installed via system package manager.
NPM_INSTALL="npm install -g \"$TARBALL_URL\""
if [ "$(id -u)" = "0" ] || npm config get prefix >/dev/null 2>&1 && [ -w "$(npm config get prefix)/lib" ] 2>/dev/null \
   || [ -w "$(npm -g --depth=0 >/dev/null 2>&1; dirname "$(npm root -g 2>/dev/null)")" ] 2>/dev/null; then
  eval "$NPM_INSTALL"
else
  echo "   Global prefix not writable — retrying with sudo."
  sudo sh -c "$NPM_INSTALL"
fi

if ! command -v 9router >/dev/null 2>&1; then
  echo "" >&2
  echo "⚠  9Router installed, but '9router' is not on your PATH." >&2
  echo "   Add the npm global bin dir to your PATH, or run:" >&2
  echo "     $(npm bin -g 2>/dev/null || echo '$(npm prefix -g)/bin')/9router" >&2
  exit 0
fi

echo ""
echo "✅ 9Router installed. Run: 9router"
