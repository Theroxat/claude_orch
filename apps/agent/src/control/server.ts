/**
 * Local control socket (`/run/orch.sock`, mode 0600) used by the `orch` CLI.
 * One JSON request per line, one JSON response per line.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  ControlRequestSchema,
  type ControlCommand,
  type ControlRequest,
  type ControlResponse,
  type ControlResult,
} from '../cli/protocol';
import { errorMessage, type Logger } from '../log';

export type ControlHandlers = {
  [K in ControlCommand]?: (
    req: Extract<ControlRequest, { cmd: K }>,
  ) => ControlResult | Promise<ControlResult>;
};

export interface ControlServer {
  close(): Promise<void>;
}

const MAX_LINE = 64 * 1024;

function removeStale(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function handleLine(line: string, handlers: ControlHandlers): Promise<ControlResponse> {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: 'invalid_json', message: 'Request is not JSON' } };
  }
  const req = ControlRequestSchema.safeParse(data);
  if (!req.success) {
    const cmd = (data as { cmd?: unknown } | null)?.cmd;
    return {
      ok: false,
      error: { code: 'unknown_command', message: `Unknown command: ${String(cmd)}` },
    };
  }
  const handler = handlers[req.data.cmd] as
    ((r: ControlRequest) => ControlResult | Promise<ControlResult>) | undefined;
  if (!handler) {
    return {
      ok: false,
      error: { code: 'unsupported', message: `${req.data.cmd} is not available on this agent` },
    };
  }
  try {
    return { ok: true, ...(await handler(req.data)) };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      ok: false,
      error: { code: typeof code === 'string' ? code : 'internal', message: errorMessage(err) },
    };
  }
}

function serve(sock: Socket, handlers: ControlHandlers, log: Logger): void {
  let buf = '';
  let chain = Promise.resolve();
  sock.setEncoding('utf8');
  sock.on('error', (err) => log.debug('control client error', { error: err.message }));
  sock.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_LINE) {
      sock.destroy();
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === '') continue;
      chain = chain.then(async () => {
        const res = await handleLine(line, handlers);
        if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
      });
    }
  });
}

export async function startControlServer(
  path: string,
  handlers: ControlHandlers,
  log: Logger,
): Promise<ControlServer> {
  mkdirSync(dirname(path), { recursive: true });
  removeStale(path);
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    serve(sock, handlers, log);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  log.info('control socket listening', { path });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
