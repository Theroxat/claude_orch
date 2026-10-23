// Prisma 7: the connection URL for Migrate lives here (the schema no longer carries it).
// Kept import-free so it also loads from the standalone prisma CLI in the runtime image.
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
};
