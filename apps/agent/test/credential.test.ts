import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { CredentialError, resolveCredential } from '../src/credential';
import { silentLogger } from '../src/log';
import { CREDENTIAL, tempDir } from './helpers/util';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const cfg = (env: Record<string, string>) =>
  loadConfig({ ORCH_SERVER_URL: 'https://orch.example.com', ORCH_DATA_DIR: tmp.dir, ...env });

describe('resolveCredential', () => {
  it('prefers ORCH_AGENT_CREDENTIAL', async () => {
    const r = await resolveCredential(cfg({ ORCH_AGENT_CREDENTIAL: CREDENTIAL }), silentLogger);
    expect(r).toMatchObject({ agentId: 'agt_test', source: 'env' });
  });

  it('reads the credential file', async () => {
    writeFileSync(join(tmp.dir, 'agent-credential'), `${CREDENTIAL}\n`);
    const r = await resolveCredential(cfg({}), silentLogger);
    expect(r).toMatchObject({ credential: CREDENTIAL, source: 'file' });
  });

  it('enrolls with the token, writes the file 0600 and forgets the token', async () => {
    const c = cfg({ ORCH_ENROLL_TOKEN: 'tok123', ORCH_MACHINE_NAME: 'box' });
    let body: unknown;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://orch.example.com/api/agents/enroll');
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ agentId: 'agt_test', credential: CREDENTIAL }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    const r = await resolveCredential(c, silentLogger, fakeFetch);
    expect(r.source).toBe('enroll');
    expect(body).toMatchObject({ token: 'tok123', machineName: 'box' });
    expect(c.enrollToken).toBeUndefined();
    const file = join(tmp.dir, 'agent-credential');
    expect(readFileSync(file, 'utf8').trim()).toBe(CREDENTIAL);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('explains a rejected token and a missing credential', async () => {
    const reject401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      resolveCredential(cfg({ ORCH_ENROLL_TOKEN: 't' }), silentLogger, reject401),
    ).rejects.toThrow(/Enrollment token rejected/);
    await expect(resolveCredential(cfg({}), silentLogger)).rejects.toBeInstanceOf(CredentialError);
    await expect(
      resolveCredential(cfg({ ORCH_AGENT_CREDENTIAL: 'nope' }), silentLogger),
    ).rejects.toThrow(/malformed/);
  });
});
