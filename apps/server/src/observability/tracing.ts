/** Paths whose segments are secrets (invite tokens) are masked in span URLs. */
const SECRET_PATH = /^(\/invite\/)[^/]+/;
/** Query keys masked on spans (OAuth codes and PKCE values, tokens). Replaces the SDK defaults. */
export const REDACTED_QUERY_PARAMS = [
  // SDK defaults
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
  // orch: GitHub / MCP OAuth flows and bearer-like values
  'code',
  'state',
  'code_challenge',
  'code_verifier',
  'token',
  'access_token',
  'refresh_token',
  'client_secret',
];

/** Span attributes for an incoming request with secrets stripped: no query string, masked path. */
export function safeIncomingUrlAttributes(req: { url?: string }): Record<string, string> {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const safe = path.replace(SECRET_PATH, '$1[redacted]');
  return { 'http.target': safe, 'url.path': safe, 'url.query': '' };
}

/** Health and metrics probes are never traced (any case, trailing slash). */
export function isProbePath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0]?.toLowerCase().replace(/\/+$/, '') ?? '';
  return ['/healthz', '/readyz', '/metrics', '/api/healthz', '/api/readyz'].includes(path);
}

/**
 * OpenTelemetry tracing, off by default. `startTracing` is the only entry point and loads the SDK
 * with dynamic imports, so a server without OTEL_EXPORTER_OTLP_ENDPOINT never even loads it
 * (zero overhead). It must run before the application modules are imported (main.ts does), so the
 * http and pg instrumentations can patch their modules.
 *
 * Exporter, sampler, service name... are read by the SDK from the standard OTEL_* variables.
 */
export async function startTracing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<(() => Promise<void>) | undefined> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  const [{ NodeSDK }, { getNodeAutoInstrumentations }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
  ]);
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME ?? 'orch-server',
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise: orch needs http, fastify and pg only.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => isProbePath(req.url),
          startIncomingSpanHook: (req) => safeIncomingUrlAttributes(req),
          redactedQueryParams: REDACTED_QUERY_PARAMS,
          redactedQueryParamsServer: REDACTED_QUERY_PARAMS,
        },
      }),
    ],
  });
  sdk.start();
  console.log(`tracing enabled -> ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  return () => sdk.shutdown();
}
