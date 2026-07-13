#!/usr/bin/env bash
# setup-bridge.sh — wire up cohort-bridge for use alongside jjuraszek's
# pi-cohort (formerly pi-subagents).
#
# Run once from the repo root or from pi-extension/:
#   bash pi-extension/setup-bridge.sh
#
# Safe to re-run; existing symlinks are left alone.
set -euo pipefail

PKG="$(cd "$(dirname "$0")" && pwd)"
EXT="${HOME}/.pi/agent/extensions"

mkdir -p "$EXT/subagents"

# Migrate from the bridge's old name.
if [ -L "$EXT/jacek-bridge.ts" ]; then
  rm "$EXT/jacek-bridge.ts"
  echo "removed: $EXT/jacek-bridge.ts (renamed to cohort-bridge.ts)"
fi

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

symlink "$PKG/cohort-bridge.ts"              "$EXT/cohort-bridge.ts"
symlink "$PKG/subagents/cmux.ts"            "$EXT/subagents/cmux.ts"
symlink "$PKG/subagents/session.ts"         "$EXT/subagents/session.ts"
symlink "$PKG/subagents/activity.ts"        "$EXT/subagents/activity.ts"
symlink "$PKG/subagents/subagent-done.ts"   "$EXT/subagents/subagent-done.ts"
symlink "$PKG/subagents/persona-resolve.ts" "$EXT/subagents/persona-resolve.ts"
symlink "$PKG/subagents/output.ts"          "$EXT/subagents/output.ts"

echo ""
echo "Done. Reload pi with /reload."
