import { describe, expect, it } from 'vitest';
import {
  CLAUDE_TOKEN_ENV,
  SandboxError,
  buildCreateArgs,
  type SandboxSpec,
} from '../../src/exec/sandbox';

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  name: 'orch-task-42-asg-1',
  image: 'node:22-bookworm',
  clonePath: '/home/member/orch/work/asg_1/src',
  workspaceFolder: '/workspace',
  uid: 1000,
  gid: 1000,
  network: 'orch-net-asg-1',
  size: 'M',
  labels: { 'orch.task': 'asg_1' },
  containerEnv: { FOO: 'bar' },
  ...over,
});

/** Values following each occurrence of `flag`. */
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

describe('sandbox create args', () => {
  const args = buildCreateArgs(spec());
  const joined = args.join(' ');

  it('mounts only the clone, never the docker socket or a home directory', () => {
    const mounts = values(args, '--mount');
    expect(mounts).toEqual(['type=bind,source=/home/member/orch/work/asg_1/src,target=/workspace']);
    expect(values(args, '-v')).toEqual([]);
    expect(values(args, '--volume')).toEqual([]);
    expect(args).not.toContain('--volumes-from');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toMatch(/source=\/home\/member(,|$)/);
    expect(joined).not.toMatch(/source=\/root/);
    expect(joined).not.toContain('/data');
    expect(joined).not.toContain('/secrets');
  });

  it('runs as a non-root user without privileges', () => {
    expect(values(args, '--user')).toEqual(['1000:1000']);
    expect(values(args, '--cap-drop')).toEqual(['ALL']);
    expect(values(args, '--security-opt')).toEqual(['no-new-privileges']);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
    expect(joined).not.toMatch(/--(pid|ipc|uts|userns)[ =]host/);
    expect(values(args, '--network')).toEqual(['orch-net-asg-1']);
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--publish');
    expect(values(args, '--pids-limit')).toHaveLength(1);
    expect(values(args, '--memory')).toEqual(['6g']);
    expect(values(args, '--tmpfs')[0]).toMatch(/^\/tmp:/);
  });

  it('passes the Claude token by name only and keeps sandbox env authoritative', () => {
    const envs = values(args, '-e');
    expect(envs).toContain(CLAUDE_TOKEN_ENV);
    expect(envs.filter((e) => e.startsWith(`${CLAUDE_TOKEN_ENV}=`))).toEqual([]);
    expect(envs).toContain('FOO=bar');
    expect(envs).toContain('DISABLE_TELEMETRY=1');
    expect(envs).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    const hijack = buildCreateArgs(
      spec({ containerEnv: { [CLAUDE_TOKEN_ENV]: 'x', HOME: '/root', DOCKER_HOST: 'tcp://h' } }),
    );
    const e2 = values(hijack, '-e');
    expect(e2).not.toContain(`${CLAUDE_TOKEN_ENV}=x`);
    expect(e2).not.toContain('HOME=/root');
    expect(e2).not.toContain('DOCKER_HOST=tcp://h');
  });

  it('ends with the image and a keep-alive command', () => {
    expect(args.slice(-4)).toEqual(['--entrypoint', 'sleep', 'node:22-bookworm', 'infinity']);
  });

  it('refuses root, dangerous mount sources and odd names', () => {
    expect(() => buildCreateArgs(spec({ uid: 0 }))).toThrow(SandboxError);
    for (const p of ['/', '/var/run/docker.sock', '/home', '/root', 'relative/src', '/a,b']) {
      expect(() => buildCreateArgs(spec({ clonePath: p }))).toThrow(SandboxError);
    }
    expect(() => buildCreateArgs(spec({ image: '--privileged' }))).toThrow(SandboxError);
    expect(() => buildCreateArgs(spec({ workspaceFolder: '/../x' }))).toThrow(SandboxError);
  });
});
