import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ComposeGuardError,
  checkComposeModel,
  planEnvFileFallbacks,
  sanitizeComposeModel,
  scanComposeSources,
} from '../../src/exec/compose-guard.js';
import { tempDir } from '../helpers/util.js';
import { BOT_REPO_FILES } from './compose-fixtures.js';

let t: ReturnType<typeof tempDir>;
let root: string;
beforeEach(() => {
  t = tempDir();
  root = join(t.dir, 'repo');
  mkdirSync(join(root, 'data'), { recursive: true });
});
afterEach(() => t.cleanup());

const P = 'p1';
const svc = (s: Record<string, unknown>, top: Record<string, unknown> = {}): unknown => ({
  services: { db: { image: 'x', ...s } },
  ...top,
});
const check = (m: unknown): string[] => checkComposeModel(m, root, P);

describe('ComposeGuardError', () => {
  it('lists the problems', () => {
    const e = new ComposeGuardError(['a', 'b']);
    expect(e.name).toBe('ComposeGuardError');
    expect(e.message).toBe('Refusing the repository compose file:\n- a\n- b');
  });
});

describe('checkComposeModel', () => {
  it('accepts a benign model (shape taken from `docker compose config --format json`)', () => {
    const m = {
      name: P,
      services: {
        db: {
          image: 'postgres',
          environment: { A: '1' },
          ports: [{ mode: 'ingress', target: 80, published: '8080', protocol: 'tcp' }],
          volumes: [
            { type: 'bind', source: join(root, 'data'), target: '/d', bind: {} },
            { type: 'bind', source: join(root, 'not-yet'), target: '/n', bind: {} },
            { type: 'volume', source: 'data', target: '/v', volume: {} },
            { type: 'tmpfs', target: '/t' },
          ],
          build: { context: root, dockerfile: 'Dockerfile' },
          security_opt: ['no-new-privileges:true'],
          network_mode: 'bridge',
        },
      },
      volumes: { data: { name: `${P}_data` } },
      secrets: { s: { environment: 'X' } },
    };
    expect(check(m)).toEqual([]);
  });

  it('tolerates odd shapes without crashing', () => {
    expect(check(null)).toEqual(['unexpected compose config output']);
    expect(check('x')).toEqual(['unexpected compose config output']);
    expect(check({})).toEqual([]);
    expect(check({ services: 3 })).toHaveLength(1);
    expect(check({ services: { a: 3 } })[0]).toMatch(/^service "a"/);
  });

  it.each([
    ['privileged', { privileged: true }],
    ['cap_add', { cap_add: ['SYS_ADMIN'] }],
    ['devices', { devices: ['/dev/sda:/dev/sda'] }],
    ['pid host', { pid: 'host' }],
    ['pid container', { pid: 'container:abc' }],
    ['ipc host', { ipc: 'host' }],
    ['uts host', { uts: 'host' }],
    ['userns_mode host', { userns_mode: 'host' }],
    ['cgroup host', { cgroup: 'host' }],
    ['network_mode host', { network_mode: 'host' }],
    ['network_mode container', { network_mode: 'container:abc' }],
    ['apparmor=unconfined', { security_opt: ['apparmor=unconfined'] }],
    ['apparmor:unconfined', { security_opt: ['apparmor:unconfined'] }],
    ['seccomp=unconfined', { security_opt: ['seccomp=unconfined'] }],
    ['seccomp:unconfined upper', { security_opt: ['Seccomp:Unconfined'] }],
    ['label=disable', { security_opt: ['label=disable'] }],
    ['label:disable', { security_opt: ['label:disable'] }],
    ['systempaths=unconfined', { security_opt: ['systempaths=unconfined'] }],
    ['volumes_from container', { volumes_from: ['container:abc:ro'] }],
    ['runtime', { runtime: 'nvidia' }],
    ['cgroup_parent', { cgroup_parent: 'system.slice' }],
  ])('refuses %s', (_n, s) => {
    const p = check(svc(s));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^service "db": /);
  });

  it('allows volumes_from another service', () => {
    expect(check(svc({ volumes_from: ['other:ro'] }))).toEqual([]);
  });

  describe('bind mounts', () => {
    const bind = (source: string): unknown =>
      svc({ volumes: [{ type: 'bind', source, target: '/x', bind: {} }] });

    it.each(['/', '/var/run/docker.sock', '/home', '/root', '/secrets', '/data', '/etc'])(
      'refuses %s',
      (src) => {
        const p = check(bind(src));
        expect(p).toHaveLength(1);
        expect(p[0]).toMatch(/^service "db": /);
      },
    );

    it('refuses a path that leaves the root with ..', () => {
      expect(check(bind(join(root, '..', 'other')))).toHaveLength(1);
    });

    it('refuses a symlink inside root pointing outside', () => {
      symlinkSync('/etc', join(root, 'link'));
      expect(check(bind(join(root, 'link')))).toHaveLength(1);
      expect(check(bind(join(root, 'link', 'passwd')))).toHaveLength(1);
    });

    it('refuses npipe', () => {
      expect(check(svc({ volumes: [{ type: 'npipe', source: 'a', target: 'b' }] }))).toHaveLength(
        1,
      );
    });
  });

  describe('named volumes', () => {
    const vol = (def: Record<string, unknown>): unknown =>
      svc(
        { volumes: [{ type: 'volume', source: 'v', target: '/v', volume: {} }] },
        { volumes: { v: def } },
      );

    it('accepts a project volume', () => {
      expect(check(vol({ name: `${P}_v` }))).toEqual([]);
    });
    it('refuses external volumes', () => {
      expect(check(vol({ name: 'v', external: true }))).not.toEqual([]);
    });
    it('refuses a volume not named after the project', () => {
      expect(check(vol({ name: 'shared' }))).toHaveLength(1);
      expect(check(vol({}))).toHaveLength(1);
    });
    it('refuses the local-driver bind trick', () => {
      const opts = { type: 'none', o: 'bind', device: '/' };
      expect(check(vol({ name: `${P}_v`, driver: 'local', driver_opts: opts }))).toHaveLength(1);
      expect(check(vol({ name: `${P}_v`, driver_opts: { o: 'rw,bind' } }))).toHaveLength(1);
      expect(check(vol({ name: `${P}_v`, driver_opts: { device: '/etc' } }))).toHaveLength(1);
    });
    it('refuses an undefined volume', () => {
      expect(
        check(svc({ volumes: [{ type: 'volume', source: 'zz', target: '/v' }] })),
      ).toHaveLength(1);
    });
  });

  it('checks env_file entries', () => {
    expect(check(svc({ env_file: [{ path: join(root, '.env') }] }))).toEqual([]);
    expect(check(svc({ env_file: ['/etc/shadow'] }))).toHaveLength(1);
    expect(check(svc({ env_file: [{ path: '/etc/shadow', required: true }] }))).toHaveLength(1);
    expect(check(svc({ env_file: '/etc/shadow' }))).toHaveLength(1);
  });

  describe('build', () => {
    it('refuses contexts and dockerfiles outside root', () => {
      expect(check(svc({ build: { context: '/etc' } }))).toHaveLength(1);
      expect(check(svc({ build: { context: root, dockerfile: '../../etc/x' } }))).toHaveLength(1);
      expect(check(svc({ build: { context: root, dockerfile: '/etc/passwd' } }))).toHaveLength(1);
    });
    it('does not treat URLs / git refs as local paths', () => {
      const b = { context: 'https://github.com/a/b.git' };
      expect(check(svc({ build: b }))).toEqual([]);
    });
    it('checks additional_contexts', () => {
      const bad = { context: root, additional_contexts: { x: '/etc' } };
      expect(check(svc({ build: bad }))).toHaveLength(1);
      const arr = { context: root, additional_contexts: ['x=/etc'] };
      expect(check(svc({ build: arr }))).toHaveLength(1);
      const ok = {
        context: root,
        additional_contexts: { x: join(root, 'data'), y: 'docker-image://a' },
      };
      expect(check(svc({ build: ok }))).toEqual([]);
    });
    it('refuses build secrets and ssh', () => {
      expect(check(svc({ build: { context: root, secrets: ['s'] } }))).toHaveLength(1);
      expect(check(svc({ build: { context: root, ssh: ['default'] } }))).toHaveLength(1);
    });
  });

  it('checks top-level secrets and configs files', () => {
    const top = (kind: string, file: string): unknown => ({
      services: {},
      [kind]: { k: { file } },
    });
    expect(check(top('secrets', '/etc/shadow'))).toHaveLength(1);
    expect(check(top('configs', '/etc/passwd'))).toHaveLength(1);
    expect(check(top('secrets', join(root, 's.txt')))).toEqual([]);
  });

  it('does not flag published ports', () => {
    expect(
      check(svc({ ports: [{ target: 5432, published: '5432', host_ip: '0.0.0.0' }] })),
    ).toEqual([]);
  });
});

