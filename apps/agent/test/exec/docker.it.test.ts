/**
 * Opt-in integration test with the real docker CLI (needs a reachable daemon; the default tools
 * container has none). Run with ORCH_DOCKER_IT=1 where `docker` works.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkComposeModel,
  planEnvFileFallbacks,
  sanitizeComposeModel,
  scanComposeSources,
} from '../../src/exec/compose-guard';
import { selectDevEnv } from '../../src/exec/devcontainer';
import { CliDocker } from '../../src/exec/docker';
import { spawnRunner } from '../../src/exec/runner';
import { tempDir } from '../helpers/util';
import { BOT_REPO_FILES } from './compose-fixtures';

const enabled = process.env.ORCH_DOCKER_IT === '1';

describe.skipIf(!enabled)('docker integration (ORCH_DOCKER_IT=1)', () => {
  it('builds the fixture repo Dockerfile and labels the image', async () => {
    const repo = join(__dirname, 'fixtures', 'tiny-repo');
    const env = selectDevEnv(repo, 'node:22-bookworm');
    expect(env.kind).toBe('build');
    if (env.kind !== 'build') return;
    const docker = new CliDocker(spawnRunner);
    const tag = 'orch-task-it-fixture:latest';
    await docker.build({
      tag,
      dockerfile: env.dockerfile,
      context: env.context,
      args: {},
      labels: { 'orch.task': 'it_fixture' },
    });
    const r = await spawnRunner.run('docker', [
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "orch.task"}}',
      tag,
    ]);
    expect(r.stdout.trim()).toBe('it_fixture');
    await docker.removeImage(tag);
  }, 300_000);

  it('bot-repo shape: config, up and down with the env_file override, no .env in the clone', async () => {
    const tmp = tempDir();
    const clone = join(tmp.dir, 'src');
    mkdirSync(clone, { recursive: true });
    for (const [f, c] of Object.entries(BOT_REPO_FILES)) {
      mkdirSync(dirname(join(clone, f)), { recursive: true });
      writeFileSync(join(clone, f), c);
    }
    const docker = new CliDocker(spawnRunner);
    const project = `orch-task-it-${process.pid}`;
    const network = `orch-net-it-${process.pid}`;
    const compose = join(clone, 'docker-compose.yml');
    const labels = { 'orch.task': `it-${process.pid}` };
    await docker.createNetwork(network, labels);
    try {
      expect(scanComposeSources(clone, compose)).toEqual([]);
      const fix = planEnvFileFallbacks(clone, compose);
      expect(fix.override).not.toBeNull();
      const envfix = join(tmp.dir, 'compose.orch.envfix.yaml');
      writeFileSync(envfix, fix.override as string);
      // Without the override, docker refuses the model exactly like in production.
      await expect(docker.composeConfig(project, [compose], clone)).rejects.toThrow(
        /env file .*\.env not found/,
      );
      const model = await docker.composeConfig(project, [compose, envfix], clone);
      expect(checkComposeModel(model, clone, project)).toEqual([]);
      const safe = sanitizeComposeModel(model, labels);
      const checked = join(tmp.dir, 'compose.orch.checked.json');
      const net = join(tmp.dir, 'compose.orch.yaml');
      writeFileSync(checked, JSON.stringify(safe.model));
      writeFileSync(net, `networks:\n  default:\n    name: ${network}\n    external: true\n`);
      await docker.composeUp(project, [checked, net], clone);
      const ps = await spawnRunner.run('docker', [
        'compose',
        '-p',
        project,
        'ps',
        '--format',
        '{{.Name}}',
      ]);
      expect(ps.stdout).toContain(`${project}-helper-1`);
      expect(existsSync(join(clone, '.env'))).toBe(false);
      await docker.composeDown(project, { files: [checked, net], cwd: clone });
      const left = await spawnRunner.run('docker', [
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ]);
      expect(left.stdout.trim()).toBe('');
    } finally {
      await docker.composeDown(project).catch(() => undefined);
      await docker.removeNetwork(network).catch(() => undefined);
      tmp.cleanup();
    }
  }, 600_000);
});
