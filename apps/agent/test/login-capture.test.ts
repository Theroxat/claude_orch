import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkTokenShape,
  extractToken,
  extractTokenFromTerminal,
  login,
  LoginError,
  normalizeStdinToken,
  promptHidden,
} from '../src/cli/login';
import { findTokenInRows } from '../src/cli/token-capture';
import { tempDir } from './helpers/util';

// Obviously fake tokens (108 characters, like the real ones).
const FAKE = 'sk-ant-oat01-' + 'FAKEfake0123456789'.repeat(5) + 'xyzAA';
const FAKE2 = 'sk-ant-oat01-' + 'fakeFAKE9876543210'.repeat(5) + 'zyxBB';
const ESC = '\u001b';
const BEL = '\u0007';
const EOL = '\r\r\n';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

/** Positions words with CHA (`ESC[<n>G`) instead of spaces, like Claude Code's renderer. */
function cha(row: string): string {
  let out = '';
  let col = 0;
  for (const m of row.matchAll(/\S+/g)) {
    out += m.index === col ? m[0] : `${ESC}[${m.index + 1}G${m[0]}`;
    col = m.index + m[0].length;
  }
  return out;
}

const osc8 = (url: string, text: string) =>
  `${ESC}]8;id=nc4bbe;${url}${BEL}${text}${ESC}]8;;${BEL}`;

/**
 * Emits only the cells that changed between `prev` and `next` (rows of a region whose bottom the
 * cursor sits just below), in the given row order, skipping identical cells with cursor moves.
 */
function diffRender(prev: string[], next: string[], order: number[], cols: number): string {
  let out = '';
  let curRow = prev.length;
  for (const r of order) {
    const a = (prev[r] ?? '').padEnd(cols);
    const b = (next[r] ?? '').padEnd(cols);
    if (a === b) continue;
    out += '\r' + (curRow > r ? `${ESC}[${curRow - r}A` : `${ESC}[${r - curRow}B`);
    curRow = r;
    let col = 0;
    let c = 0;
    let alt = false;
    const lastText = (next[r] ?? '').length;
    while (c < Math.min(cols, lastText)) {
      if (a[c] === b[c]) {
        c++;
        continue;
      }
      let e = c;
      while (e < lastText && a[e] !== b[e]) e++;
      // Alternate absolute (CHA) and relative (CUF) moves.
      if (c !== col) out += alt ? `${ESC}[${c + 1}G` : `${ESC}[${c - col}C`;
      alt = !alt;
      out += b.slice(c, e);
      col = e;
      c = e;
    }
    if ((prev[r] ?? '').trimEnd().length > lastText) out += `\r${ESC}[${lastText}C${ESC}[K`;
  }
  return out + '\r' + `${ESC}[${prev.length - curRow}B`;
}

/** The waiting screen (URL + paste prompt) followed by a differential update to the success screen. */
function differentialStream(token: string, cols: number): string {
  const tok = [token.slice(0, cols), token.slice(cols)];
  // The URL rows that the token rows will overwrite share some identical cells with them, so the
  // renderer skips those cells.
  const similar = (t: string, filler: string) =>
    [...t.padEnd(cols, filler)].map((ch, i) => (i % 4 === 1 && i < t.length ? ch : '%')).join('');
  const url1 = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88';
  const url2 = similar(tok[0] ?? '', '%');
  const url3 =
    (tok[1] ?? '').slice(0, 20) + '&state=7goSpH2iJkIehPDTF1_pnqko'.padEnd(cols - 20, 'Q');
  const url = url1 + url2 + url3;
  const prev = [
    " Browser didn't open? Use the url below to sign in (c to copy)",
    '',
    url1,
    url2,
    url3,
    '',
    '',
    ' Paste code here if prompted >',
  ];
  const next = [
    '✓ Long-lived authentication token created successfully!',
    '',
    'Your OAuth token (valid for 1 year):',
    tok[0] ?? '',
    tok[1] ?? '',
    '',
    "Store this token securely. You won't be able to see it again.",
    '',
    'Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>',
  ];
  let s =
    `${ESC}7${ESC}[r${ESC}8${ESC}[?25l${ESC}[?2004h` + cha('Welcome to Claude Code v2.1.306') + EOL;
  s += '.'.repeat(58) + EOL + EOL;
  s += cha(' This will guide you through long-lived (1-year) auth token setup for your') + EOL;
  s += cha(' Claude account. Claude subscription required.') + EOL + EOL;
  for (const row of prev) {
    s += (row.startsWith('https') || row.includes('%') ? osc8(url, row) : cha(row)) + EOL;
  }
  // The member pastes the code: the prompt line is updated in place, then the success screen.
  s += `${ESC}[>0q${ESC}[?u${ESC}[c\r${ESC}[31C${ESC}[1Aabcd\r\r\n\r${ESC}[33C${ESC}[1A${ESC}[K\r\r\n`;
  // Row 4 (second token row) first, then row 3: wrapped rows emitted out of order.
  s += diffRender(prev, next, [0, 2, 4, 3, 5, 6, 7, 8], cols);
  s += EOL;
  s += '\r' + cha('Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>') + EOL;
  return s;
}