describe('scanComposeSources', () => {
  const write = (rel: string, text: string): string => {
    const f = join(root, rel);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, text);
    return f;
  };

  it('accepts a plain file', () => {
    const f = write('compose.yaml', 'services:\n  web:\n    image: x\n');
    expect(scanComposeSources(root, f)).toEqual([]);
  });

  it('refuses a compose file symlinked outside root', () => {
    const outside = join(t.dir, 'outside.yaml');
    writeFileSync(outside, 'services: {}\n');
    symlinkSync(outside, join(root, 'compose.yaml'));
    expect(scanComposeSources(root, join(root, 'compose.yaml'))).toHaveLength(1);
  });

  it('refuses an include outside root (list, path:, inline forms)', () => {
    const forms = [
      'include:\n  - ../outside.yaml\n',
      'include:\n- ../outside.yaml\n',
      'include:\n  - path: ../outside.yaml\n',
      'include:\n  - path:\n      - ok.yaml\n      - "../outside.yaml"\n',
      'include: [../outside.yaml]\n',
      'include: ["ok.yaml", {path: ../outside.yaml}]\n',
      'include:\n  - path: ok.yaml\n    project_directory: /etc\n',
      'include:\n  - path: ok.yaml\n    env_file: ../outside.env\n',
    ];
    write('ok.yaml', 'services: {}\n');
    for (const body of forms) {
      const f = write('compose.yaml', body + 'services: {}\n');
      expect(scanComposeSources(root, f), body).not.toEqual([]);
    }
  });

  it('accepts an include inside root and recurses into it', () => {
    write('sub/inc.yaml', 'services:\n  a:\n    image: x\n');
    const f = write('compose.yaml', 'include:\n  - sub/inc.yaml\n');
    expect(scanComposeSources(root, f)).toEqual([]);
    write('sub/inc.yaml', 'include:\n  - ../../outside.yaml\n');
    const p = scanComposeSources(root, f);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('sub/inc.yaml');
  });

  it('survives include cycles', () => {
    write('a.yaml', 'include:\n  - b.yaml\n');
    write('b.yaml', 'include:\n  - a.yaml\n');
    expect(scanComposeSources(root, join(root, 'a.yaml'))).toEqual([]);
  });

  it('refuses remote references', () => {
    for (const ref of [
      'https://example.com/c.yaml',
      'oci://docker.io/x:1',
      'git@github.com:a/b.git',
    ]) {
      const f = write('compose.yaml', `include:\n  - ${ref}\n`);
      expect(scanComposeSources(root, f), ref).toHaveLength(1);
    }
    const g = write(
      'compose.yaml',
      'include:\n  - path: https://example.com/c.yaml\nservices: {}\n',
    );
    expect(scanComposeSources(root, g)).toHaveLength(1);
  });

  it('refuses interpolated paths', () => {
    const f = write('compose.yaml', 'include:\n  - ${DIR}/c.yaml\n');
    expect(scanComposeSources(root, f)).toHaveLength(1);
  });

  it('checks extends', () => {
    write('base.yml', 'services:\n  web:\n    image: x\n');
    const ok = write(
      'compose.yaml',
      'services:\n  a:\n    extends:\n      service: web\n      file: base.yml\n  b:\n    extends:\n      service: a\n  c:\n    extends: a\n',
    );
    expect(scanComposeSources(root, ok)).toEqual([]);
    const block = write(
      'compose.yaml',
      'services:\n  a:\n    extends:\n      file: ../x.yml\n      service: web\n',
    );
    expect(scanComposeSources(root, block)).toHaveLength(1);
    const inline = write(
      'compose.yaml',
      "services:\n  a:\n    extends: {service: web, file: '../x.yml'}\n",
    );
    expect(scanComposeSources(root, inline)).toHaveLength(1);
  });

  it('recurses into extended files', () => {
    write('base.yml', 'services:\n  web:\n    env_file: /etc/shadow\n');
    const f = write(
      'compose.yaml',
      'services:\n  a:\n    extends:\n      file: base.yml\n      service: web\n',
    );
    expect(scanComposeSources(root, f)).toHaveLength(1);
  });

  it('checks env_file in every form', () => {
    const forms = [
      'env_file: /etc/shadow',
      'env_file:\n      - .env\n      - ../../x.env',
      'env_file:\n      - path: ../x.env\n        required: false',
      'env_file: [".env", "/etc/x"]',
    ];
    for (const body of forms) {
      const f = write('compose.yaml', `services:\n  a:\n    image: x\n    ${body}\n`);
      expect(scanComposeSources(root, f), body).toHaveLength(1);
    }
    const ok = write(
      'compose.yaml',
      'services:\n  a:\n    env_file:\n      - .env\n      - path: sub/x.env\n        required: false\n',
    );
    expect(scanComposeSources(root, ok)).toEqual([]);
  });

  it('fails closed on constructs it cannot read', () => {
    const f = write('compose.yaml', 'include:\n  - *anchor\n');
    expect(scanComposeSources(root, f)).not.toEqual([]);
    const g = write('compose.yaml', 'include:\nservices: {}\n');
    expect(scanComposeSources(root, g)).not.toEqual([]);
  });

  it('handles JSON compose files', () => {
    const bad = write(
      'compose.json',
      JSON.stringify({ include: ['../outside.yaml'], services: {} }),
    );
    expect(scanComposeSources(root, bad)).toHaveLength(1);
    const bad2 = write(
      'compose.json',
      JSON.stringify({ include: [{ path: 'ok.yaml', env_file: '/etc/x' }], services: {} }),
    );
    write('ok.yaml', 'services: {}\n');
    expect(scanComposeSources(root, bad2)).toHaveLength(1);
    const bad3 = write(
      'compose.json',
      JSON.stringify({ services: { a: { extends: { file: '../x.yml', service: 'w' } } } }),
    );
    expect(scanComposeSources(root, bad3)).toHaveLength(1);
    const ok = write('compose.json', JSON.stringify({ include: ['ok.yaml'], services: {} }));
    expect(scanComposeSources(root, ok)).toEqual([]);
  });
});

