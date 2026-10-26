/**
 * Secret redaction shared by the agent and the server (live logs, failure messages, PR bodies,
 * commit messages, notifications, error logs). What is and is not covered: docs/security.md.
 *
 * - `redactSecrets(text)`: secret formats only (no known values), e.g. on the server.
 * - `Redactor`: known values (in every encoding, across line wraps) then the formats.
 * - `StreamRedactor`: the same over consecutive pieces of one stream (lines, log entries), so a
 *   secret split between two pieces is masked on both sides.
 */
import { KnownSecrets, type SecretMatcher } from './known';
import { PARTIAL_TOKEN_AT_END, REDACTED, redactPatterns, redactPem, redactRules } from './patterns';

export {
  REDACTED,
  SECRET_RULES,
  looksLikeSecretValue,
  redactPem,
  shannonEntropy,
} from './patterns';
export { MIN_SECRET_LEN, SecretMatcher, SecretSet, secretVariants } from './known';
export { composeSecrets, envSecretValues, envSecrets } from './env';

/** Replaces every secret FORMAT (token shapes, private keys, credential assignments). */
export function redactSecrets(text: string): string {
  return redactPatterns(text);
}

export class Redactor {
  private readonly known: KnownSecrets | null;

  /** `secrets` is read on every call (cheap when unchanged), so new values apply at once. */
  constructor(secrets?: () => Iterable<string | null | undefined>) {
    this.known = secrets ? new KnownSecrets(secrets) : null;
  }

  matcher(): SecretMatcher | null {
    const m = this.known?.current() ?? null;
    return m && m.size > 0 ? m : null;
  }

  redact(text: string): string {
    return this.apply(text, false).text;
  }

  /** `pemOpen`: the text starts inside a private key block (see StreamRedactor). */
  apply(text: string, pemOpen: boolean): { text: string; pemOpen: boolean } {
    const m = this.matcher();
    const known = m ? m.redact(text) : text;
    const pem = redactPem(known, pemOpen);
    return { text: redactRules(pem.text), pemOpen: pem.open };
  }
}

/** Token characters that may continue a token cut at the end of the previous piece. */
const CONTINUATION = /^[ \t]*[A-Za-z0-9_.+/=-]+/;
/** After a complete match at the end: only a random-looking run (with a digit), no indent. */
const LIKELY_REST = /^[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/;

/**
 * Redacts one stream piece by piece, keeping a small tail of the previous piece:
 * - a known value split between two pieces: its end is masked here, and its start was masked at
 *   the end of the previous piece (5+ characters of a value's start are masked there; fewer can
 *   show);
 * - a token cut at the end of a piece (`ghp_abc`): the next piece's leading token characters
 *   are masked; after a match that reaches the end of a piece, only a leading run that looks
 *   random (has a digit) is, so `token ghp_...` then `done` keeps `done`;
 * - a private key block continues until its END line.
 */
export class StreamRedactor {
  private tail = '';
  /** The previous piece ended with a cut token: 'prefix' (surely) or 'match' (maybe). */
  private cont: 'prefix' | 'match' | null = null;
  private pemOpen = false;

  constructor(private readonly r: Redactor = new Redactor()) {}

  push(text: string): string {
    const m = this.r.matcher();
    let head = 0;
    if (m && this.tail) {
      const off = this.tail.length + 1;
      for (const [a, b] of m.ranges(`${this.tail}\n${text}`)) {
        if (a < off && b > off) head = Math.max(head, b - off);
      }
    }
    if (this.cont && !this.pemOpen) {
      const rest = text.slice(head);
      const lead = this.cont === 'prefix' ? CONTINUATION.exec(rest) : LIKELY_REST.exec(rest);
      if (lead) head += lead[0].length;
    }
    const res = this.r.apply(head > 0 ? text.slice(head) : text, this.pemOpen);
    let out = head > 0 ? REDACTED + res.text : res.text;
    this.pemOpen = res.pemOpen;
    this.cont = null;
    if (!this.pemOpen) {
      const partial = PARTIAL_TOKEN_AT_END.exec(out);
      if (partial) {
        out = out.slice(0, partial.index) + REDACTED;
        this.cont = 'prefix';
      } else if (out.endsWith(REDACTED) && /[A-Za-z0-9_]$/.test(text)) {
        this.cont = 'match';
      }
      // A value may also have started in an earlier piece (split in 3+ pieces).
      const j = m ? Math.min(m.partialAtEnd(this.tail + text), text.length) : 0;
      if (j > 0 && out.endsWith(text.slice(text.length - j))) {
        out = out.slice(0, out.length - j) + REDACTED;
      }
    }
    this.tail = m ? (this.tail + text).slice(-m.maxLen) : '';
    return out;
  }
}
