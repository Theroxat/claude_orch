/**
 * Opt-in integration test with the real docker CLI (needs a reachable daemon; the default tools
 * container has none). Run with ORCH_DOCKER_IT=1 where `docker` works.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectDevEnv } from '../../src/exec/devcontainer';
import { CliDocker } from '../../src/exec/docker';
import { spawnRunner } from '../../src/exec/runner';

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
});
