#!/usr/bin/env bash
# Steam login helper for Linux VPS / VNC / SSH.
# - If DISPLAY works (e.g. terminal opened inside VNC desktop): headful Chrome on that X server.
# - Else: headless Chrome (no X needed; complete login if Steam allows it, or copy profile from your PC).
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT="${1:?Usage: bash scripts/login-vps.sh <accountId|profile-path>}"
ENV_FILE="${STEAM_WORKER_ENV_FILE:-.env}"

have_x() {
  [[ -n "${DISPLAY:-}" ]] || return 1
  command -v xset >/dev/null 2>&1 || return 1
  xset q >/dev/null 2>&1
}

if have_x; then
  echo "[login-vps] Using DISPLAY=$DISPLAY (headful). Log in in the browser window, then close it or Ctrl+C."
  export STEAM_WORKER_HEADLESS=0
else
  echo "[login-vps] No working DISPLAY (open a terminal inside the VNC desktop, not only SSH, for a visible window)."
  echo "[login-vps] Falling back to STEAM_WORKER_HEADLESS=1 (headless)."
  export STEAM_WORKER_HEADLESS=1
fi

exec node --env-file="$ENV_FILE" scripts/login.mjs "$ACCOUNT"
