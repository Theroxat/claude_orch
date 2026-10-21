/** `orch` command dispatcher (testable: no process.exit, injectable IO, env and spawner). */
import { spawn } from 'node:child_process';
import { loadCliConfig } from '../config';
import { parseIssueRef } from '../exec/naming';
import { errorMessage } from '../log';
import { sendControl } from './client';
import { login, type LoginIo } from './login';
import type {
  ControlRequest,
  ControlResult,
  RequestViewInfo,
  StatusInfo,
  TaskViewInfo,
} from './protocol';

const HELP = `Usage: orch <command>

Commands:
  status            Show the agent status and this machine's tasks
  list [owner/repo] List the tasks you can take now
  take <n>          Claim issue <n> and prepare its sandbox (or <owner/repo>#<n>)
                      --no-wait  return once the claim is accepted
  attach <n>        Attach to the Claude session of issue <n> (Ctrl-a d to detach)
  shell <n>         Open a shell in the task container of issue <n>
  done <n>          Commit, push the branch (the server opens the PR), stop the sandbox
  logs <n>          Follow the log of an auto-mode run of issue <n>
                      --no-follow  print the last lines and exit
                      --lines=<k>  number of lines (default 100)
  requests          List the approval requests waiting for your answer
  accept <id>       Accept an approval request (id, <n> or <owner/repo>#<n>): it runs here
  reject <id>       Decline an approval request
  pause             Pause this machine (applied locally first, works offline)
  resume            Resume this machine
  login             Store your Claude token (wraps \`claude setup-token\`)
                      --token-stdin  read the token from stdin
                      --no-setup     do not run \`claude setup-token\` first
  help              Show this help
`;

export interface CliDeps {
  /** Runs an interactive command with inherited stdio, resolves with its exit code. */
  spawnInteractive: (argv: string[]) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  /** How long `take` waits for the sandbox to be ready. */
  takeWaitMs: number;
}

