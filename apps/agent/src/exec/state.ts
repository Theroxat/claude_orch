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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

const FileSchema = z.object({ tasks: z.array(TaskRecordSchema) });

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

  /** Most recent record for an issue number, active ones first. */
  byIssue(issueNumber: number): TaskRecord | undefined {
    const matches = this.tasks.filter((t) => t.issueNumber === issueNumber);
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