describe('extractTokenFromTerminal', () => {
  it('reads an exact token from a differential render that skips identical cells (the old ANSI-strip parser failed here)', async () => {
    const stream = differentialStream(FAKE, 80);
    expect(stream).not.toContain(FAKE.slice(0, 20)); // cells really are skipped
    expect(await extractTokenFromTerminal(stream, 80, 30)).toBe(FAKE);
    // Regression: the plain ANSI-stripping parser cannot see the skipped cells.
    expect(extractToken(stream)).not.toBe(FAKE);
  });

  it('reads a token hard-wrapped at 80 columns with \\r\\r\\n, with or without left padding', async () => {
    const plain = `Your OAuth token (valid for 1 year):${EOL}${FAKE.slice(0, 80)}${EOL}${FAKE.slice(80)}${EOL}${EOL}Store this token securely.${EOL}`;
    expect(await extractTokenFromTerminal(plain, 80, 24)).toBe(FAKE);
    const padded = `  Your OAuth token:${EOL}  ${ESC}[33m${FAKE.slice(0, 78)}${EOL}  ${FAKE.slice(78)}${ESC}[39m${EOL}${EOL}  Store this token securely.${EOL}`;
    expect(await extractTokenFromTerminal(padded, 80, 24)).toBe(FAKE);
  });

  it("joins xterm's own soft-wrapped rows (no newline at the edge)", async () => {
    expect(await extractTokenFromTerminal(`Token:\r\n${FAKE}\r\nStore it.\r\n`, 50, 24)).toBe(FAKE);
  });

  it('reads a token on one line at 200 columns', async () => {
    const out = `${ESC}[2J${ESC}[HYour OAuth token (valid for 1 year):\r\n${ESC}[33m${FAKE}${ESC}[39m\r\n\r\nStore this token securely.\r\n`;
    expect(await extractTokenFromTerminal(out, 200, 40)).toBe(FAKE);
  });

  it('reads a token in a box frame, on one row and wrapped over two rows', async () => {
    const width = FAKE.length + 4;
    const box1 = `╭${'─'.repeat(width - 2)}╮\r\n│ ${FAKE} │\r\n╰${'─'.repeat(width - 2)}╯\r\n`;
    expect(await extractTokenFromTerminal(box1, 120, 24)).toBe(FAKE);
    expect(extractToken(box1)).toBe(FAKE);
    const inner = 76;
    const box2 =
      `╭${'─'.repeat(78)}╮${EOL}│ ${FAKE.slice(0, inner)} │${EOL}` +
      `│ ${FAKE.slice(inner).padEnd(inner)} │${EOL}│ ${'Store this token securely.'.padEnd(inner)} │${EOL}╰${'─'.repeat(78)}╯${EOL}`;
    expect(await extractTokenFromTerminal(box2, 80, 24)).toBe(FAKE);
    expect(extractToken(box2)).toBe(FAKE);
  });

  it('handles CRLF and trailing spaces/newlines', async () => {
    const out = `Your token:\r\n${FAKE}   \r\n\r\n`;
    expect(await extractTokenFromTerminal(out, 80, 24)).toBe(FAKE);
    expect(extractToken(out)).toBe(FAKE);
  });

  it('returns null when there is no token, and ignores CLAUDE_CODE_OAUTH_TOKEN=<token>', async () => {
    const none = `Open the URL\r\nPaste code here if prompted >\r\n`;
    expect(await extractTokenFromTerminal(none, 80, 24)).toBeNull();
    const placeholder = 'Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n';
    expect(await extractTokenFromTerminal(placeholder, 80, 24)).toBeNull();
    expect(extractToken(placeholder)).toBeNull();
    expect(await extractTokenFromTerminal(`Token:\r\n${FAKE}\r\n\r\n${placeholder}`, 80, 24)).toBe(
      FAKE,
    );
  });

  it('applies terminal resizes recorded during the run', async () => {
    const before = 'Waiting...\r\n';
    const out = `${before}Token:\r\n${FAKE}\r\nStore it.\r\n`;
    expect(
      await extractTokenFromTerminal(out, 40, 24, [{ at: before.length, cols: 120, rows: 30 }]),
    ).toBe(FAKE);
  });
});

