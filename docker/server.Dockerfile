# orch server image (production). Build context = repository root:
#   docker build -f docker/server.Dockerfile -t orch-server .
# Multi-stage: install + prune with `pnpm deploy --prod`, then a slim non-root runtime.
# The server is TypeScript run through tsx (no compile step), so tsx and the Prisma CLI
# (needed for `prisma migrate deploy` at start) are installed globally at the versions pinned
# in pnpm-lock.yaml.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: resolve dependencies, generate the Prisma client, prune to production deps ----
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# Manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter "@orch/server..."

COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/
RUN rm -rf apps/server/test packages/shared/test

# Production-only copy of the server and its workspace dependency, then the Prisma client.
RUN pnpm --filter @orch/server deploy --prod /out \
 && cd /out && /repo/apps/server/node_modules/.bin/prisma generate --schema prisma/schema.prisma

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# Keep these in sync with pnpm-lock.yaml (tsx, prisma).
ARG TSX_VERSION=4.23.15
ARG PRISMA_VERSION=6.19.3
RUN npm install -g --no-audit --no-fund tsx@${TSX_VERSION} prisma@${PRISMA_VERSION} \
 && npm cache clean --force

# Real version, set by release.yml from the git tag ("dev" for local builds).
ARG ORCH_VERSION=dev
ENV ORCH_VERSION=${ORCH_VERSION}

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ORCH_INSTALL_SH_PATH=/opt/orch/install.sh \
    ORCH_AGENT_COMPOSE_PATH=/opt/orch/agent-compose.yaml

# tsconfig.base.json sits two levels above the app, as in the repository.
WORKDIR /opt/orch/apps/server
COPY --from=build /repo/tsconfig.base.json /opt/orch/tsconfig.base.json
COPY --from=build --chown=root:root /out/ ./
COPY install.sh /opt/orch/install.sh
COPY deploy/agent/compose.yaml /opt/orch/agent-compose.yaml
COPY docker/server-entrypoint.sh /usr/local/bin/orch-server-entrypoint
RUN chmod 0755 /usr/local/bin/orch-server-entrypoint

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orch-server-entrypoint"]
