# orch server image (production). Build context = repository root:
#   docker build -f docker/server.Dockerfile -t orch-server .
# Multi-stage on Alpine: install + prune with `pnpm deploy --prod`, build a trimmed toolbox
# (tsx + Prisma CLI), then a slim non-root runtime without npm/yarn/corepack.
# The server is TypeScript run through tsx (no compile step); the Prisma CLI is needed for
# `prisma migrate deploy` at start. Both are installed at the versions pinned in pnpm-lock.yaml.

ARG NODE_IMAGE=node:24-alpine
# The runtime is plain Alpine plus the node binary: copying it (instead of using the node image)
# leaves npm, yarn and corepack out of the image layers entirely.
ARG RUNTIME_IMAGE=alpine:3.24

# ---- build: resolve dependencies, generate the Prisma client, prune to production deps ----
FROM ${NODE_IMAGE} AS build
RUN apk add --no-cache openssl ca-certificates
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
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

# Prune what the server never loads at runtime: the Prisma client ships query-compiler variants
# for every database (the app only uses PostgreSQL), the "small" compiler variant and the base64 copies of the wasm
# (the generated client under .prisma/client carries the one Node loads), plus
# type declarations and source maps that tsx never reads.
RUN cd /out/node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client/runtime \
 && rm -f *wasm-base64* *mysql* *sqlite* *sqlserver* *cockroachdb* query_compiler_small* \
 && find /out/node_modules \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -type f -delete

# Stripped copy of the node binary for the runtime (-18 MB; the dynamic symbols are kept).
RUN apk add --no-cache binutils \
 && cp /usr/local/bin/node /opt/node && strip --strip-unneeded /opt/node && /opt/node --version

# ---- toolbox: tsx + Prisma CLI (migrate deploy), trimmed to what they need ----
# Installed in an isolated prefix at the exact versions the lockfile resolved, then stripped of
# Prisma Studio's UI bundle, the dev-only packages it never loads, and type declarations.
RUN TSX_VERSION="$(node -p "require('/repo/apps/server/node_modules/tsx/package.json').version")" \
 && PRISMA_VERSION="$(node -p "require('/repo/apps/server/node_modules/prisma/package.json').version")" \
 && mkdir /opt/tools && cd /opt/tools && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --omit=dev tsx@${TSX_VERSION} prisma@${PRISMA_VERSION} \
 && npm cache clean --force \
 && cd node_modules \
 && rm -rf @prisma/studio-core/dist/ui @electric-sql @prisma/streams-local @prisma/query-plan-executor \
           react react-dom scheduler @visx elkjs d3-* @radix-ui \
 && rm -f @prisma/studio-core/dist/metafile-*.json prisma/build/studio.js prisma/build/studio.css \
          prisma/build/query_compiler_*mysql* prisma/build/query_compiler_*sqlite* \
          prisma/build/query_compiler_*sqlserver* prisma/build/query_compiler_*cockroachdb* \
          prisma/build/query_compiler_small* \
 && find . \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' \) -type f -delete

# ---- runtime ----
FROM ${RUNTIME_IMAGE} AS runtime
RUN apk add --no-cache libstdc++ openssl ca-certificates tini \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=build /opt/node /usr/local/bin/node
COPY --from=build /opt/tools /opt/tools
RUN ln -s /opt/tools/node_modules/.bin/tsx /usr/local/bin/tsx \
 && ln -s /opt/tools/node_modules/.bin/prisma /usr/local/bin/prisma

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
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/orch-server-entrypoint"]