describe('checkTokenShape', () => {
  it('accepts a well-formed token and gives a reason otherwise, never echoing the input', () => {
    expect(checkTokenShape(`  ${FAKE}\n`)).toEqual({ ok: true, token: FAKE });
    const cases: [string, RegExp][] = [
      ['', /no token/],
      [FAKE.slice(0, 40), /too short/],
      ['sk-ant-api03-' + 'x'.repeat(90), /wrong prefix/],
      [FAKE.slice(0, 60) + '!' + FAKE.slice(60), /bad characters/],
      [FAKE.slice(0, 60) + ' ' + FAKE.slice(60), /whitespace/],
    ];
    for (const [input, reason] of cases) {
      const res = checkTokenShape(input);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toMatch(reason);
        expect(res.reason).not.toContain('FAKE');
      }
    }
  });
});

/** An io whose stdin answers each prompt with the next chunk (one chunk per prompt). */
function scriptedIo(answers: string[]) {
  const stdin = new PassThrough();
  const err: string[] = [];
  const out: string[] = [];
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  stdout.on('data', (c: Buffer) => out.push(c.toString()));
  stderr.on('data', (c: Buffer) => {
    err.push(c.toString());
    if (c.toString().includes('(input hidden): ')) {
      const next = answers.shift();
      if (next === undefined) stdin.end();
      else setImmediate(() => stdin.write(next));
    }
  });
  return { io: { stdin, stdout, stderr }, out, err };
}

describe('promptHidden', () => {
  it('treats a newline inside a pasted chunk as a wrap and strips paste markers', async () => {
    const half = 60;
    const a = scriptedIo([`${FAKE.slice(0, half)}\n${FAKE.slice(half)}\n`]);
    expect(await promptHidden(a.io, 'Paste (input hidden): ')).toBe(FAKE);
    const b = scriptedIo([
      `${ESC}[200~${FAKE.slice(0, half)}\r\n  ${FAKE.slice(half)}${ESC}[201~\r`,
    ]);
    expect(await promptHidden(b.io, 'Paste (input hidden): ')).toBe(FAKE);
    expect(a.err.join('') + b.err.join('')).not.toContain('FAKE');
  });
});

describe('ambiguous captures', () => {
  it('returns null when two different well-formed tokens are found, the token when repeated', async () => {
    expect(findTokenInRows([`a ${FAKE}`, '', `b ${FAKE2}`])).toBeNull();
    expect(findTokenInRows([`a ${FAKE}`, '', `b ${FAKE}`])).toBe(FAKE);
    expect(findTokenInRows([`a ${FAKE}`, '', 'x sk-ant-oat01-short'])).toBe(FAKE);
    expect(extractToken(`${FAKE}\r\n\r\n${FAKE2}\r\n`)).toBeNull();
    expect(extractToken(`${FAKE}\r\n\r\n${FAKE}\r\n`)).toBe(FAKE);
    expect(await extractTokenFromTerminal(`${FAKE}\r\n\r\n${FAKE2}\r\n`, 200, 10)).toBeNull();
  });
});

/** An io whose stdin receives `chunks` at the given delays (ms after the prompt). */
function timedIo(chunks: [number, string][]) {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  stderr.on('data', (c: Buffer) => {
    if (c.toString().includes('(input hidden): ')) {
      for (const [ms, data] of chunks) setTimeout(() => stdin.write(data), ms);
    }
  });
  return { stdin, stdout: new PassThrough(), stderr };
}

