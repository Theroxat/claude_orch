/**
 * Secret FORMATS (tokens of a known shape), masked wherever they appear, without knowing their
 * value. Shared by the agent and the server; see docs/security.md ("Redaction").
 *
 * Every regex here must run in linear time on any input (it is applied to untrusted output):
 * - a token prefix is anchored with a look-behind on the token's own character class (not
 *   `\b`), so a long run of token characters is scanned from its start only;
 * - quantifiers that can fail after scanning far are bounded;
 * - no nested or overlapping quantifiers.
 * `redact.test.ts` fuzzes every rule with adversarial inputs to keep it that way.
 */

export const REDACTED = '[REDACTED]';

/** Bits of Shannon entropy per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_RE =
  /^(?:[$%<{[(]|process\.|env\.|os\.environ|import\.meta)|REDACTED|^(?:x+|\*+|changeme|example\w*|password\w*|undefined|null|none|required|optional|string|secret\w*|your[_-]\w*)$/i;
/** Dotted member access (`options.apiToken`, `this.cfg.secret`): code, not a value. */
const MEMBER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/**
 * Whether the value of a `*_SECRET=` / `"token": ...` assignment looks like a real secret:
 * 8+ characters, not a placeholder or code, and random-looking. Thresholds (tested):
 * entropy >= 3.5 bits/char (gitleaks' generic rule), or >= 3.0 with both letters and digits.
 * Pure numbers (`"output_tokens": 12345678`) and plain words never match.
 */
export function looksLikeSecretValue(v: string): boolean {
  if (v.length < 8) return false;
  if (/^[\d.,:_-]+$/.test(v)) return false;
  if (PLACEHOLDER_RE.test(v) || MEMBER_RE.test(v)) return false;
  const h = shannonEntropy(v);
  if (h >= 3.5) return true;
  return h >= 3 && /[A-Za-z]/.test(v) && /\d/.test(v);
}

export interface SecretRule {
  id: string;
  /** Global regex with exactly two groups: (kept prefix)(secret). Text after them is kept. */
  re: RegExp;
  check?: (secret: string) => boolean;
  /** Literal that must be in the text for the rule to match (skips the scan otherwise). */
  hint?: string;
  /** The match starts at a keyword: at most 40 key characters may precede it (`MY_API_TOKEN`). */
  keyStart?: boolean;
}

const KEY_CHAR = /[A-Za-z0-9_-]/;
function keyRunFits(text: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && KEY_CHAR.test(text[i] as string); i--) if (++n > 40) return false;
  return true;
}

/** Look-behind anchor on token characters (base64url and `.`). */
const T = '(?<![A-Za-z0-9_.-])';
const GENERIC_KEYS =
  'secret|token|passw(?:or)?d|pwd|api_?key|apikey|access_?key|private_?key|client_?secret|credentials?|signing_?key|encryption_?key';

