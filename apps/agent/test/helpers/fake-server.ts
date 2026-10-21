/** In-process fake orch server built on a real `ws` WebSocketServer. */
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { serverMessage, type AgentConfigPayload, type ServerMessage } from '@orch/shared';

export interface Frame {
  raw: string;
  msg: {
    id: string;
    type: string;
    seq?: number;
    replyTo?: string;
    payload: Record<string, unknown>;
  };
}

export interface FakeServerOptions {
  credential: string;
  port?: number;
  /** Auto-ack AGENT_ACKED frames. */
  autoAck?: boolean;
  config?: Partial<AgentConfigPayload>;
}

export class FakeServer {
  wss: WebSocketServer | undefined;
  readonly frames: Frame[] = [];
  readonly sockets = new Set<WebSocket>();
  connections = 0;
  rejectedAuth = 0;
  autoAck: boolean;
  config: AgentConfigPayload;
  port = 0;

  constructor(private readonly opts: FakeServerOptions) {
    this.autoAck = opts.autoAck ?? true;
    this.config = {
      heartbeatSec: 30,
      usageSec: 300,
      paused: false,
      participations: [],
      ...opts.config,
    };
    this.port = opts.port ?? 0;
  }

  async start(): Promise<this> {
    const wss = new WebSocketServer({
      port: this.port,
      host: '127.0.0.1',
      verifyClient: (info, cb) => {
        const ok = info.req.headers.authorization === `Bearer ${this.opts.credential}`;
        if (!ok) this.rejectedAuth++;
        cb(ok, 401);
      },
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    this.port = (wss.address() as AddressInfo).port;
    this.wss = wss;
    wss.on('connection', (ws, req) => {
      if (req.url !== '/agent/ws') ws.close(4009, 'bad path');
      this.connections++;
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (data) => {
        const raw = data.toString();
        const msg = JSON.parse(raw) as Frame['msg'];
        this.frames.push({ raw, msg });
        if (msg.type === 'hello') {
          ws.send(
            JSON.stringify(
              serverMessage('welcome', {
                ...this.config,
                agentId: 'agt_test',
                serverTime: new Date().toISOString(),
              }),
            ),
          );
        } else if (this.autoAck && msg.type !== 'heartbeat' && msg.type !== 'ack') {
          ws.send(JSON.stringify(serverMessage('ack', { ok: true }, { replyTo: msg.id })));
        }
      });
    });
    return this;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/agent/ws`;
  }

  send(msg: ServerMessage): void {
    for (const s of this.sockets) s.send(JSON.stringify(msg));
  }

  ofType(type: string): Frame['msg'][] {
    return this.frames.filter((f) => f.msg.type === type).map((f) => f.msg);
  }

  closeAll(code: number, reason = ''): void {
    for (const s of this.sockets) s.close(code, reason);
  }

  /** Kills the server: terminates sockets and closes the listener. */
  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return;
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}
