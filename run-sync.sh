#!/bin/bash
set -u

DIR="/Users/adriennkazup/Downloads/Coding/cleaning-calendar"
NODE="/usr/local/bin/node"
STATE_DIR="$HOME/Library/Application Support/cleaning-calendar"
MARKER="$STATE_DIR/last-sync-success"
LOG_DIR="$HOME/Library/Logs/cleaning-calendar"
LOG="$LOG_DIR/sync.log"

mkdir -p "$STATE_DIR" "$LOG_DIR"

if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1048576 ]; then
  mv "$LOG" "$LOG.1"
fi

exec >> "$LOG" 2>&1

TODAY="$(date +%Y-%m-%d)"

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$TODAY" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already synced today, skipping."
  exit 0
fi

cd "$DIR" || exit 1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting sync..."

if "$NODE" sync.js; then
  echo "$TODAY" > "$MARKER"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sync finished successfully."
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sync FAILED."
  exit 1
fi

