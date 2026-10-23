import { startTracing } from './observability/tracing';

// Tracing first, and only when OTEL_EXPORTER_OTLP_ENDPOINT is set: the instrumentations patch
// http and pg, so the application modules are imported after it starts.
const stopTracing = await startTracing();
const { buildApp } = await import('./app');
const { assertSignInPolicy, loadConfig } = await import('./config');
const { createPrisma } = await import('./db');
const { OctokitGithubClient } = await import('./github');

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
  await stopTracing?.().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Production refuses to start when anyone could sign in (env allowlists, admins and approved
// access grants all empty) unless ORCH_ALLOW_ANY_GITHUB_USER=true.
assertSignInPolicy(
  config,
  async () => (await prisma.accessGrant.count({ where: { status: 'APPROVED' } })) > 0,
)
  .then(() => app.listen({ host: config.HOST, port: config.PORT }))
  .catch(async (err) => {
    app.log.error(err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
