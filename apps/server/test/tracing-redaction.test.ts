import { describe, expect, it } from 'vitest';
import {
  REDACTED_QUERY_PARAMS,
  isProbePath,
  safeIncomingUrlAttributes,
} from '../src/observability/tracing';

describe('tracing redaction', () => {
  it('masks invite tokens and drops the query string from span URLs', () => {
    expect(safeIncomingUrlAttributes({ url: '/invite/s3cret?code=abc' })).toEqual({
      'http.target': '/invite/[redacted]',
      'url.path': '/invite/[redacted]',
      'url.query': '',
    });
    expect(
      safeIncomingUrlAttributes({ url: '/api/auth/callback?code=abc&state=x' })['http.target'],
    ).toBe('/api/auth/callback');
  });

  it('redacts OAuth query parameters and keeps the SDK defaults', () => {
    expect(REDACTED_QUERY_PARAMS).toEqual(
      expect.arrayContaining(['code', 'state', 'sig', 'token']),
    );
  });

  it('never traces probes, whatever the case or trailing slash', () => {
    expect(isProbePath('/METRICS/?x=1')).toBe(true);
    expect(isProbePath('/readyz')).toBe(true);
    expect(isProbePath('/api/tasks')).toBe(false);
  });
});
