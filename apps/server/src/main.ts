import { buildApp } from './app';
import { loadConfig } from './config';
import { createPrisma } from './db';
import { OctokitGithubClient } from './github';

const config = loadConfig();
const prisma = createPrisma(config.DATABASE_URL);
const { GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY_PATH } =
  config;
const github =
  GITHUB_APP_ID && GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_APP_PRIVATE_KEY_PATH
    ? new OctokitGithubClient({
        appId: GITHUB_APP_ID,
        clientId: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
        privateKeyPath: GITHUB_APP_PRIVATE_KEY_PATH,
        apiUrl: config.GITHUB_API_URL,
        webUrl: config.GITHUB_WEB_URL,
      })
    : undefined;
const app = buildApp({ config, prisma, github });

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
