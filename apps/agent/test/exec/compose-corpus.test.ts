/**
 * The compose guard against a corpus of real `docker compose config` outputs (see
 * compose-corpus.ts): every benign repository is accepted and hardened, every malicious compose
 * file is refused with a message naming the vector. Plus a fuzz test on key names.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_CAPS,
  SIDECAR_LIMITS,
  checkComposeModel,
  sanitizeComposeModel,
  scanComposeSources,
} from '../../src/exec/compose-guard.js';
import { CliDocker } from '../../src/exec/docker.js';
import { spawnRunner } from '../../src/exec/runner.js';
import { tempDir } from '../helpers/util.js';
import {
  BENIGN,
  CORPUS_NETWORK,
  CORPUS_PROJECT,
  MALICIOUS,
  type CorpusCase,
} from './compose-corpus.js';
import { toSnapshot, writeCase } from './compose-corpus.regen.js';
import snapshots from './compose-corpus.snapshots.json' with { type: 'json' };

type Snap = { model?: unknown; error?: boolean };
const SNAP = snapshots as Record<string, Snap>;

let t: ReturnType<typeof tempDir>;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

function fromSnapshot(snap: unknown, root: string): unknown {
  const text = JSON.stringify(snap)
    .split('@ROOT@')
    .join(root)
    .split('@PARENT@')
    .join(join(root, '..'));
  return JSON.parse(text) as unknown;
}

/** The executor's order: source scan first, then the resolved model. */
function verdict(c: CorpusCase, model?: unknown): { root: string; problems: string[] } {
  const root = writeCase(t.dir, c);
  const early = scanComposeSources(root, join(root, 'compose.yaml'));
  if (early.length > 0) return { root, problems: early };
  const snap = SNAP[c.name];
  const m = model ?? (snap?.model === undefined ? undefined : fromSnapshot(snap.model, root));
  if (m === undefined) return { root, problems: ['(docker compose config failed)'] };
  return { root, problems: checkComposeModel(m, root, CORPUS_PROJECT, CORPUS_NETWORK) };
}

describe('compose corpus', () => {
  it('has a snapshot for every case (regenerate with compose-corpus.regen.ts)', () => {
    const names = [...BENIGN, ...MALICIOUS].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(SNAP).sort()).toEqual([...names].sort());
  });

  describe('benign repositories are accepted and hardened', () => {
    it.each(BENIGN.map((c) => [c.name, c] as const))('%s', (_n, c) => {
      const { root, problems } = verdict(c);
      expect(problems).toEqual([]);
      const model = fromSnapshot(SNAP[c.name]?.model, root);
      const { model: safe } = sanitizeComposeModel(model, { 'orch.task': 'corpus' });
      const services = safe.services as Record<string, Record<string, unknown>>;
      expect(Object.keys(services).length).toBeGreaterThan(0);
      for (const s of Object.values(services)) {
        expect(s).not.toHaveProperty('ports');
        expect(s).not.toHaveProperty('container_name');
        expect(s.cap_drop).toEqual(['ALL']);
        for (const cap of s.cap_add as string[]) {
          expect([...BASELINE_CAPS, 'IPC_LOCK']).toContain(cap);
        }
        expect(s.security_opt).toContain('no-new-privileges:true');
        expect(Number(s.mem_limit)).toBeLessThanOrEqual(SIDECAR_LIMITS.memoryMax);
        expect(s.memswap_limit).toBe(s.mem_limit);
        expect(s.cpus).toBeLessThanOrEqual(SIDECAR_LIMITS.cpusMax);
        expect(s.pids_limit).toBeLessThanOrEqual(SIDECAR_LIMITS.pidsMax);
        expect((s.labels as Record<string, string>)['orch.task']).toBe('corpus');
      }
      // The sanitized model (what actually runs) is still acceptable, orch's own labels aside.
      const again = checkComposeModel(safe, root, CORPUS_PROJECT, CORPUS_NETWORK);
      expect(again.filter((p) => !p.endsWith('label "orch.task" is reserved for orch'))).toEqual(
        [],
      );
    });
  });

  describe('malicious compose files are refused', () => {
    it.each(MALICIOUS.map((c) => [c.name, c] as const))('%s', (_n, c) => {
      const { problems } = verdict(c);
      expect(problems.length, 'not refused').toBeGreaterThan(0);
      expect(
        problems.some((p) => c.refused!.test(p)),
        problems.join('\n'),
      ).toBe(true);
    });
  });

  it('keeps the limits a benign file asks for and applies the defaults otherwise', () => {
    const c = BENIGN.find((x) => x.name.startsWith('app built'))!;
    const root = writeCase(t.dir, c);
    const { model } = sanitizeComposeModel(fromSnapshot(SNAP[c.name]?.model, root), {});
    const s = model.services as Record<string, Record<string, unknown>>;
    expect(s.app).toMatchObject({ cpus: 1.5, mem_limit: String(1024 ** 3), pids_limit: 512 });
    expect(s.app?.cap_add).toEqual(['NET_BIND_SERVICE']);
    expect(s.db).toMatchObject({
      cpus: SIDECAR_LIMITS.cpusDefault,
      mem_limit: String(SIDECAR_LIMITS.memoryDefault),
      pids_limit: SIDECAR_LIMITS.pidsDefault,
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    });
    expect(s.db?.cap_add).toEqual([...BASELINE_CAPS].sort());
  });

  it('removes SYS_NICE (MySQL examples) with a warning instead of refusing', () => {
    const c = BENIGN.find((x) => x.name.startsWith('mysql'))!;
    const root = writeCase(t.dir, c);
    const r = sanitizeComposeModel(fromSnapshot(SNAP[c.name]?.model, root), {});
    const s = r.model.services as Record<string, Record<string, unknown>>;
    expect(s.mysql?.cap_add).not.toContain('SYS_NICE');
    expect(r.stripped).toContain('mysql: cap_add SYS_NICE removed');
  });
});

