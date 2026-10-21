import { buildApp } from './app';
import { loadConfig } from './config';
import { createPrisma } from './db';

const config = loadConfig();
const prisma = createPrisma(config.DATABASE_URL);
const app = buildApp({ config, prisma });

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ host: config.HOST, port: config.PORT }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
