import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function waitFor(
  cond: () => boolean,
  { timeoutMs = 4_000, stepMs = 10, what = 'condition' } = {},
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Temp dir short enough for unix socket paths (108 bytes). */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-agent-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const CREDENTIAL = `orch_agent_agt_test.${'s'.repeat(10)}S3cr3tS3cr3tS3cr3tS3cr3tS3cr3t`;
