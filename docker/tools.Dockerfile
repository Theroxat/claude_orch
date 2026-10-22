FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates git curl postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# pnpm >= 11 only reads pnpm_config_* variables: the former npm_config_store_dir was ignored and
# the store ended up in node_modules/.pnpm-store instead of the ignored /workspace/.pnpm-store.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HOME=/tmp/home \
    pnpm_config_store_dir=/workspace/.pnpm-store \
    CI=true

RUN corepack enable \
 && corepack prepare pnpm@12.14.0 --activate \
 && pnpm --version \
 && chmod -R a+rX /opt/corepack \
 && mkdir -p /tmp/home && chmod 1777 /tmp/home

WORKDIR /workspace