describe('sanitizeComposeModel', () => {
  const model = (): Record<string, unknown> => ({
    name: P,
    services: {
      db: {
        image: 'x',
        ports: [
          { mode: 'ingress', host_ip: '0.0.0.0', target: 5432, published: '5432', protocol: 'tcp' },
          { target: 80, published: '8080' },
        ],
        labels: { a: 'b' },
      },
      web: { image: 'y', labels: ['c=d', 'e=f=g'] },
      raw: { image: 'z' },
    },
  });

  it('strips ports, merges labels and reports', () => {
    const { model: out, stripped } = sanitizeComposeModel(model(), { 'orch.task': '1', a: 'new' });
    const s = out.services as Record<string, Record<string, unknown>>;
    expect(s.db).not.toHaveProperty('ports');
    expect(s.db?.labels).toEqual({ a: 'new', 'orch.task': '1' });
    expect(s.web?.labels).toEqual({ c: 'd', e: 'f=g', 'orch.task': '1', a: 'new' });
    expect(s.raw?.labels).toEqual({ 'orch.task': '1', a: 'new' });
    expect(stripped).toEqual(['db: published ports 0.0.0.0:5432->5432, 8080->80 removed']);
  });

  it('does not mutate its input', () => {
    const m = model();
    const before = structuredClone(m);
    sanitizeComposeModel(m, { x: 'y' });
    expect(m).toEqual(before);
  });

  it('copes with non-object input', () => {
    expect(sanitizeComposeModel(null, {})).toEqual({ model: {}, stripped: [] });
  });

  it('lets compose name built images per project; services reusing the built image follow', () => {
    const { model: out, stripped } = sanitizeComposeModel(
      {
        name: 'orch-task-a1',
        services: {
          app: { build: { context: root }, image: 'ghcr.io/acme/app:latest' },
          worker: { image: 'ghcr.io/acme/app:latest' },
          plain: { build: { context: root } },
          db: { image: 'postgres:16' },
        },
      },
      {},
    );
    const s = out.services as Record<string, Record<string, unknown>>;
    expect(s.app).not.toHaveProperty('image');
    expect(s.worker?.image).toBe('orch-task-a1-app');
    expect(s.plain).not.toHaveProperty('image');
    expect(s.db?.image).toBe('postgres:16');
    expect(stripped).toEqual([
      'app: built as "orch-task-a1-app" instead of "ghcr.io/acme/app:latest"',
    ]);
  });

  it('removes container_name (global on the daemon) and keeps it as a network alias', () => {
    const { model: out, stripped } = sanitizeComposeModel(
      {
        services: {
          a: { image: 'x', container_name: 'app', networks: { default: null } },
          b: {
            image: 'y',
            container_name: 'app-b',
            networks: { default: { aliases: ['bee'] }, back: null },
          },
          c: { image: 'z', container_name: 'app-c' },
          d: { image: 'w', container_name: 'app-d', network_mode: 'none' },
        },
      },
      {},
    );
    const s = out.services as Record<string, Record<string, unknown>>;
    for (const k of ['a', 'b', 'c', 'd']) expect(s[k]).not.toHaveProperty('container_name');
    expect(s.a?.networks).toEqual({ default: { aliases: ['app'] } });
    expect(s.b?.networks).toEqual({
      default: { aliases: ['bee', 'app-b'] },
      back: { aliases: ['app-b'] },
    });
    expect(s.c?.networks).toEqual({ default: { aliases: ['app-c'] } });
    expect(s.d).not.toHaveProperty('networks');
    expect(stripped).toContain('a: container_name "app" removed (kept as a network alias)');
  });
});

