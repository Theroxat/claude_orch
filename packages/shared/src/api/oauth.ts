/**
 * MCP OAuth 2.1 authorization (so `claude mcp add` needs no token).
 *
 * Discovery (public, no auth; every URL is built from ORCH_PUBLIC_URL):
 *   GET /.well-known/oauth-protected-resource[/mcp]   RFC 9728 protected resource metadata
 *   GET /.well-known/oauth-authorization-server       RFC 8414 authorization server metadata
 * Protocol endpoints (used by Claude Code, not by the web app):
 *   POST /api/oauth/register    RFC 7591 dynamic client registration (public clients only)
 *   GET  /api/oauth/authorize   authorization code + PKCE S256; redirects to the consent page
 *   POST /api/oauth/token       authorization_code and refresh_token grants (form encoded)
 *   POST /api/oauth/revoke      RFC 7009 token revocation
 *
 * Web app routes (cookie session, JSON):
 *   GET    /api/oauth/consent?<authorize params>   -> OAuthConsentInfo (401 without a session)
 *   POST   /api/oauth/consent   OAuthConsentDecision -> OAuthConsentResult (redirect target)
 *   GET    /api/oauth/grants    -> OAuthGrantView[]   the caller's active grants
 *   DELETE /api/oauth/grants/:id -> 204              revokes the grant and all its tokens
 *   GET    /api/mcp/setup       -> McpSetupView       the one-line `claude mcp add` command
 */
import { z } from 'zod';

export const OAUTH_ACCESS_TOKEN_PREFIX = 'orch_oat_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'orch_ort_';
export const OAUTH_CODE_PREFIX = 'orch_oac_';
export const OAUTH_CLIENT_ID_PREFIX = 'orch_cli_';

/** Authorization request parameters, as received by /api/oauth/authorize. */
export const OAuthAuthorizeParamsSchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().max(200).optional(),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
});
export type OAuthAuthorizeParams = z.infer<typeof OAuthAuthorizeParamsSchema>;

export const OAuthConsentInfoSchema = z.object({
  clientName: z.string(),
  redirectHost: z.string(),
  /** The account that is about to grant access. */
  login: z.string(),
  resource: z.string(),
});
export type OAuthConsentInfo = z.infer<typeof OAuthConsentInfoSchema>;

export const OAuthConsentDecisionSchema = OAuthAuthorizeParamsSchema.extend({
  approve: z.boolean(),
});
export type OAuthConsentDecision = z.infer<typeof OAuthConsentDecisionSchema>;

export const OAuthConsentResultSchema = z.object({
  /** Where the browser goes next: the client's redirect_uri with `code` or `error`, and `state`. */
  redirectTo: z.string(),
});
export type OAuthConsentResult = z.infer<typeof OAuthConsentResultSchema>;

export const OAuthGrantViewSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type OAuthGrantView = z.infer<typeof OAuthGrantViewSchema>;
export const OAuthGrantListResponseSchema = z.array(OAuthGrantViewSchema);

export const McpSetupViewSchema = z.object({
  mcpUrl: z.string(),
  /** `claude mcp add --transport http --scope user orch <url>/mcp` (no header: OAuth). */
  mcpAddCommandOAuth: z.string(),
});
export type McpSetupView = z.infer<typeof McpSetupViewSchema>;

/** The one-line `claude mcp add` command for OAuth (then `/mcp` -> orch -> Authenticate). */
export function mcpAddCommandOAuth(baseUrl: string): string {
  return `claude mcp add --transport http --scope user orch ${baseUrl.replace(/\/+$/, '')}/mcp`;
}
