#!/usr/bin/env bash
# scripts/phase4-c2b.sh
#
# Phase 4.0-C2b: Build and run the Local Storage necessity verifier,
# with a bounded repeated stability matrix on fresh roots.
#
# Proves that a full-profile (IndexedDB + Local Storage) and an IDB-only
# profile (IndexedDB only) from the same v11 fixture produce identical
# CherryStudio IndexedDB discovery/read results. Only the full profile
# exposes the Local Storage control marker.
#
# The parent runner:
#  - Creates/owns a unique workspace under /tmp
#  - For each iteration, creates fresh profile copies
#  - Launches Electron with ELECTRON_RUN_AS_NODE unset
#  - Waits for clean child exit
#  - Checks the exact child PID is gone (not process tree)
#  - Deletes copies with bounded retry/backoff, recording actual attempt count
#  - Produces a machine-readable aggregate summary
#
# Usage:
#   scripts/phase4-c2b.sh                           # build + generate (if needed) + run
#   scripts/phase4-c2b.sh --no-build                # skip build
#   scripts/phase4-c2b.sh --iterations=10           # iteration count (default 10)
#   scripts/phase4-c2b.sh --manifest-root=<path>    # use specific staging root
#   scripts/phase4-c2b.sh --regenerate              # force fixture regeneration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Constants ──
FIXTURE_ID="v11a"
MAX_CLEANUP_ATTEMPTS=5
INITIAL_CLEANUP_DELAY_MS=100
PROCESS_EXIT_TIMEOUT_S=10

# ── Cross-platform millisecond timestamp ──
ms_now() {
  python3 -c "import time; print(int(time.time()*1000))"
}

# ── Parse args ──
SKIP_BUILD=false
MANIFEST_ROOT=""
REGENERATE=false
ITERATIONS=10

for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    --manifest-root=*) MANIFEST_ROOT="${arg#--manifest-root=}" ;;
    --regenerate) REGENERATE=true ;;
    --iterations=*) ITERATIONS="${arg#--iterations=}" ;;
  esac
done

# ── Validate iterations ──
if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [ "$ITERATIONS" -lt 1 ]; then
  echo "[phase4-c2b] ERROR: --iterations must be a positive integer, got: $ITERATIONS" >&2
  exit 1
fi

# ── Unique workspace (strictly owned by this runner) ──
WORKSPACE="/tmp/phase4-c2b-ws-$$-$(date +%s)"
mkdir -p "$WORKSPACE"
echo "[phase4-c2b] Workspace: $WORKSPACE"
echo "[phase4-c2b] Iterations: $ITERATIONS"
echo "[phase4-c2b] Fixture: $FIXTURE_ID"

# ── Default manifest root ──
if [ -z "$MANIFEST_ROOT" ]; then
  MANIFEST_ROOT="/tmp/phase4-fixtures-staging-$$"
fi

echo "[phase4-c2b] Manifest root: $MANIFEST_ROOT"

# ── Build ──
if [ "$SKIP_BUILD" = false ]; then
  echo "[phase4-c2b] Building with PHASE4_SPIKE=1 ..."
  PHASE4_SPIKE=1 npx electron-vite build
  echo "[phase4-c2b] Build complete."
  echo ""
fi

# ── Generate fixtures if needed ──
NEED_GENERATE=false

if [ "$REGENERATE" = true ]; then
  echo "[phase4-c2b] --regenerate specified, will regenerate fixtures."
  NEED_GENERATE=true
  rm -rf "$MANIFEST_ROOT"
fi

if [ ! -d "$MANIFEST_ROOT" ]; then
  echo "[phase4-c2b] Staging root does not exist, will generate fixtures."
  NEED_GENERATE=true
fi

# Check if the required fixture exists
if [ "$NEED_GENERATE" = false ]; then
  if [ ! -d "$MANIFEST_ROOT/$FIXTURE_ID" ] || [ ! -f "$MANIFEST_ROOT/$FIXTURE_ID/staged-manifest.json" ]; then
    echo "[phase4-c2b] Missing fixture $FIXTURE_ID, will regenerate."
    NEED_GENERATE=true
  fi
fi

