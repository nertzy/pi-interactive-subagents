#!/usr/bin/env bash
# setup-bridge.sh — wire up jacek-bridge for use alongside jjuraszek/pi-subagents.
#
# Run once from the repo root or from pi-extension/:
#   bash pi-extension/setup-bridge.sh
#
# Safe to re-run; existing symlinks are left alone.
set -euo pipefail

PKG="$(cd "$(dirname "$0")" && pwd)"
EXT="${HOME}/.pi/agent/extensions"

mkdir -p "$EXT/subagents"

symlink() {
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    echo "exists:  $dst"
  elif [ -e "$dst" ]; then
    echo "WARNING: $dst exists and is not a symlink — skipping"
  else
    ln -s "$src" "$dst"
    echo "linked:  $dst"
  fi
}

symlink "$PKG/jacek-bridge.ts"            "$EXT/jacek-bridge.ts"
symlink "$PKG/subagents/cmux.ts"          "$EXT/subagents/cmux.ts"
symlink "$PKG/subagents/session.ts"       "$EXT/subagents/session.ts"
symlink "$PKG/subagents/activity.ts"      "$EXT/subagents/activity.ts"
symlink "$PKG/subagents/subagent-done.ts" "$EXT/subagents/subagent-done.ts"

echo ""
echo "Done. Reload pi with /reload."
