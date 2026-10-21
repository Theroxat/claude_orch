/** `orch` command dispatcher (testable: no process.exit, injectable IO, env and spawner). */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type { ClaudeAuthPayload } from '@orch/shared';
import {
  checkClaudeAuth,
  checkLine,
  readTokenFile,
  resolveExecutable,
  type ClaudeCheckOutcome,
} from '../claude-check';
import { loadCliConfig, type CliConfig } from '../config';
import { CliDocker } from '../exec/docker';
import { parseIssueRef } from '../exec/naming';
import { spawnRunner, type CommandRunner } from '../exec/runner';
import { errorMessage } from '../log';
import { DaemonNotRunningError, sendControl } from './client';
import { checkTokenShape, login, type LoginIo } from './login';
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
  update            Update this agent to the version the server runs, then restart it
                      --when-idle      wait for the running tasks to finish first
                      --version=<x.y.z> a specific release instead
  login             Store your Claude token (wraps \`claude setup-token\`), then verify it
                      --token-stdin  read the token from stdin
                      --no-setup     do not run \`claude setup-token\` first
  doctor            Check the Claude setup: binary, token, and a real Claude request
  help              Show this help
`;

export interface CliDeps {
  /** Runs an interactive command with inherited stdio, resolves with its exit code. */
  spawnInteractive: (argv: string[]) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  /** How long `take` waits for the sandbox to be ready. */
  takeWaitMs: number;
  /** How long `update` follows the pull before returning. */
  updateWaitMs: number;
  /** Runs `claude --version` (doctor). */
  runner: CommandRunner;
  /** In-process Claude check, used when the daemon socket is unreachable (not reported). */
  localCheck: (cfg: CliConfig) => Promise<ClaudeCheckOutcome>;
}

function localUidGid(cfg: CliConfig): { uid: number; gid: number } {
  let uid = cfg.taskUid;
  let gid = cfg.taskGid;
  try {
    if (cfg.workDir) {
      const st = statSync(cfg.workDir);
      uid ??= st.uid > 0 ? st.uid : 1000;
      gid ??= st.uid > 0 ? st.gid : 1000;
    }
  } catch {
    // defaults below
  }
  return { uid: uid ?? 1000, gid: gid ?? 1000 };
}

/**
 * In-process check (no daemon). The binary is copied into the check container at the same path,
 * so a bare name (ORCH_CLAUDE_BIN defaults to `claude`) is first resolved to an absolute path.
 */
export async function defaultLocalCheck(
  cfg: CliConfig,
  pathEnv: string = process.env.PATH ?? '',
): Promise<ClaudeCheckOutcome> {
  const claudeBin = resolveExecutable(cfg.claudeBin, pathEnv);
  if (!claudeBin) {
    return {
      payload: {
        valid: false,
        checkedAt: new Date().toISOString(),
        errorClass: 'error',
        detail:
          `Claude Code CLI not found (${cfg.claudeBin} is not an executable file nor on PATH). Set ORCH_CLAUDE_BIN to its absolute path.`.slice(
            0,
            300,
          ),
      },
      tokenHash: null,
    };
  }
  return checkClaudeAuth(
    {
      agentId: cfg.agentId ?? 'cli',
      image: cfg.defaultImage,
      claudeBin,
      ...localUidGid(cfg),
    },
    {
      docker: new CliDocker(spawnRunner),
      runner: spawnRunner,
      readClaudeToken: () => readTokenFile(cfg.secretsDir),
    },
  );
}

/** Daemon commands an older or limited daemon may not know: fall back to the local check. */
const FALLBACK_CODES = new Set(['unknown_command', 'unsupported']);

/**
 * Runs the real Claude check through the daemon (which records it and reports `claude.auth`),
 * or in this process when the daemon is unreachable (nothing recorded or sent).
 */
async function runClaudeCheck(
  cfg: CliConfig,
  d: CliDeps,
  reason: string,
): Promise<{ payload: ClaudeAuthPayload; via: 'daemon' | 'local' }> {
  let res: Awaited<ReturnType<typeof sendControl>> | null = null;
  try {
    res = await sendControl(cfg.socketPath, { cmd: 'claude.check', reason }, 150_000);
  } catch (e) {
    if (!(e instanceof DaemonNotRunningError)) throw e;
  }
  if (res?.ok && res.claudeAuth) return { payload: res.claudeAuth, via: 'daemon' };
  if (res?.ok) throw new Error('The daemon returned no check result.');
  if (res && !FALLBACK_CODES.has(res.error.code)) throw new Error(res.error.message);
  return { payload: (await d.localCheck(cfg)).payload, via: 'local' };
}

/** `orch doctor` report lines (never the token). Exit code 0 only when valid. */
export async function doctor(
  cfg: CliConfig,
  d: CliDeps,
  out: (s: string) => void,
): Promise<number> {
  let version: string;
  try {
    const r = await d.runner.run(cfg.claudeBin, ['--version'], { timeoutMs: 15_000 });
    version = r.code === 0 ? r.stdout.trim().split('\n')[0] || 'ok' : `failed (exit ${r.code})`;
  } catch (e) {
    version = `not runnable (${errorMessage(e)})`;
  }
  out(`Claude binary:  ${cfg.claudeBin} (${version})`);
  const token = readTokenFile(cfg.secretsDir);
  out(`Token:          ${token ? 'present' : 'missing'}`);
  if (token) {
    const shape = checkTokenShape(token);
    out(
      `Token shape:    ${shape.ok ? 'ok' : `unexpected: ${shape.reason}`} (${token.length} chars, ${token.startsWith('sk-ant-oat') ? 'sk-ant-oat prefix' : 'unknown prefix'})`,
    );
  }
  const { payload, via } = await runClaudeCheck(cfg, d, 'doctor');
  if (via === 'local') {
    out('Check:          ran here (the daemon is not reachable; not reported to the server)');
  }
  out(checkLine(payload));
  return payload.valid ? 0 : 1;
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
  updateWaitMs: 30 * 60_000,
  runner: spawnRunner,
  localCheck: defaultLocalCheck,
};

export function formatStatus(s: StatusInfo): string {
  return [
    `Agent:        ${s.agentId ?? 'unknown'} (v${s.version})`,
    `Server:       ${s.serverUrl}`,
    `Connection:   ${s.connected ? 'connected' : 'disconnected'}`,
    `Paused:       ${s.paused ? 'yes' : 'no'}`,
    `Last usage:   ${s.lastUsageReportAt ?? 'never'}`,
    `Outbox:       ${s.outboxPending} pending`,
    ...(s.latestAgentVersion && s.latestAgentVersion !== s.version
      ? [`Latest:       v${s.latestAgentVersion} (run "orch update")`]
      : []),
    ...(s.claudeAuthValid === false ? ['Claude:       login expired: run `orch login`'] : []),
    ...(s.update
      ? [
          `Update:       ${s.update.status} v${s.update.targetVersion}${s.update.detail ? ` (${s.update.detail})` : ''}`,
        ]
      : []),
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
      case 'update': {
        const known = ['--when-idle'];
        const bad = args.find((a) => !known.includes(a) && !a.startsWith('--version='));
        if (bad) {
          err(`unknown option ${bad}. Usage: orch update [--when-idle] [--version=<x.y.z>]`);
          return 2;
        }
        const v = args.find((a) => a.startsWith('--version='))?.slice('--version='.length);
        const res = await call({
          cmd,
          whenIdle: args.includes('--when-idle'),
          ...(v ? { version: v } : {}),
        });
        if (!res) return 1;
        out(res.message ?? 'Update requested.');
        if (!res.update || res.update.status === 'deferred') return 0;
        return await followUpdate(res.update.updateId, call, d, out, err);
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
        // Storing a token proves nothing: verify it with a real Claude request.
        out('Verifying the token with Claude...');
        let check: ClaudeAuthPayload;
        try {
          check = (await runClaudeCheck(cfg, d, 'login')).payload;
        } catch (e) {
          out(`? Could not verify the Claude login (error): ${errorMessage(e)}`);
          return 0;
        }
        out(checkLine(check));
        return !check.valid && check.errorClass === 'unauthorized' ? 1 : 0;
      }
      case 'doctor':
        return await doctor(cfg, d, out);
      default:
        err(`unknown command "${cmd}". Run "orch help".`);
        return 2;
    }
  } catch (e) {
    err(errorMessage(e));
    return 1;
  }
}

/** Follows the update until it is handed to the restart helper (or fails). */
async function followUpdate(
  updateId: string,
  call: (req: ControlRequest, timeoutMs?: number) => Promise<ControlResult | null>,
  d: CliDeps,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const end = Date.now() + d.updateWaitMs;
  let last = '';
  while (Date.now() < end) {
    const u = (await call({ cmd: 'status' }))?.status?.update;
    if (!u || u.updateId !== updateId) {
      err('lost track of the update; check "orch status"');
      return 1;
    }
    if (u.status !== last) {
      last = u.status;
      if (u.status === 'pulling') out('Pulling the new image...');
    }
    if (u.status === 'restarting' || u.status === 'done') {
      out(
        `${u.detail ?? 'Restarting.'}\nThe agent restarts in a few seconds; check with "orch status".`,
      );
      return 0;
    }
    if (u.status === 'failed') {
      err(`update failed: ${u.detail ?? u.code ?? 'unknown error'}`);
      return 1;
    }
    await d.sleep(1_000);
  }
  out('Still updating. Check "orch status" later.');
  return 0;
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
