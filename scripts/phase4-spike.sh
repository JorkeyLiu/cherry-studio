#!/usr/bin/env bash
# scripts/phase4-spike.sh
#
# Build and launch the Phase 4.0-A spike harness.
# Unsets ELECTRON_RUN_AS_NODE to ensure proper Electron app launch.
#
# Usage:
#   scripts/phase4-spike.sh          # build + launch
#   scripts/phase4-spike.sh --no-build  # launch only (skip build)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
  esac
done

if [ "$SKIP_BUILD" = false ]; then
  echo "[phase4-spike] Building with PHASE4_SPIKE=1 ..."
  PHASE4_SPIKE=1 npx electron-vite build
  echo "[phase4-spike] Build complete."
else
  echo "[phase4-spike] Skipping build (--no-build)."
fi

echo "[phase4-spike] Launching spike harness..."
echo ""

# env -u ELECTRON_RUN_AS_NODE reliably launches Electron without Node-only
# inheritance from the parent shell (Analyzer finding #1).
env -u ELECTRON_RUN_AS_NODE npx electron . --phase4-spike
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "[phase4-spike] Spike completed successfully (exit 0)."
else
  echo "[phase4-spike] Spike failed (exit $EXIT_CODE)."
fi

exit $EXIT_CODE
