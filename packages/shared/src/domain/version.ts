/**
 * Agent version helpers (agent update notification, PLAN "Updating agents").
 *
 * Versions are release versions without the leading "v" (`0.4.3`, `0.5.0-rc.1`). `dev` (local
 * builds) and anything unparseable are never considered outdated, and never a valid update target.
 */
import { z } from 'zod';

/** Strict release version: MAJOR.MINOR.PATCH with an optional prerelease. No build metadata. */
export const RELEASE_VERSION_RE =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]{1,40}))?$/;

export const ReleaseVersionSchema = z
  .string()
  .regex(RELEASE_VERSION_RE, 'must be a release version');

/** Default image repository of the agent (registry/namespace/name, no tag). */
export const DEFAULT_AGENT_IMAGE_REPO = 'ghcr.io/theroxat/orch-agent';

/** Image repository reference without tag or digest: `host[:port]/path`, lower case. */
export const IMAGE_REPO_RE = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+$/;

interface Parsed {
  core: [number, number, number];
  pre: string[] | null;
}

/** Normalises a reported version ("v0.4.1" -> "0.4.1"); null for dev / unknown / garbage. */
export function normalizeVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(/^v/, '');
  return RELEASE_VERSION_RE.test(s) ? s : null;
}

function parse(v: string): Parsed | null {
  const m = RELEASE_VERSION_RE.exec(v);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : null,
  };
}

function comparePre(a: string[] | null, b: string[] | null): number {
  if (!a && !b) return 0;
  if (!a) return 1; // a release ranks above its prereleases
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== null) return -1;
    else if (ny !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver comparison. Returns null when either side is not a release version (e.g. `dev`). */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a.trim().replace(/^v/, ''));
  const y = parse(b.trim().replace(/^v/, ''));
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

/** True when `agentVersion` is a release strictly older than `latest`. `dev` is never outdated. */
export function isOutdated(
  agentVersion: string | null | undefined,
  latest: string | null,
): boolean {
  const a = normalizeVersion(agentVersion);
  const l = normalizeVersion(latest);
  if (!a || !l) return false;
  return (compareVersions(a, l) ?? 0) < 0;
}