const defaultDeps: CliDeps = {
  spawnInteractive: (argv) =>
    new Promise((resolve, reject) => {
      const [cmd = '', ...rest] = argv;
      const child = spawn(cmd, rest, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  takeWaitMs: 60 * 60_000,
};

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

const minutes = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
};

export function formatTask(t: TaskViewInfo): string {
  const mode = t.mode ? ` (${t.mode})` : '';
  const lines = [
    `#${t.issueNumber} ${t.title}  [${t.state}]${mode}`,
    `  ${t.project}  ${t.branch}`,
  ];
  if (t.mode === 'auto') {
    if (t.elapsedSec != null) {
      const limit = t.timeoutSec ? ` / ${minutes(t.timeoutSec)} timeout` : '';
      lines.push(`  elapsed: ${minutes(t.elapsedSec)}${limit}`);
    }
    if (t.state === 'running') lines.push(`  logs: ${t.attach}`);
  } else if (t.state === 'running') lines.push(`  attach: ${t.attach}`);
  if (t.prUrl) lines.push(`  PR: ${t.prUrl}`);
  if (t.error) lines.push(`  error: ${t.error}`);
  return lines.join('\n');
}

export function formatRequest(r: RequestViewInfo): string {
  const exp = r.expiresAt ? `  expires ${r.expiresAt}` : '';
  return `${r.assignmentId}  ${r.project}#${r.issueNumber}  [${r.size}, ${r.model.toLowerCase()}]  ${r.title}  (by ${r.createdBy})${exp}`;
}

function issueArg(args: string[]): { issue: number; project?: string } | null {
  const ref = args.find((a) => !a.startsWith('--'));
  return ref ? parseIssueRef(ref) : null;
}

export async function runCli(
  argv: string[],
  io: LoginIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<CliDeps> = {},
): Promise<number> {
  const d = { ...defaultDeps, ...deps };
  const [cmd = 'help', ...args] = argv;
  const cfg = loadCliConfig(env);
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`orch: ${s}\n`);
  const call = async (req: ControlRequest, timeoutMs?: number): Promise<ControlResult | null> => {
    const res = await sendControl(cfg.socketPath, req, timeoutMs);
    if (!res.ok) {
      err(res.error.message);
      return null;
    }
    return res;
  };

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        io.stdout.write(HELP);
        return 0;
      case 'status': {
        const res = await call({ cmd });
        if (!res?.status) return 1;
        out(formatStatus(res.status));
        const tasks = res.tasks ?? [];
        out(tasks.length ? `\nTasks:\n${tasks.map(formatTask).join('\n')}` : '\nTasks:       none');
        return 0;
      }
      case 'pause':
      case 'resume': {
        const res = await call({ cmd });
        if (!res?.status) return 1;
        const offline = res.status.connected
          ? ''
          : ' (offline: the server will be told on reconnect)';
        out(`${cmd === 'pause' ? 'Paused.' : 'Resumed.'}${offline}`);
        return 0;
      }
      case 'list': {
        const project = args.find((a) => !a.startsWith('--'));
        const res = await call({ cmd, ...(project ? { project } : {}) }, 20_000);
        if (!res) return 1;
        const list = res.available ?? [];
        if (list.length === 0) out('No task available right now.');
        for (const t of list) {
          out(
            `${t.projectFullName}#${t.issueNumber}  [${t.size}, ${t.model.toLowerCase()}]  ${t.title}  (by ${t.createdBy.login})`,
          );
        }
        return 0;
      }
      case 'take': {
        const ref = issueArg(args);
        if (!ref) {
          err('usage: orch take <n> | <owner/repo>#<n>');
          return 2;
        }
        const res = await call({ cmd, ...ref }, 90_000);
        if (!res?.task) return 1;
        out(`Claimed ${res.task.project}#${res.task.issueNumber}: ${res.task.title}`);
        out(`Branch ${res.task.branch}. Preparing the sandbox...`);
        if (args.includes('--no-wait')) {
          out(`Check progress with "orch status". Then attach with:\n  ${res.task.attach}`);
          return 0;
        }
        return await waitReady(res.task, call, d, out, err);
      }
      case 'done': {
        const ref = issueArg(args);
        if (!ref) {
          err('usage: orch done <n>');
          return 2;
        }
        const res = await call({ cmd, ...ref }, 15 * 60_000);
        if (!res?.task) return 1;
        out(
          `Issue #${res.task.issueNumber}: pushed ${res.task.branch}. The server opens the pull request.`,
        );
        out('The sandbox was removed; the clone is kept until the PR is merged.');
        return 0;
      }
      case 'attach':
      case 'shell': {
        const ref = issueArg(args);
        if (!ref) {
          err(`usage: orch ${cmd} <n>`);
          return 2;
        }
        const res = await call({ cmd, ...ref }, 30_000);
        if (!res?.exec) return 1;
        return await d.spawnInteractive(res.exec);
      }
      case 'logs': {
        const ref = issueArg(args);
        if (!ref) {
          err('usage: orch logs <n> [--no-follow] [--lines=<k>]');
          return 2;
        }
        const linesArg = args.find((a) => a.startsWith('--lines='));
        const lines = linesArg ? Number(linesArg.slice('--lines='.length)) : undefined;
        if (lines !== undefined && (!Number.isInteger(lines) || lines <= 0 || lines > 10_000)) {
          err('--lines must be an integer between 1 and 10000');
          return 2;
        }
        const res = await call({
          cmd,
          ...ref,
          follow: !args.includes('--no-follow'),
          ...(lines !== undefined ? { lines } : {}),
        });
        if (!res?.exec) return 1;
        return await d.spawnInteractive(res.exec);
      }
      case 'requests': {
        const res = await call({ cmd });
        if (!res) return 1;
        const list = res.requests ?? [];
        if (list.length === 0) out('No approval request waiting.');
        for (const r of list) out(formatRequest(r));
        if (list.length > 0) out('\nAnswer with "orch accept <id>" or "orch reject <id>".');
        return 0;
      }
      case 'accept':
      case 'reject': {
        const id = args.find((a) => !a.startsWith('--'));
        if (!id) {
          err(`usage: orch ${cmd} <id>`);
          return 2;
        }
        const res = await call({ cmd, id }, 30_000);
        if (!res) return 1;
        out(res.message ?? (cmd === 'accept' ? 'Accepted.' : 'Rejected.'));
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
        err(`unknown command "${cmd}". Run "orch help".`);
        return 2;
    }
  } catch (e) {
    err(errorMessage(e));
    return 1;
  }
}

/** Polls `status` until the claimed task is running (prints the attach command) or failed. */
async function waitReady(
  task: TaskViewInfo,
  call: (req: ControlRequest, timeoutMs?: number) => Promise<ControlResult | null>,
  d: CliDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const end = Date.now() + d.takeWaitMs;
  let last = '';
  while (Date.now() < end) {
    const res = await call({ cmd: 'status' });
    const t = res?.tasks?.find((x) => x.assignmentId === task.assignmentId);
    if (!t) {
      err('the task disappeared (cancelled or cleaned up)');
      return 1;
    }
    if (t.state !== last) {
      last = t.state;
      if (t.state === 'building') out('Building the dev environment...');
    }
    if (t.state === 'running') {
      for (const w of t.warnings) out(`warning: ${w}`);
      out(
        `Ready. Attach to the Claude session with:\n  ${t.attach}\n(or "orch attach ${t.issueNumber}"; detach with Ctrl-a d). Finish with "orch done ${t.issueNumber}".`,
      );
      return 0;
    }
    if (t.state === 'failed' || t.state === 'cancelled') {
      err(`task ${t.state}: ${t.error ?? 'unknown error'}`);
      return 1;
    }
    await d.sleep(1_000);
  }
  out('Still preparing. Check "orch status" later.');
  return 0;
}
