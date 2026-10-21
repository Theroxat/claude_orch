import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DevEnvError,
  findComposeFile,
  postCreateArgvs,
  selectDevEnv,
  stripJsonc,
} from '../../src/exec/devcontainer';
import { tempDir } from '../helpers/util';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => (tmp = tempDir()));
afterEach(() => tmp.cleanup());

function repo(files: Record<string, string>): string {
  const root = join(tmp.dir, 'src');
  mkdirSync(root, { recursive: true });
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), c);
  }
  return root;
}

const DEFAULT = 'node:22-bookworm';

describe('dev environment selection', () => {
  it('uses the default image when the repo defines nothing', () => {
    const env = selectDevEnv(repo({ 'README.md': 'x' }), DEFAULT);
    expect(env).toMatchObject({ kind: 'image', source: 'default', image: DEFAULT });
    expect(env.workspaceFolder).toBe('/workspace');
  });

  it('uses the root Dockerfile with the clone as build context', () => {
    const root = repo({ Dockerfile: 'FROM alpine\n' });
    const env = selectDevEnv(root, DEFAULT);
    expect(env).toMatchObject({
      kind: 'build',
      source: 'dockerfile',
      dockerfile: join(root, 'Dockerfile'),
      context: root,
    });
  });

  it('prefers devcontainer.json over the Dockerfile (image key, JSONC)', () => {
    const root = repo({
      Dockerfile: 'FROM alpine\n',
      '.devcontainer/devcontainer.json': `{
        // comment
        "image": "mcr.microsoft.com/devcontainers/base:bookworm", /* inline */
        "containerEnv": { "FOO": "bar", "N": 1, "bad-name": "x" },
        "postCreateCommand": "npm ci",
        "remoteUser": "vscode",
        "runArgs": ["--privileged"],
        "mounts": ["source=/,target=/host,type=bind"],
        "url": "http://example.com/a//b",
      }`,
    });
    const env = selectDevEnv(root, DEFAULT);
    expect(env).toMatchObject({
      kind: 'image',
      source: 'devcontainer',
      image: 'mcr.microsoft.com/devcontainers/base:bookworm',
      containerEnv: { FOO: 'bar', N: '1' },
      postCreateCommand: 'npm ci',
    });
    const w = env.warnings.join('\n');
    expect(w).toContain('"runArgs" is not supported');
    expect(w).toContain('"mounts" is not supported');
    expect(w).toContain('remoteUser is ignored');
    expect(w).toContain('bad-name');
  });

  it('resolves build.dockerfile and build.context relative to .devcontainer', () => {
    const root = repo({
      '.devcontainer/devcontainer.json': JSON.stringify({
        build: { dockerfile: 'Dockerfile.dev', context: '..', args: { V: '1' } },
        workspaceFolder: '/work/app',
      }),
      '.devcontainer/Dockerfile.dev': 'FROM node:22\n',
    });
    const env = selectDevEnv(root, DEFAULT);
    expect(env).toMatchObject({
      kind: 'build',
      source: 'devcontainer',
      dockerfile: join(root, '.devcontainer/Dockerfile.dev'),
      context: root,
      args: { V: '1' },
      workspaceFolder: '/work/app',
    });
  });

  it('accepts a root .devcontainer.json', () => {
    const root = repo({ '.devcontainer.json': '{"image":"python:3.12"}' });
    expect(selectDevEnv(root, DEFAULT)).toMatchObject({ kind: 'image', image: 'python:3.12' });
  });

  it('rejects build paths outside the repository and broken files', () => {
    const outside = repo({
      '.devcontainer/devcontainer.json': '{"build":{"dockerfile":"../../evil/Dockerfile"}}',
    });
    expect(() => selectDevEnv(outside, DEFAULT)).toThrow(DevEnvError);
    tmp.cleanup();
    tmp = tempDir();
    expect(() =>
      selectDevEnv(repo({ '.devcontainer/devcontainer.json': '{nope' }), DEFAULT),
    ).toThrow(/not valid JSON/);
    tmp.cleanup();
    tmp = tempDir();
    expect(() => selectDevEnv(repo({ '.devcontainer/devcontainer.json': '{}' }), DEFAULT)).toThrow(
      /neither/,
    );
  });

  it('ignores unsupported workspaceFolder values', () => {
    const root = repo({
      '.devcontainer/devcontainer.json': '{"image":"x","workspaceFolder":"/../etc"}',
    });
    const env = selectDevEnv(root, DEFAULT);
    expect(env.workspaceFolder).toBe('/workspace');
    expect(env.warnings.join()).toContain('workspaceFolder');
  });

  it('finds the compose file and expands postCreateCommand forms', () => {
    expect(findComposeFile(repo({ 'README.md': '' }))).toBeNull();
    const root = join(tmp.dir, 'src');
    writeFileSync(join(root, 'compose.yaml'), 'services: {}\n');
    expect(findComposeFile(root)).toBe(join(root, 'compose.yaml'));
    expect(postCreateArgvs(null)).toEqual([]);
    expect(postCreateArgvs('a && b')).toEqual([['sh', '-c', 'a && b']]);
    expect(postCreateArgvs(['npm', 'ci'])).toEqual([['npm', 'ci']]);
    expect(postCreateArgvs({ a: 'x', b: ['y', 'z'] })).toEqual([
      ['sh', '-c', 'x'],
      ['y', 'z'],
    ]);
  });

  it('strips JSONC comments but not inside strings', () => {
    expect(JSON.parse(stripJsonc('{"a":"//not a comment", /* c */ "b":[1,2,],}'))).toEqual({
      a: '//not a comment',
      b: [1, 2],
    });
  });
});
