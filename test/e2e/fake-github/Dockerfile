FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY fake-github/server.mjs /app/server.mjs
COPY fake-github/seed.sh /app/seed.sh
COPY fixture-repo/ /app/fixture-repo/
RUN chmod +x /app/seed.sh
EXPOSE 8080
CMD ["node","/app/server.mjs"]
