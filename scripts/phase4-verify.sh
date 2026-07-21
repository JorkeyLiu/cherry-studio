#!/usr/bin/env bash
# scripts/phase4-verify.sh
#
# Phase 4.0-C1: Build and run the production-Dexie source reader verification
# against staged pre-populated fixture profiles.
#
# If the staging root does not exist, generates fixtures first.
#
# Usage:
#   scripts/phase4-verify.sh                           # build + generate (if needed) + verify
#   scripts/phase4-verify.sh --no-build                # skip build
#   scripts/phase4-verify.sh --manifest-root=<path>    # use specific staging root
#   scripts/phase4-verify.sh --regenerate              # force fixture regeneration
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
  # Use a deterministic path based on the PID of this script's parent
  MANIFEST_ROOT="/tmp/phase4-fixtures-staging-$$"
fi

echo "[phase4-verify] Manifest root: $MANIFEST_ROOT"

# ── Build ──
if [ "$SKIP_BUILD" = false ]; then
  echo "[phase4-verify] Building with PHASE4_SPIKE=1 ..."
  PHASE4_SPIKE=1 npx electron-vite build
  echo "[phase4-verify] Build complete."
  echo ""
fi

# ── Generate fixtures if needed ──
NEED_GENERATE=false

if [ "$REGENERATE" = true ]; then
  echo "[phase4-verify] --regenerate specified, will regenerate fixtures."
  NEED_GENERATE=true
  rm -rf "$MANIFEST_ROOT"
fi

if [ ! -d "$MANIFEST_ROOT" ]; then
  echo "[phase4-verify] Staging root does not exist, will generate fixtures."
  NEED_GENERATE=true
fi

# Check if all expected fixture directories exist
if [ "$NEED_GENERATE" = false ]; then
  for FIXTURE in v4 v11a v11b v12; do
    if [ ! -d "$MANIFEST_ROOT/$FIXTURE" ] || [ ! -f "$MANIFEST_ROOT/$FIXTURE/staged-manifest.json" ]; then
      echo "[phase4-verify] Missing fixture $FIXTURE, will regenerate."
      NEED_GENERATE=true
      break
    fi
  done
fi

if [ "$NEED_GENERATE" = true ]; then
  echo "[phase4-verify] Generating fixtures..."
  echo ""
  # Use the fixtures script with --no-build (we already built)
  bash "$SCRIPT_DIR/phase4-fixtures.sh" --no-build
  # The fixtures script creates its own staging root; use that if we didn't specify one
  if [ -z "${MANIFEST_ROOT_OVERRIDE:-}" ]; then
    # Find the staging root the fixtures script created
    # The fixtures script uses /tmp/phase4-fixtures-staging-$$ where $$ is its own PID
    # We need to find it. The script echoes the staging root.
    # Actually, let's just use the fixtures script directly with the right path.
    GENERATED_ROOT="/tmp/phase4-fixtures-staging-$$"
    if [ -d "$GENERATED_ROOT" ]; then
      MANIFEST_ROOT="$GENERATED_ROOT"
      echo "[phase4-verify] Using generated staging root: $MANIFEST_ROOT"
    else
      echo "[phase4-verify] ERROR: Could not locate generated staging root."
      echo "[phase4-verify] Expected: $GENERATED_ROOT"
      echo "[phase4-verify] Try: scripts/phase4-fixtures.sh first, then scripts/phase4-verify.sh --no-build --manifest-root=<path>"
      exit 1
    fi
  fi
fi

echo ""
echo "[phase4-verify] Running C1 verification against: $MANIFEST_ROOT"
echo ""

# ── Run verifier ──
env -u ELECTRON_RUN_AS_NODE npx electron . --phase4-spike --verify="$MANIFEST_ROOT"
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "[phase4-verify] Phase 4.0-C1 verification: PASS (exit 0)."
else
  echo "[phase4-verify] Phase 4.0-C1 verification: FAIL (exit $EXIT_CODE)."
fi

exit $EXIT_CODE
