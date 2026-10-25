/**
 * Manual check that hardened benign sidecars really start (cap_drop ALL + baseline, limits,
 * no-new-privileges): `npx tsx test/exec/compose-corpus.up.ts [case name prefix ...]`.
 * Creates its own network and project, waits for health, then removes everything.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkComposeModel, sanitizeComposeModel } from '../../src/exec/compose-guard';
import { CliDocker } from '../../src/exec/docker';
import { spawnRunner } from '../../src/exec/runner';
import { BENIGN } from './compose-corpus';
import { writeCase } from './compose-corpus.regen';

const prefixes = process.argv.slice(2);
const docker = new CliDocker(spawnRunner);
for (const c of BENIGN.filter(
  (x) => prefixes.length === 0 || prefixes.some((p) => x.name.startsWith(p)),
)) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-corpus-up-'));
  const id = Math.random().toString(36).slice(2, 8);
  const project = `orch-task-corpusup-${id}`;
  const network = `orch-net-corpusup-${id}`;
  const root = writeCase(dir, c);
  try {
    await docker.createNetwork(network, { 'orch.corpus': id });
    const model = await docker.composeConfig(project, [join(root, 'compose.yaml')], root);
    const problems = checkComposeModel(model, root, project, network);
    if (problems.length > 0) throw new Error(problems.join('\n'));
    const safe = sanitizeComposeModel(model, { 'orch.corpus': id });
    writeFileSync(join(dir, 'checked.json'), JSON.stringify(safe.model));
    writeFileSync(
      join(dir, 'net.yaml'),
      `networks:\n  default:\n    name: ${network}\n    external: true\n`,
    );
    const files = [join(dir, 'checked.json'), join(dir, 'net.yaml')];
    await spawnRunner
      .run(
        'docker',
        [
          'compose',
          '-p',
          project,
          '--project-directory',
          root,
          ...files.flatMap((f) => ['-f', f]),
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '180',
        ],
        { composeEnv: true, timeoutMs: 600_000 },
      )
      .then((r) => {
        if (r.code !== 0) throw new Error(r.stderr.slice(-2000));
      });
    console.log(`OK   ${c.name}`);
  } catch (err) {
    console.log(`FAIL ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await docker.composeDown(project, {
      files: [join(dir, 'checked.json'), join(dir, 'net.yaml')],
      cwd: root,
    });
    await docker.removeNetwork(network);
    rmSync(dir, { recursive: true, force: true });
  }
}