describe('planEnvFileFallbacks', () => {
  const compose = (envFile: string): string =>
    `services:\n  web:\n    image: x\n    env_file: ${envFile}\n`;
  const plan = (text: string) => {
    writeFileSync(join(root, 'compose.yaml'), text);
    return planEnvFileFallbacks(root, join(root, 'compose.yaml'));
  };

  it('drops a missing in-clone env_file with a warning, creating no file', () => {
    const r = plan(compose('.env'));
    expect(r.override).toContain('env_file: !override []');
    expect(r.warnings).toEqual([
      'env file .env not found in the repository; continuing without it. Commit a .env.example or make it optional.',
    ]);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('bot-repo shape (list env_file, comments with quotes): swaps .env for .env.example', () => {
    for (const [f, c] of Object.entries(BOT_REPO_FILES)) writeFileSync(join(root, f), c);
    expect(scanComposeSources(root, join(root, 'docker-compose.yml'))).toEqual([]);
    const r = planEnvFileFallbacks(root, join(root, 'docker-compose.yml'));
    expect(r.override).toBe(
      '# Written by orch: tolerate env files missing from the clone.\nservices:\n' +
        `  "bot":\n    env_file: !override\n        - path: ${JSON.stringify(join(root, '.env.example'))}\n          required: false\n`,
    );
    expect(r.warnings).toEqual([
      'env file .env not found in the repository; using .env.example instead.',
    ]);
  });

  it('uses .env.example when it exists next to the missing file', () => {
    writeFileSync(join(root, '.env.example'), 'A=1\n');
    const r = plan(compose('.env'));
    expect(r.override).toContain(JSON.stringify(join(root, '.env.example')));
    expect(r.warnings[0]).toContain('using .env.example instead');
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('handles the list form and the .env.sample fallback', () => {
    writeFileSync(join(root, 'ok.env'), 'A=1\n');
    writeFileSync(join(root, '.env.sample'), 'A=1\n');
    const r = plan(
      'services:\n  web:\n    image: x\n    env_file:\n      - ok.env\n      - .env\n',
    );
    expect(r.override).toContain(JSON.stringify(join(root, 'ok.env')));
    expect(r.override).toContain(JSON.stringify(join(root, '.env.sample')));
  });

  it('leaves an existing env_file unchanged (no override)', () => {
    writeFileSync(join(root, '.env'), 'A=1\n');
    expect(plan(compose('.env'))).toEqual({ override: null, warnings: [] });
  });

  it('does not touch an env_file outside the clone: the source scan still refuses it', () => {
    const r = plan(compose('../outside.env'));
    expect(r.override).toBeNull();
    expect(scanComposeSources(root, join(root, 'compose.yaml')).join('\n')).toContain(
      'outside the repository',
    );
  });

  it('does not follow a symlinked example that points outside the clone', () => {
    writeFileSync(join(t.dir, 'secret.env'), 'S=1\n');
    symlinkSync(join(t.dir, 'secret.env'), join(root, '.env.example'));
    const r = plan(compose('.env'));
    expect(r.override).toContain('env_file: !override []');
  });
});
