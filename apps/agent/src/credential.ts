/**
 * Agent credential resolution: ORCH_AGENT_CREDENTIAL (written by install.sh) -> the credential
 * file in the data volume -> enrollment with ORCH_ENROLL_TOKEN (dev fallback, PLAN 4.1).
 * The credential is never logged.
 */
import { readFileSync } from 'node:fs';
import { EnrollResponseSchema, parseAgentCredential } from '@orch/shared';
import type { AgentConfig } from './config';
import { writeFileAtomic } from './fsutil';
import type { Logger } from './log';
import { AGENT_VERSION } from './version';

export interface ResolvedCredential {
  credential: string;
  agentId: string;
  source: 'env' | 'file' | 'enroll';
}

export class CredentialError extends Error {
  override name = 'CredentialError';
}

function check(credential: string, where: string): ResolvedCredential['agentId'] {
  const parsed = parseAgentCredential(credential);
  if (!parsed) throw new CredentialError(`The agent credential from ${where} is malformed.`);
  return parsed.agentId;
}

function readCredentialFile(path: string): string | undefined {
  try {
    const v = readFileSync(path, 'utf8').trim();
    return v === '' ? undefined : v;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function enroll(
  cfg: Pick<AgentConfig, 'enrollUrl' | 'machineName'>,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ agentId: string; credential: string }> {
  let res: Response;
  try {
    res = await fetchImpl(cfg.enrollUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, machineName: cfg.machineName, agentVersion: AGENT_VERSION }),
    });
  } catch (err) {
    throw new CredentialError(
      `Enrollment request to ${cfg.enrollUrl} failed: ${(err as Error).message}`,
    );
  }
  if (res.status === 401) {
    throw new CredentialError(
      'Enrollment token rejected (invalid, expired or already used). Generate a new install command on My server.',
    );
  }
  if (!res.ok) throw new CredentialError(`Enrollment failed with HTTP ${res.status}.`);
  const body = EnrollResponseSchema.safeParse(await res.json().catch(() => null));
  if (!body.success) throw new CredentialError('Unexpected enrollment response.');
  return body.data;
}

/**
 * Resolves the credential. On enrollment the credential is persisted (0600) and the token is
 * removed from `cfg` so it does not linger in memory.
 */
export async function resolveCredential(
  cfg: AgentConfig,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedCredential> {
  if (cfg.credential) {
    const agentId = check(cfg.credential, 'ORCH_AGENT_CREDENTIAL');
    delete cfg.enrollToken;
    return { credential: cfg.credential, agentId, source: 'env' };
  }
  const fromFile = readCredentialFile(cfg.credentialFile);
  if (fromFile) {
    delete cfg.enrollToken;
    return { credential: fromFile, agentId: check(fromFile, cfg.credentialFile), source: 'file' };
  }
  const token = cfg.enrollToken;
  if (!token) {
    throw new CredentialError(
      'No agent credential: set ORCH_AGENT_CREDENTIAL (install.sh does this) or ORCH_ENROLL_TOKEN.',
    );
  }
  delete cfg.enrollToken;
  log.info('enrolling this machine', { url: cfg.enrollUrl, machineName: cfg.machineName });
  const res = await enroll(cfg, token, fetchImpl);
  const agentId = check(res.credential, 'the enrollment response');
  writeFileAtomic(cfg.credentialFile, `${res.credential}\n`, 0o600);
  log.info('enrolled', { agentId });
  return { credential: res.credential, agentId, source: 'enroll' };
}
