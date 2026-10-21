#!/bin/sh
# Applies pending database migrations, then starts the server.
set -eu
prisma migrate deploy --schema prisma/schema.prisma
exec tsx src/main.ts
