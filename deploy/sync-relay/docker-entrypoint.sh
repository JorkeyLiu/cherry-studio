#!/bin/sh
# Cherry Chat personal sync relay — Docker entrypoint (Linux x64/arm64).
#
# Runs relay first-start initialization (creates the bearer token once,
# reuses afterwards, fails closed on corruption; optionally writes a small
# public config when RELAY_PUBLIC_URL is set), then `exec`s the unchanged
# relay CLI so it keeps its own startup order (token/TLS validation before
# DB open/listen) and receives SIGTERM/SIGINT directly for graceful
# shutdown. `exec` replaces this shell: no trap/proxy is needed and no extra
# process stays between PID 1 and the relay. The relay is launched via
# `exec node /app/node_modules/tsx/dist/cli.mjs` (the installed tsx CLI,
# bin `./dist/cli.mjs`) so the relay server itself is PID 1 — never an
# npx/npm wrapper, which would intercept SIGTERM and exit non-zero.
#
# Standard bridge networking: the relay binds the container-internal 0.0.0.0
# address (deployment-scoped --allow-unspecified-bind); Docker publishes the
# port to the host via `ports:` in docker-compose.yml. 0.0.0.0 is never a
# user-facing advertised endpoint.
#
# Reads: RELAY_PORT (default 3030), RELAY_DATA_DIR (default /data),
# RELAY_NAME (default cherry-relay), RELAY_TOKEN_FILE (default
# <data-dir>/relay-token), RELAY_PUBLIC_URL (optional; when unset no public
# config is written and users enter the endpoint manually),
# RELAY_TLS_CERT_FILE/RELAY_TLS_KEY_FILE (optional user-supplied
# certificate/key passthrough pair for HTTPS; the relay never generates
# certificates itself).
# Provides the token to the relay via the SYNC_RELAY_TOKEN env fallback so
# the secret never appears in the process argument list.
# Restrictive creation mask first so DB WAL/SHM sidecars and any runtime
# files default to owner-only. Host bind-mount ownership/permissions still
# matter.
set -eu
umask 077

if [ "$(uname -s)" != "Linux" ]; then
  echo "[relay-entrypoint] unsupported OS '$(uname -s)' (this image targets Linux x64/arm64)" >&2
  exit 1
fi

if [ -n "${RELAY_LAN_IP:-}" ]; then
  echo "[relay-entrypoint] RELAY_LAN_IP is no longer supported (standard bridge networking with ports: is used; remove RELAY_LAN_IP)" >&2
  exit 1
fi

RELAY_PORT="${RELAY_PORT:-3030}"
RELAY_DATA_DIR="${RELAY_DATA_DIR:-/data}"
RELAY_NAME="${RELAY_NAME:-cherry-relay}"
export RELAY_PORT RELAY_DATA_DIR RELAY_NAME
# Blank/whitespace RELAY_TOKEN_FILE (the default Compose `${RELAY_TOKEN_FILE:-}`
# expansion) is treated as unset so init resolves `<data-dir>/relay-token`.
RELAY_TOKEN_TRIMMED="$(printf '%s' "${RELAY_TOKEN_FILE:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -n "$RELAY_TOKEN_TRIMMED" ]; then
  RELAY_TOKEN_FILE="$RELAY_TOKEN_TRIMMED"
  export RELAY_TOKEN_FILE
else
  unset RELAY_TOKEN_FILE
fi
if [ -n "${RELAY_PUBLIC_URL:-}" ]; then
  export RELAY_PUBLIC_URL
fi
if [ -n "${RELAY_TLS_CERT_FILE:-}" ]; then
  export RELAY_TLS_CERT_FILE
fi
if [ -n "${RELAY_TLS_KEY_FILE:-}" ]; then
  export RELAY_TLS_KEY_FILE
fi

node /app/deploy/sync-relay/relay-init.mjs

TOKEN_FILE="${RELAY_TOKEN_FILE:-$RELAY_DATA_DIR/relay-token}"
if [ ! -f "$TOKEN_FILE" ]; then
  echo "[relay-entrypoint] token file missing after init ($TOKEN_FILE)" >&2
  exit 1
fi
SYNC_RELAY_TOKEN="$(cat "$TOKEN_FILE")"
export SYNC_RELAY_TOKEN
if [ -z "$SYNC_RELAY_TOKEN" ]; then
  echo "[relay-entrypoint] token file is empty ($TOKEN_FILE)" >&2
  exit 1
fi

# Internal Docker-bridge attestation for --allow-unspecified-bind. Set only
# here after init/token validation; the relay CLI additionally requires a
# container-runtime indicator, so exporting this on a host does not weaken
# wildcard protection. Not a user-facing option.
export CHERRY_RELAY_BRIDGE_BIND='docker-bridge-v1'

# Optional user-supplied TLS passthrough (both or neither; init already
# validated the pair). The relay terminates HTTPS with these mounted files;
# without them it serves plain HTTP on the container-internal bind.
if [ -n "${RELAY_TLS_CERT_FILE:-}" ] || [ -n "${RELAY_TLS_KEY_FILE:-}" ]; then
  if [ -z "${RELAY_TLS_CERT_FILE:-}" ] || [ -z "${RELAY_TLS_KEY_FILE:-}" ]; then
    echo "[relay-entrypoint] RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be set together or not at all" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  exec node /app/node_modules/tsx/dist/cli.mjs /app/scripts/sync-relay/server.ts \
    --host 0.0.0.0 \
    --allow-unspecified-bind \
    --port "$RELAY_PORT" \
    --db "$RELAY_DATA_DIR/relay.db" \
    --cert "$RELAY_TLS_CERT_FILE" \
    --key "$RELAY_TLS_KEY_FILE"
fi

exec node /app/node_modules/tsx/dist/cli.mjs /app/scripts/sync-relay/server.ts \
  --host 0.0.0.0 \
  --allow-unspecified-bind \
  --port "$RELAY_PORT" \
  --db "$RELAY_DATA_DIR/relay.db"
