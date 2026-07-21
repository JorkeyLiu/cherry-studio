#!/usr/bin/env bash
# scripts/phase4-c2a.sh
#
# Phase 4.0-C2a: Build and run the retained-session isolation verifier.
#
# Proves in one Electron process that multiple session.fromPath() profiles
# and the default session remain isolated, that v11-A and v11-B do not
# cross-contaminate, and that a wrong-origin probe confirms CherryStudio
# absent at a different origin.
#
# If the staging root does not exist, generates fixtures first (using C1 flow).
#
# Usage:
#   scripts/phase4-c2a.sh                           # build + generate (if needed) + C2a
#   scripts/phase4-c2a.sh --no-build                # skip build
#   scripts/phase4-c2a.sh --manifest-root=<path>    # use specific staging root
#   scripts/phase4-c2a.sh --regenerate              # force fixture regeneration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Parse args ──
SKIP_BUILD=false
MANIFEST_ROOT=""
REGENERATE=false

for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    --manifest-root=*) MANIFEST_ROOT="${arg#--manifest-root=}" ;;
    --regenerate) REGENERATE=true ;;
  esac
done

# ── Default manifest root ──
if [ -z "$MANIFEST_ROOT" ]; then
  MANIFEST_ROOT="/tmp/phase4-fixtures-staging-$$"
fi

echo "[phase4-c2a] Manifest root: $MANIFEST_ROOT"

# ── Build ──
if [ "$SKIP_BUILD" = false ]; then
  echo "[phase4-c2a] Building with PHASE4_SPIKE=1 ..."
  PHASE4_SPIKE=1 npx electron-vite build
  echo "[phase4-c2a] Build complete."
  echo ""
fi

# ── Generate fixtures if needed ──
NEED_GENERATE=false

if [ "$REGENERATE" = true ]; then
  echo "[phase4-c2a] --regenerate specified, will regenerate fixtures."
  NEED_GENERATE=true
  rm -rf "$MANIFEST_ROOT"
fi

if [ ! -d "$MANIFEST_ROOT" ]; then
  echo "[phase4-c2a] Staging root does not exist, will generate fixtures."
  NEED_GENERATE=true
fi

# Check if all expected fixture directories exist
if [ "$NEED_GENERATE" = false ]; then
  for FIXTURE in v11a v11b; do
    if [ ! -d "$MANIFEST_ROOT/$FIXTURE" ] || [ ! -f "$MANIFEST_ROOT/$FIXTURE/staged-manifest.json" ]; then
      echo "[phase4-c2a] Missing fixture $FIXTURE, will regenerate."
      NEED_GENERATE=true
      break
    fi
  done
fi

if [ "$NEED_GENERATE" = true ]; then
  echo "[phase4-c2a] Generating fixtures..."
  echo ""
  bash "$SCRIPT_DIR/phase4-fixtures.sh" --no-build
  GENERATED_ROOT="/tmp/phase4-fixtures-staging-$$"
  if [ -d "$GENERATED_ROOT" ]; then
    MANIFEST_ROOT="$GENERATED_ROOT"
    echo "[phase4-c2a] Using generated staging root: $MANIFEST_ROOT"
  else
    echo "[phase4-c2a] ERROR: Could not locate generated staging root."
    echo "[phase4-c2a] Expected: $GENERATED_ROOT"
    echo "[phase4-c2a] Try: scripts/phase4-fixtures.sh first, then scripts/phase4-c2a.sh --no-build --manifest-root=<path>"
    exit 1
  fi
fi

echo ""
echo "[phase4-c2a] Running C2a retained-session isolation verifier against: $MANIFEST_ROOT"
echo ""

# ── Run C2a verifier ──
env -u ELECTRON_RUN_AS_NODE npx electron . --phase4-spike --c2a="$MANIFEST_ROOT"
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "[phase4-c2a] Phase 4.0-C2a verification: PASS (exit 0)."
else
  echo "[phase4-c2a] Phase 4.0-C2a verification: FAIL (exit $EXIT_CODE)."
fi

exit $EXIT_CODE
