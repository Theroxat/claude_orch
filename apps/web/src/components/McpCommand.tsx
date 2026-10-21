import { useQuery } from '@tanstack/react-query';
import { McpSetupViewSchema } from '@orch/shared';
import { api } from '../api/client';
import { CopyButton } from './CopyButton';

export const SETUP_KEY = ['mcp-setup'];

/** The `claude mcp add` one-liner (OAuth, no token) with a copy button. */
export function McpCommand({ big }: { big?: boolean }) {
  const setup = useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => api('GET', '/mcp/setup', { schema: McpSetupViewSchema }),
  });
  const cmd = setup.data?.mcpAddCommandOAuth;
  return (
    <>
      {setup.isPending && <p className="hint">Loading...</p>}
      {setup.error && <p className="error">{setup.error.message}</p>}
      {cmd && (
        <>
          <pre className="code" data-testid="mcp-oauth-command">
            {cmd}
          </pre>
          <div className="row">
            <CopyButton text={cmd} label="Copy command" copiedLabel="Command copied" big={big} />
          </div>
        </>
      )}
    </>
  );
}