if [ "$NEED_GENERATE" = true ]; then
  echo "[phase4-c2b] Generating fixtures..."
  echo ""
  bash "$SCRIPT_DIR/phase4-fixtures.sh" --no-build
  GENERATED_ROOT="/tmp/phase4-fixtures-staging-$$"
  if [ -d "$GENERATED_ROOT" ]; then
    MANIFEST_ROOT="$GENERATED_ROOT"
    echo "[phase4-c2b] Using generated staging root: $MANIFEST_ROOT"
  else
    echo "[phase4-c2b] ERROR: Could not locate generated staging root."
    echo "[phase4-c2b] Expected: $GENERATED_ROOT"
    exit 1
  fi
fi

# ── Validate fixture source exists ──
FIXTURE_SOURCE="$MANIFEST_ROOT/$FIXTURE_ID"
if [ ! -d "$FIXTURE_SOURCE/IndexedDB" ]; then
  echo "[phase4-c2b] ERROR: IndexedDB directory not found in fixture: $FIXTURE_SOURCE/IndexedDB" >&2
  exit 1
fi

# Check if Local Storage exists in fixture
HAS_LOCAL_STORAGE=false
if [ -d "$FIXTURE_SOURCE/Local Storage" ]; then
  HAS_LOCAL_STORAGE=true
  echo "[phase4-c2b] Fixture has Local Storage directory."
else
  echo "[phase4-c2b] WARNING: Fixture has no Local Storage directory. LS marker test will be limited."
fi

echo ""
echo "[phase4-c2b] Starting stability matrix: $ITERATIONS iterations."
echo ""

# ── Helpers ──

# Canonicalize a path (POSIX)
canonicalize_path() {
  python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1"
}

