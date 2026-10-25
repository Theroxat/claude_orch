import { describe, expect, it } from 'vitest';
import {
  BASELINE_CAPS,
  SIDECAR_LIMITS,
  parseBytes,
  parseDuration,
  sanitizeComposeModel,
} from '../../src/exec/compose-guard.js';
import { childEnv } from '../../src/exec/runner.js';

const harden = (s: Record<string, unknown>) => {
  const r = sanitizeComposeModel({ name: 'p', services: { a: { image: 'x', ...s } } }, {});
  return { s: (r.model.services as Record<string, Record<string, unknown>>).a!, w: r.stripped };
};

describe('sanitizeComposeModel hardening', () => {
  it('drops every capability and adds back the baseline minus what the repo drops', () => {
    expect(harden({}).s.cap_drop).toEqual(['ALL']);
    expect(harden({}).s.cap_add).toEqual([...BASELINE_CAPS].sort());
    expect(harden({ cap_drop: ['chown', 'CAP_KILL'] }).s.cap_add).not.toContain('CHOWN');
    expect(harden({ cap_drop: ['chown', 'CAP_KILL'] }).s.cap_add).not.toContain('KILL');
    expect(harden({ cap_drop: ['ALL'], cap_add: ['NET_BIND_SERVICE'] }).s.cap_add).toEqual([
      'NET_BIND_SERVICE',
    ]);
    expect(harden({ cap_add: ['ipc_lock'] }).s.cap_add).toContain('IPC_LOCK');
  });

  it('forces no-new-privileges', () => {
    expect(harden({ security_opt: ['no-new-privileges:false'] }).s.security_opt).toEqual([
      'no-new-privileges:true',
    ]);
  });

  it('applies default limits', () => {
    expect(harden({}).s).toMatchObject({
      mem_limit: String(SIDECAR_LIMITS.memoryDefault),
      memswap_limit: String(SIDECAR_LIMITS.memoryDefault),
      cpus: SIDECAR_LIMITS.cpusDefault,
      pids_limit: SIDECAR_LIMITS.pidsDefault,
    });
  });

  it('caps larger or unlimited ones, in every spelling', () => {
    const big = harden({
      mem_limit: '64g',
      cpu_quota: 3200000,
      cpu_period: 100000,
      pids_limit: -1,
      memswap_limit: '-1',
      cpu_shares: 262144,
      shm_size: '32g',
      stop_grace_period: '24h',
      mem_reservation: '8g',
    });
    expect(big.s).toMatchObject({
      mem_limit: String(SIDECAR_LIMITS.memoryMax),
      memswap_limit: String(SIDECAR_LIMITS.memoryMax),
      cpus: SIDECAR_LIMITS.cpusMax,
      pids_limit: SIDECAR_LIMITS.pidsDefault,
      cpu_shares: SIDECAR_LIMITS.cpuSharesMax,
      shm_size: String(SIDECAR_LIMITS.memoryMax),
      stop_grace_period: '30s',
    });
    for (const k of ['cpu_quota', 'cpu_period', 'mem_reservation']) {
      expect(big.s).not.toHaveProperty(k);
    }
    expect(big.w).toEqual(['a: memory limit 64g lowered to 4g', 'a: cpus 32 lowered to 4']);
    const dep = harden({
      deploy: { resources: { limits: { cpus: '8', memory: '1g', pids: 100000 } }, placement: {} },
    });
    expect(dep.s).not.toHaveProperty('deploy');
    expect(dep.s).toMatchObject({ cpus: 4, mem_limit: String(1024 ** 3), pids_limit: 4096 });
  });

  it('rotates logs and drops environment pass-through', () => {
    const s = harden({ environment: { A: '1', TOKEN: null } }).s;
    expect(s.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3' },
    });
    expect(s.environment).toEqual({ A: '1' });
    expect(harden({ logging: { driver: 'none' } }).s.logging).toEqual({ driver: 'none' });
  });

  it('drops label_file so the up step cannot re-read a swapped file for reserved labels', () => {
    const s = harden({ label_file: ['./labels.env'], labels: { foo: 'bar' } }).s;
    expect(s).not.toHaveProperty('label_file');
    expect((s.labels as Record<string, string>).foo).toBe('bar');
  });

  it('removes the default network (the task network replaces it)', () => {
    const r = sanitizeComposeModel(
      { services: {}, networks: { default: { name: 'x', driver_opts: { a: 'b' } }, b: {} } },
      {},
    );
    expect(r.model.networks).toEqual({ b: {} });
  });
});

describe('size and duration parsing', () => {
  it.each([
    [1024, 1024],
    ['1073741824', 1073741824],
    ['512m', 512 * 1024 ** 2],
    ['2g', 2 * 1024 ** 3],
    ['1.5GB', 1.5 * 1024 ** 3],
    ['x', null],
    [undefined, null],
  ])('parseBytes(%j) = %j', (v, want) => expect(parseBytes(v)).toBe(want));

  it.each([
    ['1m30s', 90],
    ['10s', 10],
    ['500ms', 0.5],
    ['2h', 7200],
    ['soon', null],
  ])('parseDuration(%j) = %j', (v, want) => expect(parseDuration(v)).toBe(want));
});

describe('compose child environment', () => {
  it('keeps only the docker CLI basics for compose runs', () => {
    process.env.ORCH_TEST_LEAK = 'x';
    process.env.GITHUB_TOKEN_TEST_LEAK = 'y';
    try {
      const env = childEnv({ EXTRA: '1' }, true);
      expect(env.GITHUB_TOKEN_TEST_LEAK).toBeUndefined();
      expect(env.ORCH_TEST_LEAK).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.EXTRA).toBe('1');
      expect(childEnv().GITHUB_TOKEN_TEST_LEAK).toBe('y');
    } finally {
      delete process.env.ORCH_TEST_LEAK;
      delete process.env.GITHUB_TOKEN_TEST_LEAK;
    }
  });
});
