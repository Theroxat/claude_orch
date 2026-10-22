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
          ignoreIncomingRequestHook: (req) =>
            ['/healthz', '/readyz', '/metrics'].includes((req.url ?? '').split('?')[0] ?? ''),
        },
      }),
    ],
  });
  sdk.start();
  console.log(`tracing enabled -> ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  return () => sdk.shutdown();
}
