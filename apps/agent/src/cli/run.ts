/** `orch` command dispatcher (testable: no process.exit, injectable IO and env). */
import { loadCliConfig } from '../config';
import { errorMessage } from '../log';
import { sendControl } from './client';
import { login, type LoginIo } from './login';
import type { ControlRequest, StatusInfo } from './protocol';

const HELP = `Usage: orch <command>

Commands:
  status            Show the agent status (connection, pause, usage reports)
  pause             Pause this machine (applied locally first, works offline)
  resume            Resume this machine
  login             Store your Claude token (wraps \`claude setup-token\`)
                      --token-stdin  read the token from stdin
                      --no-setup     do not run \`claude setup-token\` first
  help              Show this help

Coming in M3: list, take, done, attach, shell
`;

const LATER = new Set(['list', 'take', 'done', 'attach', 'shell']);

export function formatStatus(s: StatusInfo): string {
  return [
    `Agent:        ${s.agentId ?? 'unknown'} (v${s.version})`,
    `Server:       ${s.serverUrl}`,
    `Connection:   ${s.connected ? 'connected' : 'disconnected'}`,
    `Paused:       ${s.paused ? 'yes' : 'no'}`,
    `Last usage:   ${s.lastUsageReportAt ?? 'never'}`,
    `Outbox:       ${s.outboxPending} pending`,
  ].join('\n');
}

export async function runCli(
  argv: string[],
  io: LoginIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [cmd = 'help', ...args] = argv;
  const cfg = loadCliConfig(env);
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`orch: ${s}\n`);

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        io.stdout.write(HELP);
        return 0;
      case 'status':
      case 'pause':
      case 'resume': {
        const res = await sendControl(cfg.socketPath, { cmd } as ControlRequest);
        if (!res.ok) {
          err(res.error.message);
          return 1;
        }
        if (cmd === 'status') out(formatStatus(res.status));
        else if (cmd === 'pause')
          out(
            `Paused.${res.status.connected ? '' : ' (offline: the server will be told on reconnect)'}`,
          );
        else
          out(
            `Resumed.${res.status.connected ? '' : ' (offline: the server will be told on reconnect)'}`,
          );
        return 0;
      }
      case 'login': {
        const unknown = args.filter((a) => a !== '--token-stdin' && a !== '--no-setup');
        if (unknown.length > 0) {
          err(`unknown option ${unknown[0]}`);
          return 2;
        }
        const path = await login(
          {
            secretsDir: cfg.secretsDir,
            claudeBin: cfg.claudeBin,
            tokenFromStdin: args.includes('--token-stdin'),
            skipSetup: args.includes('--no-setup'),
          },
          io,
        );
        out(`Claude token saved to ${path} (mode 0600). It never leaves this machine.`);
        return 0;
      }
      default:
        if (LATER.has(cmd)) {
          err(`${cmd}: not available yet (M3)`);
          return 1;
        }
        err(`unknown command "${cmd}". Run "orch help".`);
        return 2;
    }
  } catch (e) {
    err(errorMessage(e));
    return 1;
  }
}