// Opt-in: the same verdicts with the real CLI instead of the snapshots.
describe.skipIf(process.env.ORCH_DOCKER_IT !== '1')('compose corpus, live docker', () => {
  it.each([...BENIGN, ...MALICIOUS].map((c) => [c.name, c] as const))(
    '%s',
    async (_n, c) => {
      const root = writeCase(t.dir, c);
      if (scanComposeSources(root, join(root, 'compose.yaml')).length > 0) return;
      const docker = new CliDocker(spawnRunner);
      const live = await docker.composeConfig(CORPUS_PROJECT, [join(root, 'compose.yaml')], root);
      expect(toSnapshot(live, root)).toEqual(SNAP[c.name]?.model);
    },
    60_000,
  );
});

/**
 * Keys the guard accepts on a service (with a value, possibly checked). Reviewed by hand: a key
 * added to the guard's allowlists without adding it here fails the fuzz test below.
 */
const REVIEWED_SERVICE_KEYS = new Set([
  'attach',
  'build',
  'cap_add',
  'cap_drop',
  'cgroup',
  'command',
  'configs',
  'container_name',
  'cpu_count',
  'cpu_percent',
  'cpu_period',
  'cpu_quota',
  'cpu_shares',
  'cpus',
  'cpuset',
  'depends_on',
  'deploy',
  'develop',
  'dns',
  'dns_opt',
  'dns_search',
  'domainname',
  'entrypoint',
  'env_file',
  'environment',
  'expose',
  'extra_hosts',
  'group_add',
  'healthcheck',
  'hostname',
  'image',
  'init',
  'ipc',
  'label_file',
  'labels',
  'links',
  'logging',
  'mac_address',
  'mem_limit',
  'mem_reservation',
  'mem_swappiness',
  'memswap_limit',
  'network_mode',
  'networks',
  'oom_score_adj',
  'pid',
  'pids_limit',
  'platform',
  'ports',
  'post_start',
  'pre_stop',
  'profiles',
  'pull_policy',
  'read_only',
  'restart',
  'scale',
  'secrets',
  'security_opt',
  'shm_size',
  'stdin_open',
  'stop_grace_period',
  'stop_signal',
  'sysctls',
  'tmpfs',
  'tty',
  'ulimits',
  'user',
  'userns_mode',
  'uts',
  'volumes',
  'volumes_from',
  'working_dir',
]);

