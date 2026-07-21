#!/usr/bin/env bash
# scripts/phase4-fixtures.sh
#
# Phase 4.0-B: Generate deterministic synthetic IndexedDB fixtures and stage
# them into candidate roots for Phase 4.0-C verification.
#
# Each fixture is generated in a fresh isolated Electron process. After
# process exit, the parent copies the IndexedDB data to a staging directory.
# No writes occur outside the owned temporary workspace.
#
# Usage:
#   scripts/phase4-fixtures.sh              # build + generate all fixtures
#   scripts/phase4-fixtures.sh --no-build   # generate only (skip build)
#   scripts/phase4-fixtures.sh --fixture=v4 # generate a single fixture
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Parse args ──
SKIP_BUILD=false
SINGLE_FIXTURE=""
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    --fixture=*) SINGLE_FIXTURE="${arg#--fixture=}" ;;
  esac
done

ALL_FIXTURES=(v4 v11a v11b v12)
if [ -n "$SINGLE_FIXTURE" ]; then
  ALL_FIXTURES=("$SINGLE_FIXTURE")
fi

# ── Staging root: deterministic temp path ──
STAGING_ROOT="/tmp/phase4-fixtures-staging-$$"
mkdir -p "$STAGING_ROOT"

echo "[phase4-fixtures] Staging root: $STAGING_ROOT"
echo "[phase4-fixtures] Fixtures: ${ALL_FIXTURES[*]}"
echo ""

# ── Build ──
if [ "$SKIP_BUILD" = false ]; then
  echo "[phase4-fixtures] Building with PHASE4_SPIKE=1 ..."
  PHASE4_SPIKE=1 npx electron-vite build
  echo "[phase4-fixtures] Build complete."
  echo ""
fi

