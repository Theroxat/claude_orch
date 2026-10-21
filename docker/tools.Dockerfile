FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates git curl postgresql-client \
 && rm -rf /var/lib/apt/lists/*

ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HOME=/tmp/home \
    npm_config_store_dir=/workspace/.pnpm-store \
    CI=true

RUN corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && chmod -R a+rX /opt/corepack \
 && mkdir -p /tmp/home && chmod 1777 /tmp/home

WORKDIR /workspace
