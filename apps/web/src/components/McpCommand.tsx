import { useQuery } from '@tanstack/react-query';
import { McpSetupViewSchema } from '@orch/shared';
import { api } from '../api/client';
import { CopyButton } from './CopyButton';
import { useT } from '../i18n/index.ts';
import { errorMessage } from '../i18n/errors.ts';

export const SETUP_KEY = ['mcp-setup'];

/** The `claude mcp add` one-liner (OAuth, no token) with a copy button. */
export function McpCommand({ big }: { big?: boolean }) {
  const t = useT();
  const setup = useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => api('GET', '/mcp/setup', { schema: McpSetupViewSchema }),
  });
  const cmd = setup.data?.mcpAddCommandOAuth;
  return (
    <>
      {setup.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {setup.error && <p className="error">{errorMessage(setup.error)}</p>}
      {cmd && (
        <>
          <pre className="code" data-testid="mcp-oauth-command">
            {cmd}
          </pre>
          <div className="row">
            <CopyButton
              text={cmd}
              label={t('claudeCode.mcp.copy')}
              copiedLabel={t('claudeCode.mcp.copied')}
              big={big}
            />
          </div>
        </>
      )}
    </>
  );
}
