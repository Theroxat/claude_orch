/**
 * Injected at image build time (ORCH_VERSION build-arg, the git tag without its leading "v";
 * "dev" for local builds). Falls back to "dev" when run from sources.
 */
export const AGENT_VERSION = (process.env.ORCH_VERSION ?? '').trim().replace(/^v/, '') || 'dev';
