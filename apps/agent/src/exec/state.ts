/**
 * Task records persisted in the data volume (`/data/tasks.json`) so the agent can resume, report
 * `running[]` in `hello` and garbage-collect after a restart. No secret is ever stored here.
 */
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../fsutil';

export const LocalTaskState = z.enum([
  'preparing',
  'building',
  'running',
  'pushing',
  'finished',
  'failed',
  'cancelled',
]);
export type LocalTaskState = z.infer<typeof LocalTaskState>;

/** States that hold a slot (count toward maxConcurrent). */
export const ACTIVE_STATES: readonly LocalTaskState[] = [
  'preparing',
  'building',
  'running',
  'pushing',
];

export const TaskRecordSchema = z.object({
  assignmentId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  projectFullName: z.string(),
  issueNumber: z.number().int().positive(),
  title: z.string(),
  model: z.string(),
  size: z.enum(['S', 'M', 'L']),
  baseBranch: z.string(),
  branch: z.string(),
  state: LocalTaskState,
  /** Last seq used for task.* messages of this assignment. */
  seq: z.number().int().nonnegative(),
  taskDir: z.string(),
  cloneDir: z.string(),
  /** Agent-private git dir of the clone (never mounted). Null for records of older agents. */
  gitDir: z.string().nullable().default(null),
  container: z.string(),
  network: z.string(),
  image: z.string().nullable(),
  /** Image built for this task (removed on cleanup), null when a stock image is used. */
  builtImage: z.string().nullable(),
  composeProject: z.string().nullable(),
  screen: z.string(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  cleanupRequested: z.boolean(),
  /** M4: AUTO = headless `claude -p`, MANUAL = screen session. */
  execMode: z.enum(['AUTO', 'MANUAL']).default('MANUAL'),
  /** Id of our `offer.accept` while it waits for the server's ack (nothing runs before). */
  pendingAcceptId: z.string().nullable().default(null),
  workspaceFolder: z.string().default('/workspace'),
  /** Hard limit of an auto run, in seconds. */
  timeoutSec: z.number().int().positive().nullable().default(null),
  /** When `claude -p` started (auto mode). */
  runStartedAt: z.string().nullable().default(null),
  /** Auto run log (`/data/logs/<assignmentId>.log`). */
  logFile: z.string().nullable().default(null),
  /** Starting prompt built from the offer (issue snapshot, not secret); cleared once used. */
  prompt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

// Cast: the new fields have defaults (older state files), so input and output types differ.
const FileSchema = z.object({ tasks: z.array(TaskRecordSchema) }) as unknown as z.ZodType<{
  tasks: TaskRecord[];
}>;

export class TaskStore {
  private tasks: TaskRecord[];

  constructor(private readonly file: string) {
    this.tasks = readJsonFile(file, FileSchema, () => ({ tasks: [] })).tasks;
  }

  all(): readonly TaskRecord[] {
    return this.tasks;
  }

  get(assignmentId: string): TaskRecord | undefined {
    return this.tasks.find((t) => t.assignmentId === assignmentId);
  }

  active(): TaskRecord[] {
    return this.tasks.filter((t) => ACTIVE_STATES.includes(t.state));
  }

  /** Most recent record for an issue number (optionally of one project), active ones first. */
  byIssue(issueNumber: number, project?: string): TaskRecord | undefined {
    const p = project?.toLowerCase();
    const matches = this.tasks.filter(
      (t) =>
        t.issueNumber === issueNumber && (p === undefined || t.projectFullName.toLowerCase() === p),
    );
    return (
      matches.find((t) => ACTIVE_STATES.includes(t.state)) ??
      matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    );
  }

  put(rec: TaskRecord): void {
    rec.updatedAt = new Date().toISOString();
    const i = this.tasks.findIndex((t) => t.assignmentId === rec.assignmentId);
    if (i >= 0) this.tasks[i] = rec;
    else this.tasks.push(rec);
    this.persist();
  }

  update(assignmentId: string, patch: Partial<TaskRecord>): TaskRecord {
    const rec = this.get(assignmentId);
    if (!rec) throw new Error(`Unknown task ${assignmentId}`);
    Object.assign(rec, patch);
    this.put(rec);
    return rec;
  }

  delete(assignmentId: string): void {
    this.tasks = this.tasks.filter((t) => t.assignmentId !== assignmentId);
    this.persist();
  }

  private persist(): void {
    writeJsonAtomic(this.file, { tasks: this.tasks });
  }
}
