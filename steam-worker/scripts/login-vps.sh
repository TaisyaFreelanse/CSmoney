#!/usr/bin/env bash
# Steam login helper for Linux VPS / VNC / SSH.
# Headful Chrome needs a real X11 session: DISPLAY + cookie (XAUTHORITY) + often dbus.
# If checks fail → headless (or copy profiles/accN from your PC after logging in locally).
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT="${1:?Usage: bash scripts/login-vps.sh <accountId|profile-path>}"
ENV_FILE="${STEAM_WORKER_ENV_FILE:-.env}"

# Pick Steam cookie file if unset (Chromium often fails without this even when xset works).
maybe_xauthority() {
  if [[ -n "${XAUTHORITY:-}" && -f "$XAUTHORITY" ]]; then
    return 0
  fi
  for cand in "$HOME/.Xauthority" "/root/.Xauthority"; do
    if [[ -f "$cand" ]]; then
      export XAUTHORITY="$cand"
      return 0
    fi
  done
  return 0
}

can_talk_to_x() {
  [[ -n "${DISPLAY:-}" ]] || return 1
  maybe_xauthority
  if command -v xdpyinfo >/dev/null 2>&1; then
    xdpyinfo >/dev/null 2>&1
  else
    command -v xset >/dev/null 2>&1 && xset q >/dev/null 2>&1
  fi
}

run_headful() {
  export GDK_BACKEND=x11
  export STEAM_WORKER_HEADLESS=0
  echo "[login-vps] Headful: DISPLAY=${DISPLAY} XAUTHORITY=${XAUTHORITY:-<unset>}"
  echo "[login-vps] Log in in the browser window, then close it or Ctrl+C."
  if command -v dbus-run-session >/dev/null 2>&1; then
    exec dbus-run-session -- node --env-file="$ENV_FILE" scripts/login.mjs "$ACCOUNT"
  fi
  exec node --env-file="$ENV_FILE" scripts/login.mjs "$ACCOUNT"
}

if can_talk_to_x; then
  run_headful
else
  echo "[login-vps] X11 not usable from this shell (try: same user as VNC, echo \$DISPLAY, ls -la ~/.Xauthority)."
  echo "[login-vps] Falling back to STEAM_WORKER_HEADLESS=1 (headless)."
  export STEAM_WORKER_HEADLESS=1
  exec node --env-file="$ENV_FILE" scripts/login.mjs "$ACCOUNT"
fi
