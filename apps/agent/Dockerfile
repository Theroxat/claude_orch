# orch agent image (member machine). Build context = repository root:
#   docker build -f apps/agent/Dockerfile -t orch-agent .
#
# Runs as root: the agent holds the host Docker socket (root-equivalent, PLAN R5), owns
# /run/orch.sock and the /data and /secrets volumes. Task containers are non-root (PLAN 5.3).
FROM docker:27-cli AS docker-cli

# ---- deps: production dependencies only. Built in parallel with the runtime stage below. ----
FROM node:24-bookworm-slim AS deps
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --prod --filter "@orch/agent..."

# ---- runtime ----
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git screen ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI + buildx and compose plugins, used to drive task containers through the host daemon.
# buildx is required: task images are built with BuildKit (DOCKER_BUILDKIT=1, PLAN 5.2).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

# Claude Code CLI (native installer), copied to /opt/orch/bin/claude (PLAN 5.6) so it can be
# mounted read-only into task containers later. Auto-updates are disabled: the image pins it.
ENV DISABLE_AUTOUPDATER=1
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && mkdir -p /opt/orch/bin \
 && cp -L "$HOME/.local/bin/claude" /opt/orch/bin/claude \
 && chmod 0755 /opt/orch/bin/claude \
 && rm -rf "$HOME/.local/share/claude" "$HOME/.local/bin/claude" \
 && /opt/orch/bin/claude --version

# CI=true was set for pnpm in the former single-stage image and is part of the runtime
# environment the agent (and the Claude CLI it runs) has always seen: kept as is.
ENV CI=true

WORKDIR /app
# Production node_modules from the deps stage (pnpm, its store and its metadata cache stay
# there), then sources.
COPY --from=deps /app/ ./
COPY packages/shared/ packages/shared/
COPY apps/agent/ apps/agent/
RUN rm -rf apps/agent/test

RUN printf '#!/bin/sh\nexec node --import tsx /app/apps/agent/src/cli/main.ts "$@"\n' > /usr/local/bin/orch \
 && chmod 0755 /usr/local/bin/orch \
 && mkdir -p /data /secrets \
 && chmod 0700 /data /secrets

# Real version, set by release.yml from the git tag ("dev" for local builds). Declared late so
# changing it does not invalidate the dependency layers above.
ARG ORCH_VERSION=dev
ENV ORCH_VERSION=${ORCH_VERSION}

ENV NODE_ENV=production \
    ORCH_DATA_DIR=/data \
    ORCH_SECRETS_DIR=/secrets \
    ORCH_SOCKET_PATH=/run/orch.sock \
    ORCH_CLAUDE_BIN=/opt/orch/bin/claude \
    ORCH_CLAUDE_USAGE_ROOT=/host-claude

VOLUME ["/data", "/secrets"]
WORKDIR /app/apps/agent
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "/app/apps/agent/src/main.ts"]
