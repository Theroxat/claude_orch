/** Redaction: formats, known values in every encoding, streams, false positives, ReDoS, speed. */
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  Redactor,
  SECRET_RULES,
  SecretMatcher,
  SecretSet,
  StreamRedactor,
  composeSecrets,
  envSecretValues,
  looksLikeSecretValue,
  redactSecrets,
  secretVariants,
} from './index';

const R = REDACTED;

// Test fixtures built at runtime, so no scanner flags this file.
const j = (...p: string[]) => p.join('');
const GH = j('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const AWS_ID = j('AKIA', 'IOSFODNN7EXAMPLE');
const AWS_SECRET = j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');
const SLACK = j('xoxb', '-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx');
const STRIPE = j('sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc');
const STRIPE_RK = j('rk', '_live_', '51H8sQ2eZvKYlo2C0aBcDeFgH');
const JWT = j(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0',
  '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
);
const PEM = j(
  '-----BEGIN ',
  'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END ',
  'PRIVATE KEY-----',
);
const GEN = j('9fJ2kL0p', 'Q7xZ3vB8');
const GEN2 = j('a8F3kd92', 'LmQp0zXy');
const KNOWN = 'Zq8-x7Pw2Lm4Vt9Rk3Hs'; // a run secret (e.g. a sidecar .env value)

const known = new Redactor(() => [KNOWN, null, 'short']);

describe('secret formats', () => {
  it.each([
    ['GitHub token', `push with ${GH} failed`, GH],
    [
      'fine-grained GitHub PAT',
      `t=${j('github', '_pat_', '11ABCDEFG0123456789_abcdefghij')}`,
      'github_pat_11',
    ],
    ['Claude token', `token sk-ant-oat01-${'a'.repeat(30)} end`, 'sk-ant-oat01'],
    ['orch agent credential', `orch_agent_abc123.${'s'.repeat(20)}`, 'orch_agent_abc123'],
    ['orch PAT', `orch_pat_${'Z9'.repeat(10)}`, 'orch_pat_Z9'],
    ['AWS access key id', `aws key ${AWS_ID} here`, AWS_ID],
    ['AWS secret (env)', `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, AWS_SECRET],
    ['AWS secret (JSON)', `{"SecretAccessKey": "${AWS_SECRET}"}`, AWS_SECRET],
    ['Slack bot token', `slack ${SLACK}`, SLACK],
    [
      'Slack webhook',
      `https://hooks.slack.com/services/T000/B000/${'X'.repeat(24)}`,
      'X'.repeat(24),
    ],
    [
      'Discord webhook',
      `https://discord.com/api/webhooks/123456/${'abc_DEF-1'.repeat(4)}`,
      'abc_DEF',
    ],
    ['Stripe live key', `stripe ${STRIPE}`, STRIPE],
    ['Stripe restricted key', STRIPE_RK, STRIPE_RK],
    ['JWT', `Cookie: session=${JWT}`, JWT.slice(0, 20)],
    ['PEM private key', `key:\n${PEM}\ndone`, 'MIIEvQ'],
    [
      'GCP service-account private_key (JSON-escaped PEM)',
      `{"type":"service_account","private_key":"${PEM.replace(/\n/g, '\\n')}\\n","client_email":"x"}`,
      'MIIEvQ',
    ],
    [
      'Azure storage connection string',
      `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${'Ab1+/'.repeat(10)}==;EndpointSuffix=core.windows.net`,
      'Ab1+/',
    ],
    [
      'Azure SAS',
      `https://acme.blob.core.windows.net/c?sv=2022&sig=${'aB3%2F'.repeat(6)}`,
      'aB3%2F',
    ],
    ['Authorization header', 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0', 'eC1hY2N'],
    ['GitHub token header', 'Authorization: token abcdef0123456789', 'abcdef0123'],
    ['x-api-key header', `curl -H "x-api-key: ${j('k3y-Val', 'ue-0099')}"`, 'k3y-Value'],
    ['URL credentials', 'postgres://app:S3cr3tPass@db:5432/app', 'S3cr3tPass'],
    ['generic FOO_SECRET=', `export FOO_SECRET=${GEN}`, GEN],
    ['generic JSON api_key', `{"api_key": "${GEN2}"}`, GEN2],
    ['generic password:', 'password: Tr0ub4dor&3xyz', 'Tr0ub4dor'],
    ['Google API key', j('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'), 'SyA1b2'],
    ['GitLab PAT', j('glpat', '-', 'abcdefghij0123456789'), 'glpat-abc'],
  ])('%s', (_name, text, leak) => {
    const out = redactSecrets(text);
    expect(out).toContain(R);
    expect(out).not.toContain(leak);
  });

  it('keeps the context around a redacted value', () => {
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe(`Authorization: Bearer ${R}`);
    expect(redactSecrets('postgres://app:S3cr3tPass@db/app')).toBe(`postgres://app:${R}@db/app`);
    expect(redactSecrets(`FOO_SECRET=${GEN} next`)).toBe(`FOO_SECRET=${R} next`);
    expect(redactSecrets(`a ${PEM} b`)).toBe(`a ${R} b`);
  });

  it('masks an unterminated private key up to the end of its body', () => {
    const cut = PEM.slice(0, 60);
    expect(redactSecrets(`x ${cut}`)).toBe(`x ${R}`);
    // Inside a JSON string: the closing quote and the rest of the line stay.
    expect(redactSecrets(`{"k":"${cut.replace(/\n/g, '\\n')}","n":1}`)).toBe(`{"k":"${R}","n":1}`);
  });

  it('masks orch and Anthropic tokens glued to a letter, digit or token character', () => {
    const ant = j('sk-', 'ant-oat01-', 'a'.repeat(30));
    const pat = j('orch_', 'pat_', 'Z9'.repeat(10));
    const agent = j('orch_', 'agent_abc123.', 's'.repeat(32));
    for (const token of [ant, pat, agent]) {
      for (const before of ['\\n', 'x', '7', '_', '.', '-']) {
        const out = redactSecrets(`{"log":"line${before}${token}"}`);
        expect(out, `${before}${token}`).toContain(R);
        expect(out).not.toContain(token.slice(0, 12));
      }
    }
  });

  it('the orch agent id is bounded: no quadratic scan, overlong ids are not a credential', () => {
    expect(redactSecrets(j('orch_', 'agent_', 'a'.repeat(65), '.secret'))).not.toContain(R);
    const text = j('orch_', 'agent_').repeat(4000);
    const t0 = performance.now();
    redactSecrets(text);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('no false positives on common text', () => {
  it.each([
    ['git SHA', 'commit 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a'],
    ['short SHA', 'HEAD is now at 3f2a9c1 fix: thing'],
    ['UUID', 'task 123e4567-e89b-12d3-a456-426614174000 started'],
    ['token counts', '{"input_tokens": 12345678, "output_tokens":87654321}'],
    ['code', 'const token = options.apiToken; password: string;'],
    ['placeholders', 'API_KEY=${API_KEY} SECRET_KEY=<your-secret-key> PASSWORD=changeme'],
    ['prose', 'The secret to good tests is a short feedback loop. Passwords are hashed.'],
    ['paths', 'wrote /home/user/project/src/token-store.ts'],
    ['npm integrity', 'integrity sha512-'],
    ['words', 'tokenizer: wordpiece, password_reset: enabled'],
  ])('%s', (_name, text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves base64 images and long base64 blobs alone (no generic high-entropy rule)', () => {
    const img = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'.repeat(20)}`;
    expect(redactSecrets(img)).toBe(img);
  });

  it('thresholds of the generic assignment rule', () => {
    expect(looksLikeSecretValue('a8F3kd92')).toBe(true); // 8 chars, letters + digits
    expect(looksLikeSecretValue('a8F3kd9')).toBe(false); // < 8 chars
    expect(looksLikeSecretValue('abcdefgh')).toBe(false); // 3 bits/char, no digit
    expect(looksLikeSecretValue('aaaabbbb')).toBe(false); // low entropy
    expect(looksLikeSecretValue('12345678901')).toBe(false); // number
    expect(looksLikeSecretValue('options.apiToken')).toBe(false); // code
    expect(looksLikeSecretValue('${GITHUB_TOKEN}')).toBe(false); // placeholder
  });
});

describe('known secret values', () => {
  const b64 = (s: string) => btoa(s);
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hex = (s: string) =>
    [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

  it('drops values under 8 characters', () => {
    expect(known.redact('short is fine')).toBe('short is fine');
  });

  it.each([
    ['plain', `x ${KNOWN} y`],
    ['JSON-escaped', JSON.stringify({ v: `a"${KNOWN}"b` })],
    ['URL-encoded', `q=${encodeURIComponent(`${KNOWN}&/x`)}`],
    ['hex', `dump ${hex(KNOWN)} end`],
    ['HEX', `dump ${hex(KNOWN).toUpperCase()} end`],
    ['base64 (whole)', `v=${b64(KNOWN)}`],
    ['base64 (offset 1)', `v=${b64(`a${KNOWN}tail`)}`],
    ['base64 (offset 2)', `v=${b64(`ab${KNOWN}tail`)}`],
    ['base64 (Basic auth)', `Basic-ish ${b64(`x-access-token:${KNOWN}`)}`],
    ['base64url', `v=${b64url(`?${KNOWN}`)}`],
    ['line-wrapped', `${KNOWN.slice(0, 7)}\n${KNOWN.slice(7, 13)}\r\n  ${KNOWN.slice(13)} done`],
    ['line-wrapped base64', `${b64(KNOWN).slice(0, 10)}\n${b64(KNOWN).slice(10)}`],
  ])('%s', (_name, text) => {
    const out = known.redact(text);
    expect(out).toContain(R);
    // No 8-char run of the secret or of its encodings survives.
    for (const v of secretVariants(KNOWN)) {
      for (let i = 0; i + 8 <= v.length; i += 4) expect(out).not.toContain(v.slice(i, i + 8));
    }
  });

  it('keeps the text around a line-wrapped value', () => {
    expect(known.redact(`a ${KNOWN.slice(0, 10)}\n${KNOWN.slice(10)} b`)).toBe(`a ${R} b`);
  });

  it('reads the source on every call and applies new values at once', () => {
    const set = new SecretSet();
    const r = new Redactor(() => set.values());
    expect(r.redact(`v ${KNOWN}`)).toBe(`v ${KNOWN}`);
    set.add('run1', [KNOWN, 'tiny']);
    expect(r.redact(`v ${KNOWN}`)).toBe(`v ${R}`);
    set.drop('run1');
    expect(r.redact(`v ${KNOWN}`)).toBe(`v ${KNOWN}`);
  });
});

describe('env values as known secrets', () => {
  it.each([
    ['DB_PASSWORD', 'hunter2-orch', ['hunter2-orch']],
    ['API_KEY', 'k-0123456789', ['k-0123456789']],
    ['RANDOM_VALUE', 'Zq8x7Pw2Lm4Vt9Rk', ['Zq8x7Pw2Lm4Vt9Rk']],
    ['DATABASE_URL', 'postgres://app:Pa55w0rd-x@db:5432/app', ['Pa55w0rd-x']],
    ['REDIS_URL', 'redis://cache:6379', []],
    ['NODE_ENV', 'production', []],
    ['POSTGRES_PASSWORD', 'postgres', []],
    ['PORT', '80808080', []],
    ['APP_HOME', '/workspace/app/data', []],
    ['DB_HOST', 'db.internal', []],
    ['SHORT_TOKEN', 'abc', []],
  ])('%s', (key, value, expected) => {
    expect(envSecretValues(key, value)).toEqual(expected);
  });

  it('reads compose environment (map and list) and build args', () => {
    const model = {
      services: {
        db: { environment: { POSTGRES_PASSWORD: 'Sup3rS3cret!', POSTGRES_DB: 'app' } },
        api: {
          environment: [`JWT_SECRET=${j('jwt-s3cr', 'et-v4lue')}`, 'LOG_LEVEL=debug'],
          build: { args: { NPM_TOKEN: 'npm-t0ken-value' } },
        },
      },
    };
    expect(composeSecrets(model).sort()).toEqual([
      'Sup3rS3cret!',
      'jwt-s3cret-v4lue',
      'npm-t0ken-value',
    ]);
    expect(composeSecrets(null)).toEqual([]);
  });
});

describe('StreamRedactor', () => {
  const feed = (s: StreamRedactor, pieces: string[]) => pieces.map((p) => s.push(p));
  const leaks = (out: string[], secret: string) => {
    const all = out.join('\n');
    for (let i = 0; i + 5 <= secret.length; i++) {
      if (all.includes(secret.slice(i, i + 5))) return secret.slice(i, i + 5);
    }
    return null;
  };

  it('masks a known value split between two pieces, on both sides', () => {
    for (let cut = 1; cut < KNOWN.length; cut++) {
      const out = feed(new StreamRedactor(known), [
        `a ${KNOWN.slice(0, cut)}`,
        `${KNOWN.slice(cut)} b`,
      ]);
      expect(leaks(out, KNOWN), `cut at ${cut}: ${out.join(' | ')}`).toBeNull();
      expect(out[1]).toMatch(/ b$/);
    }
  });

  it('masks a known value split over three pieces', () => {
    const out = feed(new StreamRedactor(known), [
      `x ${KNOWN.slice(0, 6)}`,
      KNOWN.slice(6, 12),
      `${KNOWN.slice(12)} y`,
    ]);
    expect(leaks(out, KNOWN)).toBeNull();
  });

  it('masks a token cut at the end of a piece and its continuation', () => {
    for (const cut of [6, 12, 24, 30]) {
      const out = feed(new StreamRedactor(), [
        `push ${GH.slice(0, cut)}`,
        `${GH.slice(cut)} rejected`,
      ]);
      expect(leaks(out, GH.slice(4)), `cut at ${cut}: ${out.join(' | ')}`).toBeNull();
      expect(out[1]).toContain('rejected');
    }
  });

  it('keeps the next line when a token ends a line', () => {
    const out = feed(new StreamRedactor(), [`second ${GH}`, 'third', '  4 passed']);
    expect(out).toEqual([`second ${R}`, 'third', '  4 passed']);
  });

  it('masks a private key spread over many lines', () => {
    const s = new StreamRedactor();
    const out = feed(s, ['key:', ...PEM.split('\n'), 'after']);
    expect(out.join('\n')).not.toContain('MIIEvQ');
    expect(out.join('\n')).not.toContain('BKcwgg');
    expect(out[out.length - 1]).toBe('after');
  });

  it('leaves ordinary lines unchanged', () => {
    const lines = [
      'npm test',
      '  ✓ 42 tests passed',
      'commit 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a',
    ];
    expect(feed(new StreamRedactor(known), lines)).toEqual(lines);
  });
});

describe('SecretMatcher.partialAtEnd', () => {
  // The previous implementation: every proper prefix (5+ chars) of every value in a Set.
  const reference = (values: string[], text: string) => {
    const prefixes = new Set<string>();
    let maxLen = 0;
    for (const v of values) {
      maxLen = Math.max(maxLen, v.length);
      for (let n = 5; n < v.length; n++) prefixes.add(v.slice(0, n));
    }
    for (let n = Math.min(maxLen - 1, text.length); n >= 5; n--) {
      if (prefixes.has(text.slice(text.length - n))) return n;
    }
    return 0;
  };

  it('finds the longest end of the text that starts a value, like the reference', () => {
    let x = 7;
    const rnd = (n: number) => {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      return (x >>> 16) % n;
    };
    const word = (len: number) => Array.from({ length: len }, () => 'abAB'[rnd(4)]).join('');
    for (let round = 0; round < 300; round++) {
      const values = Array.from({ length: 1 + rnd(4) }, () => word(8 + rnd(20)));
      const m = new SecretMatcher(values);
      const v = values[rnd(values.length)] as string;
      const texts = [word(rnd(40)), `${word(rnd(10))}${v.slice(0, rnd(v.length + 1))}`];
      for (const text of texts) expect(m.partialAtEnd(text), text).toBe(reference(values, text));
    }
  });

  it('stays fast with long values and long lines', () => {
    const value = j('Qx7', 'k'.repeat(4000));
    const m = new SecretMatcher([value, ...secretVariants(value)]);
    const line = 'z'.repeat(8000);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) m.partialAtEnd(line);
    expect(m.partialAtEnd(`${line}${value.slice(0, 3000)}`)).toBe(3000);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('ReDoS: every rule stays linear on adversarial input', () => {
  const SIZE = 32 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  // Prefixes and near-misses of every rule, repeated: the classic quadratic shapes.
  const units = [
    'a',
    'a.',
    'a-',
    'a:',
    'a=',
    '-',
    '.',
    ' ',
    '\n',
    ':',
    '=',
    '@',
    '/',
    'eyJ',
    'eyJa.',
    'eyJ-',
    'ghp_',
    'ghp_a',
    'github_pat_',
    'orch_agent_',
    'orch_agent_a',
    'orch_pat_',
    'sk-ant-',
    'sk-proj-',
    'xoxb-',
    'AKIA',
    'AIza',
    'sk_live_',
    'whsec_',
    'npm_',
    'glpat-',
    'a://',
    'a://b:',
    'a://b:c',
    'x:',
    'secret',
    'secret=',
    'token:',
    'a_secret_',
    'SECRET',
    'password=',
    'api_key"',
    '"token": "',
    'Authorization: ',
    'Authorization: Bearer ',
    'x-api-key: ',
    'AccountKey=',
    '&sig=',
    j('-----BEGIN ', 'PRIVATE KEY-----'),
    '-----BEGIN ',
    '-----END PRIVATE KEY-----',
    'PRIVATE KEY',
    'hooks.slack.com/services/',
    'discord.com/api/webhooks/1',
    'eyJabcdefgh.eyJabcdefgh.',
  ];
  const randomText = (seed: number) => {
    let x = seed;
    const alphabet = 'aZ09_-.:=/@+ "\'\n\tghp_skAKIAeyJ';
    let s = '';
    for (let i = 0; i < SIZE; i++) {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      s += alphabet[(x >>> 16) % alphabet.length];
    }
    return s;
  };

  it('each rule on 32 KB of each adversarial shape runs in a few ms', () => {
    let worst = { ms: 0, rule: '', unit: '' };
    for (const unit of units) {
      const text = fill(unit);
      for (const rule of SECRET_RULES) {
        const t0 = performance.now();
        rule.re.lastIndex = 0;
        text.replace(rule.re, '');
        const ms = performance.now() - t0;
        if (ms > worst.ms) worst = { ms, rule: rule.id, unit };
      }
    }
    // Linear: a quadratic rule takes seconds on 32 KB. Generous for loaded CI machines.
    expect(worst.ms, JSON.stringify(worst)).toBeLessThan(100);
  });

  it('full redaction of adversarial and random input stays fast', () => {
    const stream = new StreamRedactor(known);
    let worst = 0;
    for (const text of [...units.map(fill), randomText(1), randomText(2), randomText(3)]) {
      const t0 = performance.now();
      known.redact(text);
      stream.push(text);
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(worst).toBeLessThan(200);
  });
});

describe('performance budget', () => {
  it('redacts 32 KB batches well under 1 ms per KB', () => {
    // A realistic run: ~30 known values (tokens, credential, env values).
    const values = Array.from(
      { length: 30 },
      (_, i) => `s3cr3t-${i}-${'Qx7'.repeat(4)}-${i * 7919}`,
    );
    const r = new Redactor(() => values);
    const line = (i: number) =>
      i % 7 === 0
        ? `{"type":"tool_result","content":"src/file${i}.ts:12: const x = await fetch(url, { headers }); // ${'lorem ipsum '.repeat(4)}"}`
        : `  ${i} | export function handler${i}(req: Request): Response { return json({ ok: true, id: '${i}' }); }`;
    let text = '';
    for (let i = 0; text.length < 32 * 1024; i++) text += `${line(i)}\n`;
    text = text.slice(0, 32 * 1024);
    for (let i = 0; i < 5; i++) r.redact(text); // warm up
    const n = 30;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r.redact(text);
    const msPerKb = (performance.now() - t0) / n / 32;
    console.log(`redaction: ${msPerKb.toFixed(4)} ms/KB (32 KB batch, 30 known values)`);
    expect(msPerKb).toBeLessThan(0.25);
  });
});
