import { useQuery } from '@tanstack/react-query';
import { normalizeVersion } from '@orch/shared';
import { z } from 'zod';
import { api } from '../api/client';

const RELEASES = 'https://github.com/Theroxat/claude_orch/releases/tag';

/** Server version from /api/healthz (`dev` for local builds). */
export const fetchServerVersion = () =>
  api('GET', '/healthz', { schema: z.object({ version: z.string() }) });

/** Discreet footer: "orch v0.4.3", linking to the GitHub release (plain text for `dev`). */
export function VersionFooter() {
  const version = useQuery({
    queryKey: ['server-version'],
    queryFn: fetchServerVersion,
    staleTime: Infinity,
  }).data?.version;
  if (!version) return null;
  const release = normalizeVersion(version);
  return (
    <footer className="version-footer">
      {release ? (
        <a href={`${RELEASES}/v${release}`} target="_blank" rel="noreferrer">
          orch v{release}
        </a>
      ) : (
        <span>orch {version}</span>
      )}
    </footer>
  );
}
