# orch web image: the Vite build served as static files by Caddy (production).
# Build context = repository root:
#   docker build -f docker/web.Dockerfile -t orch-web .
# The Caddyfile is mounted by deploy/server/compose.yaml; a copy is baked in as a fallback.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@orch/web..."
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/
RUN pnpm --filter @orch/web build

FROM caddy:2-alpine
COPY --from=build /repo/apps/web/dist /srv
COPY deploy/server/Caddyfile /etc/caddy/Caddyfile
