/**
 * Known secret VALUES (the Claude token, the GitHub tokens of a run, the agent credential, the
 * values injected into task and sidecar containers...): each one is masked as is and in its
 * common encodings, also when a line wrap splits it.
 */
import { REDACTED } from './patterns';

/** Values shorter than this are never masked literally (too many false hits). */
export const MIN_SECRET_LEN = 8;
/** Encoded forms shorter than this are dropped (an 8-char secret gives 10-char base64 cores). */
const MIN_VARIANT_LEN = 10;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();

/** Base64 of `bytes`, without padding. */
function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = ((bytes[i] as number) << 16) | (rest > 1 ? (bytes[i + 1] as number) << 8 : 0);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!;
    if (rest > 1) out += B64[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * The base64 characters that encode `bytes` whatever surrounds them, for each of the 3 byte
 * alignments: inside a larger encoded blob (`user:TOKEN` in a Basic header, a secret in an
 * encoded config file), the secret's own bytes always give one of these 3 cores.
 */
function base64Cores(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const buf = new Uint8Array(k + bytes.length);
    buf.set(bytes, k);
    const enc = base64(buf);
    // Characters mixing in the k unknown leading bytes, or the unknown next byte, are dropped.
    out.push(enc.slice(Math.ceil((8 * k) / 6), Math.floor((8 * buf.length) / 6)));
  }
  return out;
}

/**
 * Every form of `secret` that is masked: as is, JSON-escaped, URL-encoded, hex (lower and upper
 * case), base64 and base64url (3 alignments each). Forms shorter than 10 characters are dropped.
 */
export function secretVariants(secret: string): string[] {
  const out = new Set<string>([secret]);
  const add = (v: string) => {
    if (v.length >= MIN_VARIANT_LEN) out.add(v);
  };
  add(JSON.stringify(secret).slice(1, -1));
  try {
    add(encodeURIComponent(secret));
  } catch {
    // Lone surrogate: no URL-encoded form.
  }
  const bytes = encoder.encode(secret);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  add(hex);
  add(hex.toUpperCase());
  for (const core of base64Cores(bytes)) {
    add(core);
    add(core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return [...out];
}

/** A value's start at the end of a stream piece is masked from this length on. */
const PARTIAL_MIN = 5;

/** Rolling-hash window: every variant is at least this long. */
const WINDOW = 8;
const BASE = 257;
let BASE_POW = 1;
for (let i = 1; i < WINDOW; i++) BASE_POW = Math.imul(BASE_POW, BASE);

function windowHash(s: string, at: number): number {
  let h = 0;
  for (let i = 0; i < WINDOW; i++) h = (Math.imul(h, BASE) + s.charCodeAt(at + i)) | 0;
  return h;
}

/**
 * `text` with line breaks removed (and the indentation after them), and where each kept
 * character came from, so a secret wrapped over several lines still matches. `map` is null when
 * there was nothing to remove.
 */
function unwrap(text: string): { s: string; map: Int32Array | null } {
  if (!text.includes('\n') && !text.includes('\r')) return { s: text, map: null };
  const map = new Int32Array(text.length);
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 13) break;
      j++;
    }
    if (j > i) {
      parts.push(text.slice(i, j));
      for (let k = i; k < j; k++) map[n++] = k;
    }
    if (j >= text.length) break;
    // Skip the line break(s) and the indentation of the next line.
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c !== 10 && c !== 13 && c !== 32 && c !== 9) break;
      j++;
    }
    i = j;
  }
  return { s: parts.join(''), map: map.subarray(0, n) };
}

/** Finds a fixed set of strings (all >= 8 chars) in one pass (Rabin-Karp on 8-char windows). */
export class SecretMatcher {
  private readonly byHash = new Map<number, string[]>();
  /** 64 K-bit filter on the hashes: most positions are rejected without a Map lookup. */
  private readonly bits = new Uint32Array(2048);
  readonly maxLen: number;
  readonly size: number;

  constructor(values: Iterable<string>) {
    let max = 0;
    let size = 0;
    for (const v of new Set(values)) {
      if (v.length < WINDOW) continue;
      const h = windowHash(v, 0);
      const slot = (h & 0xffff) >>> 5;
      this.bits[slot] = (this.bits[slot] as number) | (1 << (h & 31));
      const list = this.byHash.get(h);
      if (list) list.push(v);
      else this.byHash.set(h, [v]);
      max = Math.max(max, v.length);
      size++;
    }
    // Longest first: at one position the longest form wins.
    for (const list of this.byHash.values()) list.sort((a, b) => b.length - a.length);
    this.maxLen = max;
    this.size = size;
  }

