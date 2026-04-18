#!/usr/bin/env bash
# Run on the VPS from repo root or anywhere: bash scripts/vps-update-restart.sh
# Expects: ~/CSmoney is the git checkout, steam-worker lives at ~/CSmoney/steam-worker
set -euo pipefail

ROOT="${CSMONEY_ROOT:-$HOME/CSmoney}"
SW="$ROOT/steam-worker"
cd "$ROOT"

git pull

cd "$SW"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# VPS: headless if variable is missing (safe default). If you use VNC + headful, set STEAM_WORKER_HEADLESS=0 in .env yourself.
if [ -f .env ] && ! grep -qE '^[[:space:]]*STEAM_WORKER_HEADLESS=' .env; then
  printf '\n# Added by vps-update-restart.sh (no display / SSH default)\nSTEAM_WORKER_HEADLESS=1\n' >> .env
fi

if [ -f .env ] && ! grep -qE '^[[:space:]]*#.*PROXY' .env; then
  :
fi

# Stop whatever listens on worker PORT (default 3001)
PORT="${PORT:-3001}"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi
if command -v lsof >/dev/null 2>&1; then
  for p in $(lsof -t -i:"${PORT}" 2>/dev/null || true); do
    kill -9 "$p" 2>/dev/null || true
  done
fi
sleep 1

nohup node --env-file=.env server.js >> steam-worker.log 2>&1 &
echo "steam-worker PID $! log: $SW/steam-worker.log"
sleep 1
tail -n 8 steam-worker.log || true
