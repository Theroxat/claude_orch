import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fired on `window` when the server answers 429; the toast host shows a friendly notice. */
export const RATE_LIMITED_EVENT = 'orch:rate-limited';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Typed fetch wrapper: cookie session, JSON body, response parsed with a zod schema. */
export async function api<T>(
  method: Method,
  path: string,
  opts: { body?: unknown; schema?: ZodType<T, unknown> } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : undefined;
  if (!res.ok) {
    if (res.status === 429 && typeof window !== 'undefined') {
      const secs = Number(res.headers.get('Retry-After'));
      window.dispatchEvent(
        new CustomEvent(RATE_LIMITED_EVENT, {
          detail: { retryAfterSec: Number.isFinite(secs) && secs > 0 ? secs : undefined },
        }),
      );
    }
    const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'http_error',
      e?.message ?? `Request failed (${res.status})`,
    );
  }
  return opts.schema ? opts.schema.parse(json) : (json as T);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