  /** Merged [start, end) ranges of `text` covered by a match (line breaks inside are covered). */
  ranges(text: string): Array<[number, number]> {
    if (this.size === 0 || text.length < WINDOW) return [];
    const { s, map } = unwrap(text);
    const found: Array<[number, number]> = [];
    if (s.length < WINDOW) return found;
    let h = windowHash(s, 0);
    let coveredTo = 0;
    for (let i = 0; ; i++) {
      const list =
        ((this.bits[(h & 0xffff) >>> 5] as number) & (1 << (h & 31))) !== 0
          ? this.byHash.get(h)
          : undefined;
      if (list) {
        for (const v of list) {
          if (s.startsWith(v, i)) {
            const end = i + v.length;
            if (end > coveredTo) {
              const a = map ? (map[i] as number) : i;
              const b = map ? (map[end - 1] as number) + 1 : end;
              const last = found[found.length - 1];
              if (last && a <= last[1]) last[1] = Math.max(last[1], b);
              else found.push([a, b]);
              coveredTo = end;
            }
            break;
          }
        }
      }
      if (i + WINDOW >= s.length) break;
      h =
        (Math.imul(h - Math.imul(s.charCodeAt(i), BASE_POW), BASE) + s.charCodeAt(i + WINDOW)) | 0;
    }
    return found;
  }

  private prefixes: Set<string> | null = null;

  /**
   * Length of the longest end of `text` (5+ chars) that is the START of a value: the rest of
   * the value may come in the next piece of a stream. 0 when there is none.
   */
  partialAtEnd(text: string): number {
    if (this.size === 0) return 0;
    if (!this.prefixes) {
      this.prefixes = new Set();
      for (const list of this.byHash.values()) {
        for (const v of list) {
          for (let j = PARTIAL_MIN; j < v.length; j++) this.prefixes.add(v.slice(0, j));
        }
      }
    }
    for (let j = Math.min(this.maxLen - 1, text.length); j >= PARTIAL_MIN; j--) {
      if (this.prefixes.has(text.slice(text.length - j))) return j;
    }
    return 0;
  }

  redact(text: string): string {
    const r = this.ranges(text);
    if (r.length === 0) return text;
    let out = '';
    let pos = 0;
    for (const [a, b] of r) {
      out += text.slice(pos, a) + REDACTED;
      pos = b;
    }
    return out + text.slice(pos);
  }
}

/** Builds (and caches) the matcher of every variant of the current secret values. */
export class KnownSecrets {
  private key = '';
  private matcher = new SecretMatcher([]);
  private readonly variants = new Map<string, string[]>();

  constructor(private readonly source: () => Iterable<string | null | undefined>) {}

  current(): SecretMatcher {
    const values: string[] = [];
    for (const v of this.source()) {
      if (typeof v === 'string' && v.length >= MIN_SECRET_LEN) values.push(v);
    }
    const key = values.join('\0');
    if (key !== this.key) {
      const all: string[] = [];
      const next = new Map<string, string[]>();
      for (const v of values) {
        const vs = this.variants.get(v) ?? secretVariants(v);
        next.set(v, vs);
        all.push(...vs);
      }
      this.variants.clear();
      for (const [k, vs] of next) this.variants.set(k, vs);
      this.matcher = new SecretMatcher(all);
      this.key = key;
    }
    return this.matcher;
  }
}

/**
 * Secret values grouped by scope (`agent`, one per run...), so a run's values can be dropped
 * when it ends. `values()` is what a KnownSecrets source reads.
 */
export class SecretSet {
  private readonly scopes = new Map<string, Set<string>>();

  add(scope: string, values: Iterable<string | null | undefined>): void {
    let set = this.scopes.get(scope);
    for (const v of values) {
      if (typeof v !== 'string' || v.length < MIN_SECRET_LEN) continue;
      if (!set) this.scopes.set(scope, (set = new Set()));
      set.add(v);
    }
  }

  drop(scope: string): void {
    this.scopes.delete(scope);
  }

  *values(): Iterable<string> {
    const seen = new Set<string>();
    for (const set of this.scopes.values()) {
      for (const v of set) {
        if (!seen.has(v)) {
          seen.add(v);
          yield v;
        }
      }
    }
  }
}