# Delete a path with bounded retry/backoff.
# Validates the target is a strict child of the workspace before deleting.
# On success, sets the global CLEANUP_ACTUAL_ATTEMPTS to the number of
# attempts used (1 = first try succeeded). On failure, sets it to
# MAX_CLEANUP_ATTEMPTS.
delete_with_retry() {
  local target="$1"
  local attempt=1
  local delay_ms=$INITIAL_CLEANUP_DELAY_MS
  local cleanup_start_ms
  cleanup_start_ms=$(ms_now)
  CLEANUP_ACTUAL_ATTEMPTS=0

  # Canonicalize and verify target is a strict child of workspace
  local canonical_target canonical_workspace
  canonical_target=$(canonicalize_path "$target")
  canonical_workspace=$(canonicalize_path "$WORKSPACE")

  if [ "$canonical_target" = "$canonical_workspace" ]; then
    echo "  CLEANUP ERROR: Refusing to delete workspace root itself: $target" >&2
    CLEANUP_ACTUAL_ATTEMPTS=0
    return 1
  fi

  case "$canonical_target" in
    "$canonical_workspace"/*) ;;  # OK — strict child
    *)
      echo "  CLEANUP ERROR: Target is not a strict child of workspace: $target (canonical: $canonical_target)" >&2
      CLEANUP_ACTUAL_ATTEMPTS=0
      return 1
      ;;
  esac

  while [ $attempt -le $MAX_CLEANUP_ATTEMPTS ]; do
    if rm -rf "$target" 2>/dev/null; then
      if [ ! -e "$target" ]; then
        local cleanup_end_ms
        cleanup_end_ms=$(ms_now)
        local cleanup_duration=$((cleanup_end_ms - cleanup_start_ms))
        CLEANUP_ACTUAL_ATTEMPTS=$attempt
        echo "  Cleanup OK on attempt $attempt (${cleanup_duration}ms): $target"
        return 0
      fi
    fi
    echo "  Cleanup attempt $attempt failed, retrying in ${delay_ms}ms..."
    sleep "$(python3 -c "print($delay_ms / 1000.0)")"
    delay_ms=$((delay_ms * 2))
    attempt=$((attempt + 1))
  done

  CLEANUP_ACTUAL_ATTEMPTS=$MAX_CLEANUP_ATTEMPTS
  echo "  CLEANUP FAILED after $MAX_CLEANUP_ATTEMPTS attempts: $target" >&2
  return 1
}

# Check that the exact PID is no longer running. Bounded wait.
# NOTE: This checks only the specific PID via kill -0, NOT the full process
# tree. A bounded process-tree check would require pgrep/pstree which could
# match unrelated processes on shared hosts. The direct child PID is what
# we control and what the shell `wait` operates on.
check_pid_gone() {
  local pid=$1
  local attempt=1
  local max_attempts=$((PROCESS_EXIT_TIMEOUT_S * 2))  # check every 0.5s

  while [ $attempt -le $max_attempts ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
    attempt=$((attempt + 1))
  done

  echo "  WARNING: PID $pid still alive after ${PROCESS_EXIT_TIMEOUT_S}s (exact PID check only)" >&2
  return 1
}

# ── Iteration loop ──
ITER_RESULTS=()
TOTAL_PASS=0
TOTAL_FAIL=0

for i in $(seq 1 "$ITERATIONS"); do
  ITER_WS="$WORKSPACE/iter-$i"
  FULL_PROFILE="$ITER_WS/full-profile"
  IDB_ONLY="$ITER_WS/idb-only"
  OUTPUT_FILE="$ITER_WS/output.log"

  echo "═══════════════════════════════════════════════════════════"
  echo "  Iteration $i / $ITERATIONS"
  echo "═══════════════════════════════════════════════════════════"

  ITER_START_MS=$(ms_now)
  ITER_STATUS="UNKNOWN"
  ITER_EXIT_CODE=-1
  CLEANUP_ATTEMPTS=0
  CLEANUP_ACTUAL_ATTEMPTS=0
  CLEANUP_DURATION_MS=0
  PROCESS_GONE=true
  PARSED_STATUS="UNKNOWN"

  # ── Create iteration workspace ──
  mkdir -p "$FULL_PROFILE" "$IDB_ONLY"

  # ── Copy full profile (IndexedDB + Local Storage) ──
  cp -R "$FIXTURE_SOURCE/IndexedDB" "$FULL_PROFILE/IndexedDB"
  if [ "$HAS_LOCAL_STORAGE" = true ]; then
    cp -R "$FIXTURE_SOURCE/Local Storage" "$FULL_PROFILE/Local Storage"
  fi

  # ── Copy IDB-only profile (IndexedDB only, NO Local Storage) ──
  cp -R "$FIXTURE_SOURCE/IndexedDB" "$IDB_ONLY/IndexedDB"

  echo "  Profiles created:"
  echo "    Full: $FULL_PROFILE"
  echo "    IDB:  $IDB_ONLY"

  # ── Launch Electron child ──
  CHILD_PID=""
  env -u ELECTRON_RUN_AS_NODE npx electron . --phase4-spike --c2b="$ITER_WS" > "$OUTPUT_FILE" 2>&1 &
  CHILD_PID=$!
  echo "  Electron child PID: $CHILD_PID"

  # ── Wait for child exit ──
  wait "$CHILD_PID" 2>/dev/null
  ITER_EXIT_CODE=$?
  ITER_END_MS=$(ms_now)
  ITER_DURATION=$((ITER_END_MS - ITER_START_MS))

  echo "  Exit code: $ITER_EXIT_CODE"
  echo "  Duration: ${ITER_DURATION}ms"

  # ── Parse summary from child output ──
  if [ -f "$OUTPUT_FILE" ]; then
    SUMMARY_LINE=$(grep '^\[phase4-c2b-summary\] ' "$OUTPUT_FILE" | tail -1 | sed 's/^\[phase4-c2b-summary\] //' || true)
    if [ -n "$SUMMARY_LINE" ]; then
      PARSED_STATUS=$(echo "$SUMMARY_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allPassed', False))" 2>/dev/null || echo "PARSE_ERROR")
      echo "  Parsed allPassed: $PARSED_STATUS"
    else
      echo "  WARNING: No [phase4-c2b-summary] line in output"
      PARSED_STATUS="NO_SUMMARY"
    fi
  fi

  # ── Determine iteration status ──
  if [ "$ITER_EXIT_CODE" -eq 0 ] && [ "$PARSED_STATUS" = "True" ]; then
    ITER_STATUS="PASS"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    ITER_STATUS="FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    echo "  FAILURE DETAILS:"
    if [ -f "$OUTPUT_FILE" ]; then
      tail -30 "$OUTPUT_FILE" | sed 's/^/    /'
    fi
  fi

  # ── Check exact child PID is gone (not full process tree) ──
  if ! check_pid_gone "$CHILD_PID"; then
    PROCESS_GONE=false
    echo "  WARNING: Child PID $CHILD_PID did not exit cleanly (exact PID check)"
  fi

  # ── Cleanup with bounded retry ──
  CLEANUP_START_MS=$(ms_now)
  CLEANUP_ACTUAL_ATTEMPTS=0
  if delete_with_retry "$ITER_WS"; then
    CLEANUP_ATTEMPTS=$CLEANUP_ACTUAL_ATTEMPTS
    CLEANUP_END_MS=$(ms_now)
    CLEANUP_DURATION_MS=$((CLEANUP_END_MS - CLEANUP_START_MS))
  else
    CLEANUP_ATTEMPTS=$CLEANUP_ACTUAL_ATTEMPTS
    CLEANUP_END_MS=$(ms_now)
    CLEANUP_DURATION_MS=$((CLEANUP_END_MS - CLEANUP_START_MS))
    echo "  CLEANUP FAILED: $ITER_WS still exists"
  fi

  echo "  Status: $ITER_STATUS | Duration: ${ITER_DURATION}ms | CleanupAttempts: ${CLEANUP_ATTEMPTS} (${CLEANUP_DURATION_MS}ms) | ProcessGone: $PROCESS_GONE"
  echo ""

  # Record result as a line
  ITER_RESULTS+=("$(printf '{"index":%d,"status":"%s","exitCode":%d,"durationMs":%d,"cleanupAttempts":%d,"cleanupDurationMs":%d,"processGone":%s,"parsedStatus":"%s"}' \
    "$i" "$ITER_STATUS" "$ITER_EXIT_CODE" "$ITER_DURATION" "$CLEANUP_ATTEMPTS" "$CLEANUP_DURATION_MS" "$PROCESS_GONE" "$PARSED_STATUS")")
done

# ── Check no owned roots remain ──
REMAINING_ROOTS=""
if [ -d "$WORKSPACE" ]; then
  REMAINING_ROOTS=$(find "$WORKSPACE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -20 || true)
fi

# ── Aggregate summary ──
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  AGGREGATE SUMMARY"
echo "═══════════════════════════════════════════════════════════════"

# Get Electron/Chromium/Node versions from the build
ELECTRON_VER=$(npx electron --version 2>/dev/null || echo "unknown")
NODE_VER=$(node --version 2>/dev/null || echo "unknown")
PLATFORM=$(uname -s)
ARCH=$(uname -m)

ITER_JSON_ARRAY=$(printf '%s\n' "${ITER_RESULTS[@]}" | paste -sd',' -)

cat <<ENDJSON
[phase4-c2b-aggregate]
{
  "phase": "4.0-C2b-aggregate",
  "platform": "$PLATFORM",
  "arch": "$ARCH",
  "electron": "$ELECTRON_VER",
  "node": "$NODE_VER",
  "fixtureId": "$FIXTURE_ID",
  "iterationCount": $ITERATIONS,
  "passCount": $TOTAL_PASS,
  "failCount": $TOTAL_FAIL,
  "iterations": [$ITER_JSON_ARRAY],
  "remainingRoots": "$REMAINING_ROOTS",
  "workspace": "$WORKSPACE",
  "windowsLinuxUntested": true,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON

echo ""

# ── Final workspace cleanup ──
echo "[phase4-c2b] Cleaning up workspace: $WORKSPACE"
if [ -n "$REMAINING_ROOTS" ]; then
  echo "[phase4-c2b] WARNING: Remaining iteration roots found, attempting cleanup..."
  for remaining in $REMAINING_ROOTS; do
    delete_with_retry "$remaining" || true
  done
fi

# Remove workspace itself (it's the top-level owned dir)
if [ -d "$WORKSPACE" ]; then
  rm -rf "$WORKSPACE" 2>/dev/null || true
  if [ -d "$WORKSPACE" ]; then
    echo "[phase4-c2b] WARNING: Could not remove workspace: $WORKSPACE"
  else
    echo "[phase4-c2b] Workspace cleaned."
  fi
fi

# ── Exit ──
echo ""
if [ "$TOTAL_FAIL" -eq 0 ] && [ "$TOTAL_PASS" -eq "$ITERATIONS" ]; then
  echo "[phase4-c2b] Phase 4.0-C2b stability matrix: ALL $TOTAL_PASS/$ITERATIONS PASS"
  exit 0
else
  echo "[phase4-c2b] Phase 4.0-C2b stability matrix: $TOTAL_PASS/$ITERATIONS PASS, $TOTAL_FAIL FAIL"
  exit 1
fi