/** Deterministic PRNG (mulberry32), so a failure is reproducible from the seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('fuzz: key names', () => {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz_-.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  const DANGEROUS = [
    'privileged',
    'cap_add',
    'devices',
    'pid',
    'network_mode',
    'volumes',
    'security_opt',
    'runtime',
    'userns_mode',
    'cgroup_parent',
    'use_api_socket',
  ];
  const VALUES: unknown[] = [
    true,
    'host',
    ['ALL'],
    ['/:/host'],
    { a: 'b' },
    1,
    'unconfined',
    [{ type: 'bind', source: '/', target: '/h' }],
  ];

  function randomKey(r: () => number): string {
    const roll = r();
    if (roll < 0.4) {
      // A mutation of a real key: case, padding, separators, homoglyphs.
      const k = DANGEROUS[Math.floor(r() * DANGEROUS.length)]!;
      const muts = [
        k.toUpperCase(),
        ` ${k}`,
        `${k} `,
        k.replace('_', '-'),
        k.replace('i', 'і'), // Cyrillic i
        `${k}_`,
        `_${k}`,
        `${k}s`,
        k.replace(/_/g, ''),
      ];
      return muts[Math.floor(r() * muts.length)]!;
    }
    const len = 1 + Math.floor(r() * 24);
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
    return s;
  }

  it('refuses every unreviewed service key (2000 random keys)', () => {
    const r = rng(0x5eed);
    const root = t.dir;
    for (let i = 0; i < 2000; i++) {
      const k = randomKey(r);
      if (REVIEWED_SERVICE_KEYS.has(k) || k.startsWith('x-')) continue;
      const v = VALUES[Math.floor(r() * VALUES.length)];
      const model = { services: { s: { image: 'alpine', [k]: v } } };
      const p = checkComposeModel(model, root, 'p');
      expect(p.length, `key ${JSON.stringify(k)} = ${JSON.stringify(v)} was accepted`).toBe(1);
      expect(p[0]).toContain(JSON.stringify(k).slice(1, -1));
    }
  });

  it.each([
    ['top level', (k: string, v: unknown) => ({ services: {}, [k]: v })],
    [
      'build',
      (k: string, v: unknown) => ({ services: { s: { build: { context: '.', [k]: v } } } }),
    ],
    [
      'deploy',
      (k: string, v: unknown) => ({ services: { s: { image: 'a', deploy: { [k]: v } } } }),
    ],
    [
      'volume entry',
      (k: string, v: unknown) => ({
        services: { s: { image: 'a', volumes: [{ type: 'tmpfs', target: '/t', [k]: v }] } },
      }),
    ],
    [
      'top-level network',
      (k: string, v: unknown) => ({ services: {}, networks: { n: { name: 'p_n', [k]: v } } }),
    ],
    [
      'top-level volume',
      (k: string, v: unknown) => ({ services: {}, volumes: { v: { name: 'p_v', [k]: v } } }),
    ],
  ])('refuses random keys in the %s (500 keys)', (_where, build) => {
    const r = rng(0xc0ffee);
    const allowed = new Set(
      // Keys these levels accept: anything else must be refused.
      [
        ...['name', 'networks', 'secrets', 'configs', 'services', 'volumes', 'version'],
        ...['additional_contexts', 'args', 'cache_from', 'context', 'dockerfile'],
        ...['dockerfile_inline', 'extra_hosts', 'labels', 'network', 'no_cache', 'platforms'],
        ...['provenance', 'pull', 'sbom', 'shm_size', 'target', 'ulimits'],
        ...['endpoint_mode', 'mode', 'placement', 'replicas', 'resources', 'restart_policy'],
        ...['rollback_config', 'update_config'],
        ...['bind', 'consistency', 'image', 'read_only', 'source', 'target', 'tmpfs', 'type'],
        ...['volume', 'attachable', 'driver', 'driver_opts', 'enable_ipv4', 'enable_ipv6'],
        ...['external', 'internal', 'ipam'],
      ],
    );
    for (let i = 0; i < 500; i++) {
      const k = randomKey(r);
      if (allowed.has(k) || k.startsWith('x-')) continue;
      const p = checkComposeModel(build(k, true), t.dir, 'p');
      expect(p.length, `key ${JSON.stringify(k)} was accepted`).toBeGreaterThan(0);
    }
  });

  it('extension fields are accepted whatever they hold', () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const k = `x-${randomKey(r)}`;
      const m = { services: { s: { image: 'a', [k]: { privileged: true } } }, [k]: 1 };
      expect(checkComposeModel(m, t.dir, 'p')).toEqual([]);
    }
  });
});
