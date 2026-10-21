/**
 * Installation token broker (PLAN 5.5): `token.request` -> `token.grant` / `token.deny`.
 * Grants are held only in memory by the caller for one git operation, never persisted or logged.
 */
import { agentMessage, newMessageId, type AgentMessage, type ServerMessage } from '@orch/shared';

export type TokenPurpose = 'clone' | 'push';

interface Pending {
  resolve: (token: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TokenError extends Error {
  override name = 'TokenError';
}

export class TokenBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    /** Sends on the live socket; false when offline. token.request is not outboxed. */
    private readonly send: (m: AgentMessage) => boolean,
    private readonly timeoutMs = 30_000,
  ) {}

  request(assignmentId: string, purpose: TokenPurpose): Promise<string> {
    const requestId = newMessageId();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new TokenError(`No ${purpose} token from the server within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      const ok = this.send(agentMessage('token.request', { requestId, assignmentId, purpose }));
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new TokenError(`Cannot get a ${purpose} token: not connected to the server`));
      }
    });
  }

  /** Returns true when the message was a token reply. */
  handle(m: ServerMessage): boolean {
    if (m.type !== 'token.grant' && m.type !== 'token.deny') return false;
    const p = this.pending.get(m.payload.requestId);
    if (!p) return true;
    this.pending.delete(m.payload.requestId);
    clearTimeout(p.timer);
    if (m.type === 'token.grant') p.resolve(m.payload.token);
    else p.reject(new TokenError(`Token denied by the server: ${m.payload.reason}`));
    return true;
  }

  close(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TokenError('Agent stopping'));
      this.pending.delete(id);
    }
  }
}