export const SECRET_RULES: readonly SecretRule[] = [
  // orch agent credentials and personal access tokens.
  {
    id: 'orch-agent',
    hint: 'orch_agent_',
    re: new RegExp(`${T}()(orch_agent_[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)`, 'g'),
  },
  { id: 'orch-pat', hint: 'orch_pat_', re: new RegExp(`${T}()(orch_pat_[A-Za-z0-9_-]+)`, 'g') },
  // Anthropic (Claude OAuth / API keys) and OpenAI project / service keys.
  { id: 'anthropic', hint: 'sk-ant-', re: new RegExp(`${T}()(sk-ant-[A-Za-z0-9_-]+)`, 'g') },
  {
    id: 'openai',
    hint: 'sk-',
    re: new RegExp(`${T}()(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,})`, 'g'),
  },
  // GitHub installation / user / OAuth / fine-grained tokens, GitLab, npm.
  { id: 'github', hint: 'gh', re: /\b()(gh[pousr]_[A-Za-z0-9]{20,})/g },
  { id: 'github-pat', hint: 'github_pat_', re: /\b()(github_pat_[A-Za-z0-9_]{20,})/g },
  { id: 'gitlab', hint: 'glpat-', re: /\b()(glpat-[A-Za-z0-9_-]{20,})/g },
  { id: 'npm', hint: 'npm_', re: /\b()(npm_[A-Za-z0-9]{36})(?![A-Za-z0-9])/g },
  // Slack bot / user / app tokens and webhooks; Discord webhooks.
  { id: 'slack', hint: 'xox', re: /\b()(xox[abposre]-[A-Za-z0-9-]{10,})/g },
  { id: 'slack-app', hint: 'xapp-', re: /\b()(xapp-\d-[A-Za-z0-9-]{10,})/g },
  {
    id: 'slack-webhook',
    hint: 'hooks.slack.com',
    re: /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)([A-Za-z0-9+/_-]{8,})/g,
  },
  {
    id: 'discord-webhook',
    hint: '/api/webhooks/',
    re: /(discord(?:app)?\.com\/api\/webhooks\/)(\d{1,30}\/[A-Za-z0-9_-]+)/g,
  },
  // Stripe secret / restricted keys and webhook secrets.
  { id: 'stripe', hint: 'k_', re: /\b()((?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,})/g },
  { id: 'stripe-webhook', hint: 'whsec_', re: /\b()(whsec_[A-Za-z0-9]{20,})/g },
  // AWS access key ids (the secret key is caught by the generic assignment rule).
  {
    id: 'aws-key-id',
    re: /\b()((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})(?![A-Za-z0-9])/g,
  },
  { id: 'google-api-key', hint: 'AIza', re: /\b()(AIza[0-9A-Za-z_-]{35})/g },
  // JSON Web Tokens (header and payload are base64url JSON objects: `eyJ`).
  {
    id: 'jwt',
    hint: 'eyJ',
    re: new RegExp(`${T}()(eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})`, 'g'),
  },
  // Azure storage / service bus connection strings and SAS signatures.
  {
    id: 'azure-key',
    re: /\b((?:AccountKey|SharedAccessKey|SharedAccessSignature)=)([^;\s"'<>]{8,})/gi,
  },
  { id: 'azure-sas', hint: 'sig=', re: /([?&]sig=)([A-Za-z0-9%+/=]{16,})/g },
  // HTTP auth headers (git extraHeader values, curl -H ...).
  {
    id: 'auth-header',
    re: /((?:Proxy-)?Authorization:[ \t]*(?:Basic|Bearer|token)[ \t]+)([A-Za-z0-9+/=._~-]+)/gi,
  },
  {
    id: 'api-key-header',
    re: /\b((?:x-api-key|api-key|x-auth-token|private-token|x-goog-api-key):[ \t]*)([^\s"',;]{8,})/gi,
  },
  // Credentials in URLs (https://user:secret@host).
  {
    id: 'url-credentials',
    hint: '://',
    re: /(:\/\/[^\s/:@]{1,256}:)([^\s/@]{1,512})(?=@)/g,
  },
  // Generic `FOO_SECRET=...`, `"api_key": "..."`, `password: ...` with a random-looking value.
  {
    id: 'generic-assignment',
    // Starts at the keyword (fast to find); the key's start is checked in `keyStart`.
    re: new RegExp(
      `((?:${GENERIC_KEYS})[A-Za-z0-9_-]{0,40}["']?[ \\t]{0,5}(?::=|=>|[:=])[ \\t]{0,5}["']?)([^\\s"'\`,;)}\\]]{8,})`,
      'gi',
    ),
    keyStart: true,
    check: looksLikeSecretValue,
  },
];

const PEM_BEGIN = /-----BEGIN[A-Z0-9 _-]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END[A-Z0-9 _-]{0,64}PRIVATE KEY(?: BLOCK)?-----/g;
/** Body of an armored key: base64, whitespace, `\n` escapes, armor headers. */
const PEM_BODY = /[A-Za-z0-9+/=\s\\:,.-]*/y;

/**
 * Masks private key blocks (PEM / OpenSSH / PGP, also JSON-escaped as in a GCP service-account
 * file). `open` says the text starts inside a block (streaming); the result says whether it
 * ends inside one. An unterminated block is masked up to the end of its body characters.
 */
export function redactPem(text: string, open = false): { text: string; open: boolean } {
  if (!open && !text.includes('PRIVATE KEY')) return { text, open: false };
  let out = '';
  let pos = 0;
  let noEnd = false;
  /** Masks from `start` to the END marker (or the end of the body); true when unterminated. */
  const mask = (start: number, bodyFrom: number): boolean => {
    out += text.slice(pos, start) + REDACTED;
    if (!noEnd) {
      PEM_END.lastIndex = bodyFrom;
      const end = PEM_END.exec(text);
      if (end) {
        pos = end.index + end[0].length;
        return false;
      }
      noEnd = true; // no END after this point: later BEGINs need no search
    }
    PEM_BODY.lastIndex = bodyFrom;
    PEM_BODY.exec(text);
    pos = PEM_BODY.lastIndex;
    return pos >= text.length;
  };
  let tailOpen = open ? mask(0, 0) : false;
  while (!tailOpen) {
    PEM_BEGIN.lastIndex = pos;
    const m = PEM_BEGIN.exec(text);
    if (!m) break;
    tailOpen = mask(m.index, m.index + m[0].length);
  }
  return { text: out + text.slice(pos), open: tailOpen };
}

/** Applies SECRET_RULES (not the private key blocks). */
export function redactRules(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    if (rule.hint !== undefined && !out.includes(rule.hint)) continue;
    rule.re.lastIndex = 0;
    const src = out;
    out = out.replace(rule.re, (m: string, pre: string, secret: string, at: number) => {
      if (rule.keyStart && !keyRunFits(src, at)) return m;
      if (rule.check && !rule.check(secret)) return m;
      return pre + REDACTED + m.slice(pre.length + secret.length);
    });
  }
  return out;
}

/** Replaces every secret FORMAT (the rules above and private key blocks) with `[REDACTED]`. */
export function redactPatterns(text: string): string {
  return redactRules(redactPem(text).text);
}

/**
 * A token prefix at the very end of a piece of a stream (`ghp_abc`, the rest in the next piece):
 * too short for its rule, so masked on its own; the next piece's leading token characters are
 * masked too (see StreamRedactor).
 */
export const PARTIAL_TOKEN_AT_END =
  /(?<![A-Za-z0-9_.-])(?:gh[pousr]_|github_pat_|glpat-|npm_|sk-ant-|sk-proj-|sk-svcacct-|orch_agent_|orch_pat_|xox[abposre]-|xapp-|[sr]k_(?:live|test|prod)_|whsec_|AKIA|ASIA|AIza|eyJ)[A-Za-z0-9_.-]*$/;
