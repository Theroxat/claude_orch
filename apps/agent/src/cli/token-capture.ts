/**
 * Reading the OAuth token printed by `claude setup-token` from its captured terminal output.
 *
 * Claude Code renders its UI with a differential terminal renderer: words are placed with cursor
 * moves, long strings are hard-wrapped at the terminal width, and on updates only the cells that
 * changed are rewritten (unchanged cells are skipped with cursor moves). Stripping ANSI codes from
 * the raw stream therefore silently drops characters. Instead the bytes are replayed into a
 * headless terminal emulator of the same size as the pty, and the token is read from the final
 * screen (scrollback included).
 */
import { createRequire } from 'node:module';
import type * as XtermHeadless from '@xterm/headless';

// @xterm/headless ships a CommonJS bundle without static named exports.
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof XtermHeadless;

/** Shape of a Claude long-lived OAuth token, as printed by `claude setup-token`. */
export const TOKEN_SHAPE = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{80,}$/;

export type ShapeCheck = { ok: true; token: string } | { ok: false; reason: string };

/** Checks (after trimming) that `raw` looks like a Claude OAuth token. Never echoes the input. */
export function checkTokenShape(raw: string): ShapeCheck {
  const token = raw.trim();
  if (token === '') return { ok: false, reason: 'no token given' };
  if (/\s/.test(token)) return { ok: false, reason: 'bad characters (it contains whitespace)' };
  if (!/^sk-ant-oat\d{2}-/.test(token))
    return { ok: false, reason: 'wrong prefix (expected sk-ant-oat01-...)' };
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: 'bad characters' };
  if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: 'too short (truncated?)' };
  return { ok: true, token };
}

/** A terminal size change that happened after `at` characters of output. */
export interface ResizeEvent {
  at: number;
  cols: number;
  rows: number;
}

const TOKEN_CHAR = '[A-Za-z0-9_-]';
const FRAME = '[│┃║|]';
// The token start (not preceded by a token character).
const TOKEN_START = new RegExp(`(?<!${TOKEN_CHAR})sk-ant-oat${TOKEN_CHAR}*`, 'g');
// After a token segment: nothing but spaces and possibly a closing frame.
const ONLY_TRAILER = new RegExp(`^\\s*(?:${FRAME}\\s*)?$`);
// The segment touches the right edge: end of row, or at most one space before a closing frame.
const AT_EDGE = new RegExp(`^(?: ?${FRAME}\\s*)?$`);
// A continuation row: only token characters, possibly framed.
const CONTINUATION = new RegExp(`^(\\s*(?:${FRAME}\\s*)?)(${TOKEN_CHAR}+)(\\s*(?:${FRAME}\\s*)?)$`);

/**
 * The well-formed token when every well-formed candidate is the same (a token rendered twice is
 * fine); null when they disagree (ambiguous: the caller asks for a paste). Without any
 * well-formed candidate, the first candidate (so the caller can say what is wrong with it).
 */
export function pickCandidate(candidates: readonly string[]): string | null {
  const wellFormed = new Set(candidates.filter((c) => TOKEN_SHAPE.test(c)));
  if (wellFormed.size > 1) return null;
  const [only] = wellFormed;
  return only ?? candidates[0] ?? null;
}

/**
 * Finds tokens in screen rows (each row the full terminal width, xterm-wrapped rows already
 * joined). A token continues on the next row when its segment ends the row (touching the right
 * edge, or a box frame) or the next row starts at the same column, and the next row holds only
 * token characters. See `pickCandidate` for the result.
 */
export function findTokenInRows(rows: readonly string[]): string | null {
  const candidates: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? '';
    for (const m of row.matchAll(TOKEN_START)) {
      const startCol = m.index;
      let token = m[0];
      let cur = i;
      let after = row.slice(startCol + token.length);
      while (ONLY_TRAILER.test(after)) {
        const next = CONTINUATION.exec(rows[cur + 1] ?? '');
        if (!next) break;
        const lead = next[1] ?? '';
        if (!AT_EDGE.test(after) && lead.length !== startCol) break;
        token += next[2] ?? '';
        after = next[3] ?? '';
        cur++;
      }
      candidates.push(token);
    }
  }
  return pickCandidate(candidates);
}

/**
 * Replays raw terminal output into a headless terminal of `cols` x `rows` (applying `resizes`)
 * and returns the screen rows, scrollback included, with xterm's soft-wrapped rows joined.
 */
export async function renderTerminal(
  output: string,
  cols: number,
  rows: number,
  resizes: readonly ResizeEvent[] = [],
): Promise<string[]> {
  const term = new Terminal({
    cols,
    rows,
    scrollback: 5_000,
    allowProposedApi: true,
    convertEol: true,
  });
  try {
    const write = (data: string) =>
      new Promise<void>((resolve) => (data === '' ? resolve() : term.write(data, resolve)));
    let pos = 0;
    for (const r of [...resizes].sort((a, b) => a.at - b.at)) {
      await write(output.slice(pos, r.at));
      pos = Math.max(pos, r.at);
      term.resize(r.cols, r.rows);
    }
    await write(output.slice(pos));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(false);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  } finally {
    term.dispose();
  }
}

/** Finds the token in raw pty output by emulating a `cols` x `rows` terminal. */
export async function extractTokenFromTerminal(
  output: string,
  cols: number,
  rows: number,
  resizes: readonly ResizeEvent[] = [],
): Promise<string | null> {
  return findTokenInRows(await renderTerminal(output, cols, rows, resizes));
}

export const ANSI =
  // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/**
 * Plain-text fallback: finds a token in output without cursor movement (ANSI codes, CRLF, box
 * frames and a token wrapped over several lines are handled). Returns null when none is found.
 */
export function extractToken(output: string): string | null {
  const rows = output
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  // Without a known width, every row ending with the token counts as reaching the edge.
  const candidates: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? '';
    for (const m of row.matchAll(TOKEN_START)) {
      let token = m[0];
      let after = row.slice(m.index + token.length);
      let cur = i;
      while (ONLY_TRAILER.test(after)) {
        const next = CONTINUATION.exec(rows[cur + 1] ?? '');
        if (!next) break;
        token += next[2] ?? '';
        after = next[3] ?? '';
        cur++;
      }
      candidates.push(token);
    }
  }
  return pickCandidate(candidates);
}