# ── Helper: validate path is under system temp dir ──
# POSIX-only: uses os.path.realpath with '/' separator.
# Acceptable for spike harness on macOS/Linux only.
validate_tmp_path() {
  local p="$1"
  local resolved_p resolved_tmp
  resolved_p=$(python3 -c "import sys, os.path; print(os.path.realpath(sys.argv[1]))" "$p")
  resolved_tmp=$(python3 -c "import sys, os, os.path; print(os.path.realpath(os.environ.get('TMPDIR', '/tmp')))")
  case "$resolved_p" in
    "$resolved_tmp"/*|"$resolved_tmp") ;;  # OK
    *)
      echo "[phase4-fixtures] SECURITY: path not under temp dir ($resolved_tmp): $resolved_p" >&2
      exit 1
      ;;
  esac
}

# ── Generate and stage each fixture ──
MANIFESTS=()
FAILED=false

for FIXTURE in "${ALL_FIXTURES[@]}"; do
  echo "────────────────────────────────────────────────────────"
  echo "[phase4-fixtures] Generating fixture: $FIXTURE"
  echo ""

  # Run Electron in fixture mode; capture all output
  OUTPUT_FILE="/tmp/phase4-fixture-output-${FIXTURE}-$$.txt"
  env -u ELECTRON_RUN_AS_NODE npx electron . --phase4-spike --fixture="$FIXTURE" > "$OUTPUT_FILE" 2>&1
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "[phase4-fixtures] FAIL: $FIXTURE exited with code $EXIT_CODE"
    echo "[phase4-fixtures] Output:"
    cat "$OUTPUT_FILE"
    rm -f "$OUTPUT_FILE"
    FAILED=true
    break
  fi

  # Extract manifest JSON from the tagged line
  MANIFEST_LINE=$(grep '^\[phase4-spike-manifest\] ' "$OUTPUT_FILE" | tail -1 | sed 's/^\[phase4-spike-manifest\] //')
  rm -f "$OUTPUT_FILE"

  if [ -z "$MANIFEST_LINE" ]; then
    echo "[phase4-fixtures] FAIL: no manifest line in output for $FIXTURE"
    FAILED=true
    break
  fi

  # Parse source root from manifest
  SOURCE_ROOT=$(echo "$MANIFEST_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin)['sourceRoot'])" 2>/dev/null)
  FIXTURE_ID=$(echo "$MANIFEST_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin)['fixtureId'])" 2>/dev/null)

  if [ -z "$SOURCE_ROOT" ] || [ -z "$FIXTURE_ID" ]; then
    echo "[phase4-fixtures] FAIL: could not parse manifest for $FIXTURE"
    FAILED=true
    break
  fi

  # Validate source root is under /tmp
  validate_tmp_path "$SOURCE_ROOT"

  # Create destination
  DEST_ROOT="$STAGING_ROOT/$FIXTURE_ID"
  if [ -d "$DEST_ROOT" ]; then
    rm -rf "$DEST_ROOT"
  fi
  mkdir -p "$DEST_ROOT"

  # Copy IndexedDB data
  if [ -d "$SOURCE_ROOT/IndexedDB" ]; then
    cp -R "$SOURCE_ROOT/IndexedDB" "$DEST_ROOT/IndexedDB"
    echo "[phase4-fixtures]   IndexedDB copied to $DEST_ROOT/IndexedDB"
  else
    echo "[phase4-fixtures] WARNING: no IndexedDB directory in source root"
  fi

  # Copy Local Storage if present (control marker)
  if [ -d "$SOURCE_ROOT/Local Storage" ]; then
    cp -R "$SOURCE_ROOT/Local Storage" "$DEST_ROOT/Local Storage"
    echo "[phase4-fixtures]   Local Storage copied to $DEST_ROOT/Local Storage"
  fi

  # Write source manifest alongside the data
  echo "$MANIFEST_LINE" > "$DEST_ROOT/manifest.json"

  # Write staged manifest (extends source with destination info)
  STAGED_MANIFEST=$(python3 -c "
import sys, json
m = json.load(sys.stdin)
m['destinationRoot'] = sys.argv[1]
m['copyMode'] = 'full-profile'
json.dump(m, sys.stdout, indent=2)
" "$DEST_ROOT" <<< "$MANIFEST_LINE")
  echo "$STAGED_MANIFEST" > "$DEST_ROOT/staged-manifest.json"

  MANIFESTS+=("$DEST_ROOT/staged-manifest.json")

  # Clean up source root (owned temp path)
  rm -rf "${SOURCE_ROOT%/*}"  # Remove parent userData dir

  echo "[phase4-fixtures] $FIXTURE_ID staged to $DEST_ROOT"
  echo ""
done

# ── Summary ──
echo "════════════════════════════════════════════════════════"
if [ "$FAILED" = true ]; then
  echo "[phase4-fixtures] FAILED — partial results in $STAGING_ROOT"
  exit 1
fi

echo "[phase4-fixtures] All ${#ALL_FIXTURES[@]} fixtures staged successfully."
echo "[phase4-fixtures] Staging root: $STAGING_ROOT"
echo ""
echo "Fixtures:"
for MANIFEST in "${MANIFESTS[@]}"; do
  FIXTURE_ID=$(python3 -c "import sys, json; print(json.load(open(sys.argv[1]))['fixtureId'])" "$MANIFEST")
  LOGICAL_VER=$(python3 -c "import sys, json; print(json.load(open(sys.argv[1]))['logicalDexieVersion'])" "$MANIFEST")
  EXPECTED_VER=$(python3 -c "import sys, json; print(json.load(open(sys.argv[1]))['expectedNativeVersion'])" "$MANIFEST")
  OBSERVED_VER=$(python3 -c "import sys, json; print(json.load(open(sys.argv[1]))['observedNativeVersion'])" "$MANIFEST")
  TABLES=$(python3 -c "import sys, json; print(', '.join(json.load(open(sys.argv[1]))['tables']))" "$MANIFEST")
  echo "  $FIXTURE_ID: logical=v$LOGICAL_VER, expected=$EXPECTED_VER, observed=$OBSERVED_VER, tables=[$TABLES]"
done

echo ""
echo "[phase4-fixtures] Candidate roots ready for Phase 4.0-C verification."
echo "[phase4-fixtures] Done."
