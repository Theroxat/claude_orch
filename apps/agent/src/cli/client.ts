/** Client side of the control socket, used by `orch status|pause|resume`. */
import { connect } from 'node:net';
import { ControlResponseSchema, type ControlRequest, type ControlResponse } from './protocol';

export class DaemonNotRunningError extends Error {
  override name = 'DaemonNotRunningError';
  constructor(socketPath: string) {
    super(
      `The orch agent daemon is not running (no socket at ${socketPath}). ` +
        'Start it with: docker compose -f ~/orch/compose.yaml up -d',
    );
  }
}

export function sendControl(
  socketPath: string,
  req: ControlRequest,
  timeoutMs = 5_000,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`The orch daemon did not answer within ${timeoutMs} ms.`));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let parsed: ReturnType<typeof ControlResponseSchema.safeParse>;
      try {
        parsed = ControlResponseSchema.safeParse(JSON.parse(buf.slice(0, nl)));
      } catch {
        done(() => reject(new Error('Invalid response from the orch daemon.')));
        return;
      }
      const result = parsed;
      done(() =>
        result.success
          ? resolve(result.data)
          : reject(new Error('Invalid response from the orch daemon.')),
      );
    });
    sock.on('error', (err: NodeJS.ErrnoException) => {
      const notRunning = ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(err.code ?? '');
      done(() => reject(notRunning ? new DaemonNotRunningError(socketPath) : err));
    });
    sock.on('end', () => done(() => reject(new Error('The orch daemon closed the connection.'))));
  });
}
