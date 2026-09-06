# syntax=docker/dockerfile:1
# Cherry Chat personal sync relay — Linux x64/arm64 home-server image.
#
# The base tag is a multi-arch manifest (linux/amd64 + linux/arm64); there
# are no architecture-specific instructions below, so the same Dockerfile
# builds natively on either target.
#
# Standard Docker bridge networking: the relay binds the container-internal
# 0.0.0.0 address and Docker publishes the port to the host via `ports:` in
# docker-compose.yml. No host networking, no generated certificates.
#
# The image carries only what the relay needs: the relay server sources, the
# dependency-free shared sync contract, a minimal install (better-sqlite3 +
# tsx), and the entrypoint. The full Electron app is deliberately NOT
# packaged. The relay never generates or manages TLS certificates.
FROM node:24.11.1-bookworm

ENV NODE_ENV=production

# Preserve the repository pinned toolchain manager.
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app

# Relay-only dependency manifest + deployment lockfile (both pinned to the
# repository versions). The lockfile covers exactly the minimal image scope
# (better-sqlite3 + tsx and their transitives) — never the root lockfile.
COPY deploy/sync-relay/package.json deploy/sync-relay/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Relay server + its shared sync contract (relative layout preserved:
# scripts/sync-relay/server.ts imports ../../packages/shared/sync/*).
COPY scripts/sync-relay/ ./scripts/sync-relay/
COPY packages/shared/ ./packages/shared/

# Docker init + entrypoint.
COPY deploy/sync-relay/relay-init.mjs deploy/sync-relay/docker-entrypoint.sh ./deploy/sync-relay/
RUN chmod +x ./deploy/sync-relay/docker-entrypoint.sh \
  && mkdir -p /data \
  && node --check ./deploy/sync-relay/relay-init.mjs \
  && sh -n ./deploy/sync-relay/docker-entrypoint.sh

# Defaults; the container-internal bind is fixed to 0.0.0.0 (see entrypoint).
ENV RELAY_PORT=3030 \
  RELAY_DATA_DIR=/data \
  RELAY_NAME=cherry-relay

ENTRYPOINT ["/app/deploy/sync-relay/docker-entrypoint.sh"]
