/**
 * M5 MCP server (PLAN section 7): Streamable HTTP at `/mcp`, stateless (one MCP server and
 * transport per HTTP request), JSON responses. Auth: `Authorization: Bearer <token>` with an OAuth
 * access token (`orch_oat_...`, see ../oauth) or a personal access token (`orch_pat_...`); 401
 * with `WWW-Authenticate: Bearer resource_metadata="..."` otherwise, which starts the OAuth flow
 * in Claude Code. The actor is the token's user.
 *
 * Every tool goes through the same service functions as the REST API (TaskService, buildPool,
 * the agent gateway's claim path), so permission and consent rules are identical. Nothing here
 * decides who may do what.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { User } from '@prisma/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ListTasksInputSchema,
  SubmitTaskInputSchema,
  RetryTaskInputSchema,
  TakeTaskInputSchema,
  TaskStatusInputSchema,
  ViewPoolInputSchema,
  type ListTasksInput,
  type SubmitTaskInput,
  type TaskStatus,
  type TaskView,
} from '@orch/shared';
import type { AgentGateway } from '../agents/gateway';
import { type AuthDeps } from '../auth';
import type { Dispatcher } from '../dispatch/dispatcher';
import { HttpError } from '../http/errors';
import { failureClassOf } from '../dispatch/failures';
import { buildPool } from '../offers';
import {
  TaskService,
  effectiveStatus,
  issueUrlFor,
  taskInclude,
  type TaskRow,
} from '../tasks/service';
import { authenticateOAuthAccessToken, bearerOf, oauthUrls } from '../oauth';
import { authenticatePat } from '../tokens';

export interface McpDeps extends AuthDeps {
  dispatcher: Dispatcher;
  gateway: AgentGateway;
}

const SERVER_VERSION = (process.env.ORCH_VERSION ?? '').trim().replace(/^v/, '') || 'dev';

const INSTRUCTIONS = `orch shares the Claude Code capacity of a team: tasks are GitHub issues that members' machines run (automatically or by hand) and turn into pull requests.
Before submitting work: read the repository, then split the work into SMALL, INDEPENDENT subtasks (one PR each, ideally S or M), each with a self-contained description and checkable acceptance criteria. Use dependsOn only where a subtask truly needs another one merged first. Use view_pool to see who has capacity, list_tasks to avoid duplicates, task_status to follow progress.`;

const attachCommand = (issueNumber: number) => `orch attach ${issueNumber}`;

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const toolError = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
});

/** Runs a tool body; service errors become MCP tool errors with the REST error code. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.code, err.message);
    throw err;
  }
}

function compactTask(v: TaskView) {
  return {
    project: v.projectFullName,
    issueNumber: v.issueNumber,
    issueUrl: v.issueUrl,
    title: v.title,
    status: v.status,
    size: v.size,
    model: v.model,
    createdBy: v.createdBy.githubLogin,
    assignee: v.assignee?.githubLogin ?? null,
    machine: v.assigneeMachineName ?? null,
    dependsOn: v.dependsOn.map((d) => ({ issueNumber: d.issueNumber, status: d.status })),
    integrationBranch: v.integrationBranch,
    prUrl: v.prUrl,
    failedAttempts: v.failedAttempts ?? 0,
    lastError: v.lastError ?? null,
    needsAttention: v.needsAttention ?? false,
    needsAttentionReason: v.needsAttentionReason ?? null,
  };
}

/** Builds the MCP server for one authenticated request. */
export function buildMcpServer(deps: McpDeps, user: User, ip?: string): McpServer {
  const svc = new TaskService(deps);
  const { prisma } = deps;

  const projectByName = async (fullName: string) => {
    const p = await prisma.project.findUnique({ where: { fullName } });
    if (!p) throw new HttpError(404, 'not_found', `Project ${fullName} not found`);
    return svc.visibleProject(p.id, user);
  };

  const server = new McpServer(
    { name: 'orch', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'view_pool',
    {
      title: 'View the pool',
      description:
        'Shows the members of your projects (or one project): online, paused, participation mode (AUTO runs tasks unattended, APPROVAL asks first), budget percent, ESTIMATED remaining margin in weighted tokens for the current 5-hour window, reset time and running tasks. Every usage figure is an estimate from local logs, not an exact quota. Use it to judge whether the team has capacity before submitting work.',
      inputSchema: ViewPoolInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const projectId = args.projectFullName
          ? (await projectByName(args.projectFullName))[0].id
          : undefined;
        const pool = await buildPool(deps, user, projectId);
        return {
          note: 'All usage figures (estimatedBudget, estimatedMargin, marginFraction, resetAt) are ESTIMATES.',
          ...pool,
        };
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'Lists the tasks (GitHub issues managed by orch) of one project, or of every project you own or participate in, optionally filtered by status. Statuses: PROPOSED (waits for a maintainer approval), TODO, BLOCKED (dependencies not merged yet), IN_PROGRESS, IN_REVIEW (PR open), DONE. Check it before submitting to avoid duplicates.',
      inputSchema: ListTasksInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args: ListTasksInput) =>
      run(async () => {
        const board = args.projectFullName
          ? await (async () => {
              const [project, access] = await projectByName(args.projectFullName!);
              return svc.listForProject(project, user, access);
            })()
          : await svc.listMine(user);
        const wanted: TaskStatus[] | null = args.status
          ? Array.isArray(args.status)
            ? args.status
            : [args.status]
          : null;
        const statuses = (
          ['PROPOSED', 'TODO', 'BLOCKED', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const
        ).filter((s) => !wanted || wanted.includes(s));
        const tasks = statuses.flatMap((s) => board[s].map(compactTask));
        return { count: tasks.length, tasks };
      }),
  );

  server.registerTool(
    'submit_task',
    {
      title: 'Submit tasks',
      description: `Creates one or more tasks (one GitHub issue each) for the team's machines to run with Claude Code.
BEFORE calling: read the relevant code and split large work into SMALL, INDEPENDENT subtasks, each one a single reviewable PR (prefer size S or M), with a self-contained description (context, files, approach: the runner does not see this conversation) and concrete acceptance criteria (tests to pass, observable behavior). Only add dependsOn when a subtask needs another merged first; independent subtasks run in parallel.
Each subtask has a local "ref" (e.g. "a", "b"); dependsOn takes refs of this request or issue numbers of existing tasks. The whole request is validated first (unknown refs, cycles, rights, pending-task limit) and created atomically: all tasks or none. With integrationBranch, every PR targets that branch (created from the default branch if missing) and the project owner merges it at the end.
If you only have read access, the tasks are created as PROPOSED and wait for a maintainer. dispatch.mode: "pool" (default, best available member), "members" (only these GitHub logins), "broadcast" (project owner only).`,
      inputSchema: SubmitTaskInputSchema.shape,
    },
    async (args: SubmitTaskInput) =>
      run(async () => {
        const [project, access] = await projectByName(args.projectFullName);
        const dispatch = args.dispatch ?? { mode: 'pool' as const };
        let memberIds: string[] | undefined;
        if (dispatch.mode === 'members') {
          const logins = [...new Set(dispatch.members ?? [])];
          if (logins.length === 0) {
            throw new HttpError(400, 'invalid_member', 'dispatch.members is required');
          }
          const users = await prisma.user.findMany({ where: { login: { in: logins } } });
          const missing = logins.filter((l) => !users.some((u) => u.login === l));
          if (missing.length > 0) {
            throw new HttpError(400, 'invalid_member', `Unknown members: ${missing.join(', ')}`);
          }
          memberIds = users.map((u) => u.id);
        }
        const res = await svc.submitBatch(
          project,
          user,
          access,
          {
            items: args.tasks.map((t) => ({
              ref: t.ref,
              title: t.title,
              description: t.description,
              acceptanceCriteria: t.acceptanceCriteria,
              size: t.size,
              model: t.model === 'opus' ? 'OPUS' : 'SONNET',
              dependsOn: t.dependsOn ?? [],
            })),
            integrationBranch: args.integrationBranch ?? null,
            dispatch: { mode: dispatch.mode, memberIds },
          },
          ip,
        );
        deps.dispatcher.kick();
        return {
          batchId: res.batchId,
          project: project.fullName,
          created: res.tasks.length,
          ...(res.status === 'PROPOSED'
            ? {
                note: 'You cannot submit directly to this project: the tasks are PROPOSED and wait for a maintainer approval.',
              }
            : {}),
          ...(args.integrationBranch
            ? { integrationBranch: args.integrationBranch, branchCreated: res.branchCreated }
            : {}),
          tasks: res.tasks.map(({ ref, row }) => ({
            ref,
            issueNumber: row.githubIssueNumber,
            issueUrl: issueUrlFor(
              deps.config.GITHUB_WEB_URL,
              project.fullName,
              row.githubIssueNumber,
            ),
            status: effectiveStatus(row),
            dependsOn: row.dependsOn.map((d) => d.dependsOn.githubIssueNumber),
          })),
        };
      }),
  );

  server.registerTool(
    'take_task',
    {
      title: 'Take a task',
      description:
        'Takes an open task yourself (manual mode): it is claimed for one of YOUR online, unpaused orch machines, which clones the repository and opens an interactive Claude Code session in a screen session. Returns the command to attach to it. Fails if none of your machines is online, if you are paused, if you do not participate in the project, or if the task is not open (taken, proposed or blocked by dependencies).',
      inputSchema: TakeTaskInputSchema.shape,
    },
    async (args) =>
      run(async () => {
        const [project] = await projectByName(args.projectFullName);
        const r = await deps.gateway.claimForUser(user.id, {
          projectFullName: project.fullName,
          issueNumber: args.issueNumber,
        });
        if (!r.ok) throw new HttpError(409, r.code, r.message);
        return {
          assignmentId: r.assignmentId,
          project: project.fullName,
          issueNumber: args.issueNumber,
          machine: r.machineName,
          attachCommand: attachCommand(args.issueNumber),
          hint: `Or run "orch attach ${args.issueNumber}" on that machine; detach with Ctrl-a d. Finish with "orch done ${args.issueNumber}".`,
        };
      }),
  );

  server.registerTool(
    'task_status',
    {
      title: 'Task status',
      description:
        'Shows one task: status, assignee and machine, PR, branches, timestamps, dependencies, attempts and the last progress line reported by the machine running it.',
      inputSchema: TaskStatusInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        const [project] = await projectByName(args.projectFullName);
        const t: TaskRow | null = await prisma.task.findUnique({
          where: {
            projectId_githubIssueNumber: {
              projectId: project.id,
              githubIssueNumber: args.issueNumber,
            },
          },
          include: taskInclude,
        });
        if (!t) {
          throw new HttpError(
            404,
            'not_found',
            `#${args.issueNumber} is not a task of this project`,
          );
        }
        const attempts = await prisma.assignment.findMany({
          where: { taskId: t.id },
          include: { user: true, agent: true },
          orderBy: { createdAt: 'asc' },
        });
        const progress = await prisma.auditLog.findFirst({
          where: { taskId: t.id, action: 'task.status' },
          orderBy: { id: 'desc' },
        });
        const pd = (progress?.data ?? {}) as { state?: string; detail?: string };
        const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
        const current = [...attempts]
          .reverse()
          .find((a) => ['ACCEPTED', 'RUNNING', 'PUSHED', 'SUCCEEDED'].includes(a.status));
        return {
          project: project.fullName,
          issueNumber: t.githubIssueNumber,
          issueUrl: issueUrlFor(deps.config.GITHUB_WEB_URL, project.fullName, t.githubIssueNumber),
          title: t.title,
          status: effectiveStatus(t),
          size: t.size,
          model: t.model,
          origin: t.origin,
          createdBy: t.createdBy.login,
          assignee: t.assignee?.login ?? null,
          machine: t.assigneeAgent?.name ?? null,
          prNumber: t.prNumber,
          prUrl: t.prUrl,
          baseBranch: t.integrationBranch ?? t.baseBranch,
          branchName: t.branchName,
          dependsOn: t.dependsOn.map((d) => ({
            issueNumber: d.dependsOn.githubIssueNumber,
            title: d.dependsOn.title,
            status: d.dependsOn.status,
          })),
          createdAt: iso(t.createdAt),
          updatedAt: iso(t.updatedAt),
          startedAt: iso(current?.startedAt),
          finishedAt: iso(current?.finishedAt),
          attempts: attempts.map((a) => ({
            kind: a.kind,
            status: a.status,
            execMode: a.execMode,
            member: a.user.login,
            machine: a.agent?.name ?? null,
            offeredAt: iso(a.offeredAt),
            startedAt: iso(a.startedAt),
            finishedAt: iso(a.finishedAt),
            reason: a.reason,
            ...(a.status === 'FAILED' ? { failureClass: failureClassOf(a) } : {}),
          })),
          needsAttention: t.needsAttention,
          needsAttentionReason: t.needsAttentionReason,
          lastProgress: progress
            ? {
                at: iso(progress.at),
                state: pd.state ?? null,
                detail: pd.detail ?? null,
              }
            : null,
        };
      }),
  );

  server.registerTool(
    'retry_task',
    {
      title: 'Retry a task',
      description:
        'Retries a task waiting in To do after failed runs (project owner or task creator only): earlier failures no longer keep members out (24 h shut-out, backoff, repeated repository-setup failures), the "needs attention" mark is cleared and the task is offered again. The history is kept. Fix the cause first (e.g. commit a missing .env.example).',
      inputSchema: RetryTaskInputSchema.shape,
    },
    async (args) =>
      run(async () => {
        const [project, access] = await projectByName(args.projectFullName);
        const row = await prisma.task.findUnique({
          where: {
            projectId_githubIssueNumber: {
              projectId: project.id,
              githubIssueNumber: args.issueNumber,
            },
          },
          include: taskInclude,
        });
        if (!row) {
          throw new HttpError(
            404,
            'not_found',
            `#${args.issueNumber} is not a task of this project`,
          );
        }
        const retried = await svc.retry(row, user, access, 'mcp', ip);
        deps.dispatcher.kick();
        return compactTask(svc.view(retried, access, user));
      }),
  );

  return server;
}

function rpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const urls = oauthUrls(deps.config);
  const authenticate = async (authorization: string | undefined, reply: FastifyReply) => {
    const raw = bearerOf(authorization);
    const unauthorized = (message: string) => {
      // RFC 9728: points Claude Code at the protected resource metadata (OAuth discovery).
      const params = [
        `resource_metadata="${urls.resourceMetadata}"`,
        ...(raw ? ['error="invalid_token"'] : []),
      ];
      reply.header('WWW-Authenticate', `Bearer ${params.join(', ')}`);
      return new HttpError(401, 'unauthorized', message);
    };
    const oauth = raw ? await authenticateOAuthAccessToken(deps.prisma, raw, urls.resource) : null;
    const user = oauth?.user ?? (await authenticatePat(deps.prisma, authorization))?.user;
    if (!user) {
      throw unauthorized(
        'Authorization required: connect with OAuth (claude mcp add, then /mcp -> Authenticate) or send a personal access token (Authorization: Bearer orch_pat_...)',
      );
    }
    // The sign-in allowlist applies to tokens too.
    const decision = await app.allowlist.check(user);
    if (decision === 'refused') {
      throw unauthorized('This account is no longer allowed on this server');
    }
    // Only reached for org-based access whose GitHub token is gone past the outage grace period
    // (admins, listed logins and approved grants never need it): sign in again to be re-checked.
    if (decision === 'reauth') throw unauthorized('Sign in with GitHub again');
    return user;
  };

  app.post('/mcp', async (req, reply) => {
    const user = await authenticate(req.headers.authorization, reply);
    const server = buildMcpServer(deps, user, req.ip);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    }
  });

  // Stateless server: no server-initiated stream and no session to delete.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (req, reply) => {
        await authenticate(req.headers.authorization, reply);
        reply.header('Allow', 'POST');
        return rpcError(reply, 405, 'Method not allowed: this MCP server is stateless (POST only)');
      },
    });
  }
}
