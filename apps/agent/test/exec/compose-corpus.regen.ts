/**
 * Regenerates compose-corpus.snapshots.json with the real docker compose CLI (see
 * compose-corpus.ts). Run from apps/agent: `npx tsx test/exec/compose-corpus.regen.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliDocker } from '../../src/exec/docker';
import { spawnRunner } from '../../src/exec/runner';
import { BENIGN, CORPUS_PROJECT, MALICIOUS, type CorpusCase } from './compose-corpus';

export function writeCase(dir: string, c: CorpusCase): string {
  const root = join(dir, 'repo');
  for (const [p, content] of Object.entries(c.files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

/** Replaces the case paths with placeholders (longest first). */
export function toSnapshot(model: unknown, root: string): unknown {
  const text = JSON.stringify(model)
    .split(root)
    .join('@ROOT@')
    .split(dirname(root))
    .join('@PARENT@');
  return JSON.parse(text) as unknown;
}

async function main(): Promise<void> {
  const docker = new CliDocker(spawnRunner);
  const out: Record<string, unknown> = {};
  for (const c of [...BENIGN, ...MALICIOUS]) {
    const dir = mkdtempSync(join(tmpdir(), 'orch-corpus-'));
    try {
      const root = writeCase(dir, c);
      try {
        const model = await docker.composeConfig(
          CORPUS_PROJECT,
          [join(root, 'compose.yaml')],
          root,
        );
        out[c.name] = { model: toSnapshot(model, root) };
      } catch {
        // docker cannot load it (e.g. an include outside the repo): the source scan refuses it.
        out[c.name] = { error: true };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  writeFileSync(
    join(import.meta.dirname, 'compose-corpus.snapshots.json'),
    JSON.stringify(out, null, 2) + '\n',
  );
  console.log(`${Object.keys(out).length} cases written`);
}

if (process.argv[1]?.endsWith('compose-corpus.regen.ts')) await main();
