/**
 * WebSocket connection to the server (PLAN 4.2, 4.5): Bearer auth, `hello` on open, reconnect
 * with full-jitter backoff (reset after `welcome`), every inbound frame validated with
 * `parseServerMessage`. Delivery semantics (acks, outbox, dedupe) live in the Agent.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  CloseCode,
  FATAL_CLOSE_CODES,
  agentMessage,
  parseServerMessage,
  type AgentMessage,
  type HelloPayload,
  type ServerMessage,
  type WelcomePayload,
} from '@orch/shared';
import { errorMessage, type Logger } from '../log';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff';

export type ClientState =
  'idle' | 'connecting' | 'open' | 'ready' | 'waiting' | 'stopped' | 'fatal';

export interface WsClientEvents {
  state: [ClientState];
  /** `welcome` received: the session is usable. */
  welcome: [WelcomePayload];
  /** Every validated server message except `welcome`. */
  message: [ServerMessage];
  disconnected: [{ code: number; reason: string }];
  reconnect: [{ attempt: number; delayMs: number }];
  fatal: [{ code: number; reason: string }];
}

export interface WsClientOptions {
  url: string;
  credential: string;
  hello: () => HelloPayload;
  logger: Logger;
  backoff?: Partial<BackoffOptions>;
  /** Close and retry when no `welcome` arrives in time. */
  welcomeTimeoutMs?: number;
  /**
   * Minimum wait before retrying after the owner's access was suspended (close 4403 or HTTP 403
   * on upgrade). Default 60 s; the usual jittered backoff is added on top.
   */
  suspendedRetryMs?: number;
}

const FATAL_HINTS: Record<number, string> = {
  4003: 'This agent was revoked on the server. Generate a new install command on My server and re-run install.sh.',
  4010: 'Protocol version mismatch with the server. Update the agent: docker compose pull && docker compose up -d.',
  4401: 'The server rejected the agent credential. Re-enroll with a new install command.',
};

export class WsClient extends EventEmitter<WsClientEvents> {
  private ws: WebSocket | undefined;
  private state: ClientState = 'idle';
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private welcomeTimer: NodeJS.Timeout | undefined;
  private readonly backoff: BackoffOptions;

  constructor(private readonly opts: WsClientOptions) {
    super();
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
  }

  get currentState(): ClientState {
    return this.state;
  }

  /** True once `welcome` was received on the current socket. */
  get ready(): boolean {
    return this.state === 'ready';
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  /** Sends a message on the current socket. Returns false when not connected. */
  send(msg: AgentMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Best-effort send (live output): refused when not ready or when more than `maxBuffered`
   * bytes are still queued on the socket, so a slow link never piles up memory or delays
   * the acked messages behind it.
   */
  sendBestEffort(msg: AgentMessage, maxBuffered = 256 * 1024): boolean {
    const ws = this.ws;
    if (this.state !== 'ready' || !ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > maxBuffered) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.setState('stopped');
    clearTimeout(this.timer);
    clearTimeout(this.welcomeTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => ws.terminate(), 1_000);
      ws.once('close', () => {
        clearTimeout(kill);
        resolve();
      });
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(1000, 'agent stopping');
    });
  }

  private setState(s: ClientState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private connect(): void {
    this.setState('connecting');
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.opts.credential}` },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    let httpStatus: number | undefined;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.setState('open');
      ws.send(JSON.stringify(agentMessage('hello', this.opts.hello())));
      this.welcomeTimer = setTimeout(() => {
        this.opts.logger.warn('no welcome from server, reconnecting');
        ws.terminate();
      }, this.opts.welcomeTimeoutMs ?? 15_000);
    });
    ws.on('message', (data: WebSocket.RawData) => {
      if (this.ws === ws) this.onFrame(data.toString());
    });
    ws.on('error', (err) => {
      const m = /Unexpected server response: (\d+)/.exec(err.message);
      if (m) httpStatus = Number(m[1]);
      this.opts.logger.warn('connection error', { error: errorMessage(err) });
    });
    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearTimeout(this.welcomeTimer);
      const reason = reasonBuf.toString();
      this.emit('disconnected', { code, reason });
      if (this.state === 'stopped') return;
      if (FATAL_CLOSE_CODES.includes(code) || httpStatus === 401) {
        const effective = httpStatus === 401 ? 4401 : code;
        this.setState('fatal');
        this.opts.logger.error(
          `connection closed permanently (${effective}${reason ? `: ${reason}` : ''}). ${FATAL_HINTS[effective] ?? ''}`.trim(),
        );
        this.emit('fatal', { code: effective, reason });
        return;
      }
      if (code === CloseCode.ACCESS_SUSPENDED || httpStatus === 403) {
        // Not fatal: the credential is still valid. Retry slowly until an admin approves again.
        this.opts.logger.warn(
          'access to the server was removed by an admin; retrying until it is approved again',
        );
        this.scheduleReconnect(
          CloseCode.ACCESS_SUSPENDED,
          reason,
          this.opts.suspendedRetryMs ?? 60_000,
        );
        return;
      }
      this.scheduleReconnect(code, reason);
    });
  }

  private scheduleReconnect(code: number, reason: string, minDelayMs = 0): void {
    const attempt = this.attempt++;
    const delayMs = minDelayMs + backoffDelay(attempt, this.backoff);
    this.setState('waiting');
    this.opts.logger.info('disconnected, reconnecting', { code, reason, attempt, delayMs });
    this.emit('reconnect', { attempt, delayMs });
    this.timer = setTimeout(() => {
      if (this.state === 'waiting') this.connect();
    }, delayMs);
  }

  private onFrame(raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.opts.logger.warn('ignoring invalid server frame', {
        code: parsed.code,
        id: parsed.id,
        error: parsed.error.slice(0, 300),
      });
      return;
    }
    const msg = parsed.message;
    if (msg.type === 'welcome') {
      clearTimeout(this.welcomeTimer);
      this.attempt = 0;
      this.setState('ready');
      this.emit('welcome', msg.payload);
      return;
    }
    this.emit('message', msg);
  }
}
