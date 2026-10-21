/** Agent daemon entry: config -> credential -> Agent. Graceful shutdown on SIGTERM/SIGINT. */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Agent, type AgentOptions } from './agent';
import type { AgentConfig } from './config';
import { CliDocker } from './exec/docker';
import { CliGit } from './exec/git';
import { spawnRunner } from './exec/runner';
import { CliScreen } from './exec/screen';
import { nodeWorkspaceFs } from './exec/workspace';
import type { Logger } from './log';
import { ConfigError, loadConfig } from './config';
import { CredentialError, resolveCredential } from './credential';
import { createLogger, errorMessage, redact } from './log';
import { jsonlUsageSource } from './usage-loop';
import { AGENT_VERSION } from './version';

/** True when the token file exists and is non-empty. The value is never read. */
function claudeTokenPresent(secretsDir: string): boolean {
  try {
    return statSync(join(secretsDir, 'claude-token')).size > 0;
  } catch {
    return false;
  }
}

/** Reads `/secrets/claude-token` at use time (never cached, never logged). */
function readClaudeToken(secretsDir: string): string | null {
  try {
    const t = readFileSync(join(secretsDir, 'claude-token'), 'utf8').trim();
    return t === '' ? null : t;
  } catch {
    return null;
  }
}

function execOptions(cfg: AgentConfig, log: Logger, agentId: string): AgentOptions['exec'] {
  if (!cfg.workDir) {
    log.warn('ORCH_WORK_DIR is not set: task execution is disabled');
    return undefined;
  }
  if (!isAbsolute(cfg.claudeBin)) {
    log.warn('ORCH_CLAUDE_BIN must be an absolute path: task execution is disabled');
    return undefined;
  }
  let uid = cfg.taskUid;
  let gid = cfg.taskGid;
  try {
    const st = statSync(cfg.workDir);
    uid ??= st.uid > 0 ? st.uid : 1000;
    gid ??= st.uid > 0 ? st.gid : 1000;
  } catch {
    uid ??= 1000;
    gid ??= 1000;
  }
  return {
    config: {
      agentId,
      workDir: cfg.workDir,
      dataDir: cfg.dataDir,
      maxConcurrent: cfg.maxConcurrent,
      gitBaseUrl: cfg.gitBaseUrl,
      defaultImage: cfg.defaultImage,
      claudeBin: cfg.claudeBin,
      uid,
      gid,
      identity: cfg.gitAuthor,
    },
    deps: {
      git: new CliGit(spawnRunner, cfg.gitBaseUrl),
      docker: new CliDocker(spawnRunner),
      screen: new CliScreen(spawnRunner),
      fs: nodeWorkspaceFs,
      readClaudeToken: () => readClaudeToken(cfg.secretsDir),
    },
  };
}

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
    claudeTokenPresent: () => claudeTokenPresent(cfg.secretsDir),
    usageSource: jsonlUsageSource({
      root: cfg.claudeUsageRoot,
      plan: cfg.plan,
      ...(cfg.usageLimit !== undefined ? { limitWeighted: cfg.usageLimit } : {}),
    }),
    logger: log,
    exec: execOptions(cfg, log, cred.agentId),
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