describe('promptHidden across chunks', () => {
  it('keeps reading when a wrapped paste is split right after the newline', async () => {
    const io = timedIo([
      [0, `${FAKE.slice(0, 60)}\n`],
      [20, `${FAKE.slice(60)}\n`],
    ]);
    expect(await promptHidden(io, 'Paste (input hidden): ')).toBe(FAKE);
  });
  it('finishes at once on Enter after a complete token, and after a short wait otherwise', async () => {
    const a = timedIo([
      [0, `${FAKE}\n`],
      [30, 'junk\n'],
    ]);
    expect(await promptHidden(a, 'Paste (input hidden): ')).toBe(FAKE);
    const t0 = Date.now();
    const b = timedIo([[0, 'nope\n']]);
    expect(await promptHidden(b, 'Paste (input hidden): ')).toBe('nope');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
  });
});

describe('login token validation', () => {
  const base = (secrets: string) => ({
    secretsDir: secrets,
    claudeBin: 'x',
    tokenFromStdin: false,
    skipSetup: false,
  });

  it('stores a token captured from a differential render', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const s = scriptedIo([]);
    await login(
      {
        ...base(secrets),
        setupRunner: async () => ({ output: differentialStream(FAKE, 80), cols: 80, rows: 30 }),
      },
      s.io,
    );
    expect(readFileSync(join(secrets, 'claude-token'), 'utf8')).toBe(`${FAKE}\n`);
    expect(s.err.join('')).not.toContain('Paste');
  });

  it('rejects a truncated capture and falls back to the hidden prompt, re-asking on a bad paste', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const s = scriptedIo([`${FAKE2.slice(0, 50)}\n`, `${FAKE2}\n`]);
    await login(
      { ...base(secrets), setupRunner: async () => `Your token:\r\n${FAKE.slice(0, 50)}\r\n` },
      s.io,
    );
    const err = s.err.join('');
    expect(err).toContain('Could not read the token reliably (too short');
    expect(err).toContain('paste it below (input hidden)');
    expect(err).toContain('That does not look like a Claude OAuth token: too short');
    expect(err).not.toContain('FAKE');
    expect(readFileSync(join(secrets, 'claude-token'), 'utf8')).toBe(`${FAKE2}\n`);
  });

  it('does not trust the ANSI-strip parser on output with cursor movement (asks for a paste)', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const s = scriptedIo([`${FAKE2}\n`]);
    // The screen ends up without a token (its start is overwritten), while stripping ANSI codes
    // yields a well-formed but wrong token.
    const output = `Your token:\r\n${FAKE}${ESC}[1G${'X'.repeat(16)}\r\n`;
    expect(extractToken(output)).toMatch(/^sk-ant-oat01-.*X{16}$/);
    await login(
      { ...base(secrets), setupRunner: async () => ({ output, cols: 200, rows: 30 }) },
      s.io,
    );
    expect(s.err.join('')).toContain('paste it below (input hidden)');
    expect(readFileSync(join(secrets, 'claude-token'), 'utf8')).toBe(`${FAKE2}\n`);
  });

  it('gives up after 3 bad pastes without saving', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const s = scriptedIo(['nope\n', 'sk-ant-oat01-short\n', 'still bad\n']);
    await expect(
      login({ ...base(secrets), setupRunner: async () => 'no token here\n' }, s.io),
    ).rejects.toThrow(LoginError);
    expect(s.err.join('').match(/input hidden\): /g)).toHaveLength(3);
    expect(existsSync(join(secrets, 'claude-token'))).toBe(false);
  });

  it('--token-stdin joins a token split over lines with CRLF and rejects a bad shape', async () => {
    expect(normalizeStdinToken(`  ${FAKE.slice(0, 80)}\r\n${FAKE.slice(80)}\r\n`)).toBe(FAKE);
    expect(normalizeStdinToken('two words\r\nhere\n')).toBe('two words\nhere');
    const secrets = join(tmp.dir, 'secrets');
    const opts = { ...base(secrets), tokenFromStdin: true, skipSetup: true };
    const ok = new PassThrough();
    ok.end(`${FAKE.slice(0, 80)}\r\n${FAKE.slice(80)}\r\n`);
    const sink = new PassThrough();
    await login(opts, { stdin: ok, stdout: sink, stderr: sink });
    expect(readFileSync(join(secrets, 'claude-token'), 'utf8')).toBe(`${FAKE}\n`);

    const other = join(tmp.dir, 'other');
    const bad = new PassThrough();
    bad.end(`${FAKE.slice(0, 60)}\n`);
    await expect(
      login({ ...opts, secretsDir: other }, { stdin: bad, stdout: sink, stderr: sink }),
    ).rejects.toThrow(/too short/);
    expect(existsSync(join(other, 'claude-token'))).toBe(false);
  });
});
