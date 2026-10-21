/** Agent daemon entry: config -> credential -> Agent. Graceful shutdown on SIGTERM/SIGINT. */
import { Agent } from './agent';
import { ConfigError, loadConfig } from './config';
import { CredentialError, resolveCredential } from './credential';
import { createLogger, errorMessage, redact } from './log';
import { jsonlUsageSource } from './usage-loop';
import { AGENT_VERSION } from './version';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  log.info(`orch agent ${AGENT_VERSION} starting`, { server: cfg.serverUrl });
  const cred = await resolveCredential(cfg, log);
  if (cfg.agentId && cfg.agentId !== cred.agentId) {
    log.warn('ORCH_AGENT_ID does not match the credential, using the credential', {
      configured: cfg.agentId,
      actual: cred.agentId,
    });
  }

  const agent = new Agent({
    serverUrl: cfg.serverUrl,
    wsUrl: cfg.wsUrl,
    credential: cred.credential,
    agentId: cred.agentId,
    dataDir: cfg.dataDir,
    socketPath: cfg.socketPath,
    usageIntervalSec: cfg.usageIntervalSec,
    usageIntervalExplicit: cfg.usageIntervalExplicit,
    usageSource: jsonlUsageSource({ root: cfg.claudeUsageRoot, plan: cfg.plan }),
    logger: log,
  });
  agent.client.on('fatal', () => {
    log.error('the agent stays up for `orch status` but will not reconnect');
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
    void agent.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await agent.start();
}

main().catch((err: unknown) => {
  const known = err instanceof ConfigError || err instanceof CredentialError;
  process.stderr.write(
    redact(`orch agent: ${known ? (err as Error).message : errorMessage(err)}\n`),
  );
  process.exit(1);
});
