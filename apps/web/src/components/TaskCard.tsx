import { useQuery } from '@tanstack/react-query';
import type { BlockReason, TaskView } from '@orch/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchWhyNotRunning } from '../api/endpoints';
import { relative } from '../time';
import { TaskLogsButton, hasLogs } from './TaskLogs';

export function unmetDeps(task: TaskView) {
  return task.dependsOn.filter((d) => d.status !== 'DONE');
}

function Reason({ r }: { r: BlockReason }) {
  return (
    <>
      {r.message}
      {r.until ? ` (${relative(r.until)})` : ''}
    </>
  );
}

function WhyNotRunning({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['why-not-running', taskId],
    queryFn: () => fetchWhyNotRunning(taskId),
    enabled: open,
  });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Why isn&apos;t this running?</summary>
      {open && q.isPending && <p className="hint">Loading...</p>}
      {open && q.error && <p className="error">{q.error.message}</p>}
      {q.data && (
        <>
          {q.data.taskReasons.length > 0 && (
            <ul className="plain">
              {q.data.taskReasons.map((r, i) => (
                <li key={i}>
                  <Reason r={r} />
                </li>
              ))}
            </ul>
          )}
          {q.data.members.length === 0 && <p className="hint">No active participant.</p>}
          <ul className="plain">
            {q.data.members.map((m) => (
              <li key={m.user.id}>
                @{m.user.githubLogin}:{' '}
                {m.eligible
                  ? 'eligible'
                  : m.reasons.map((r, i) => (
                      <span key={i}>
                        {i > 0 && '; '}
                        <Reason r={r} />
                      </span>
                    ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

export function TaskCard({
  task,
  canApprove,
  approving,
  onApprove,
  retrying = false,
  onRetry,
  highlighted = false,
}: {
  task: TaskView;
  canApprove: boolean;
  approving: boolean;
  onApprove: (id: string) => void;
  retrying?: boolean;
  onRetry?: (id: string) => void;
  /** Targeted by `/backlog?task=<id>`: scrolled into view, focused and outlined. */
  highlighted?: boolean;
}) {
  const unmet = unmetDeps(task);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!highlighted) return;
    ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    ref.current?.focus({ preventScroll: true });
  }, [highlighted]);
  return (
    <article
      ref={ref}
      className="task-card"
      aria-label={`Task #${task.issueNumber}`}
      data-highlighted={highlighted || undefined}
      tabIndex={highlighted ? -1 : undefined}
    >
      <div className="row between">
        <a className="issue" href={task.issueUrl} target="_blank" rel="noreferrer">
          #{task.issueNumber}
        </a>
        <span className="row">
          <span className="tag" title="Size">
            {task.size}
          </span>
          <span className="tag" title="Model">
            {task.model.toLowerCase()}
          </span>
        </span>
      </div>
      <p className="task-title">{task.title}</p>
      <p className="hint">{task.projectFullName}</p>
      <div className="row">
        {task.createdBy.avatarUrl ? (
          <img
            className="avatar small"
            src={task.createdBy.avatarUrl}
            alt={`Created by ${task.createdBy.githubLogin}`}
          />
        ) : (
          <span
            className="avatar small"
            data-initial={task.createdBy.githubLogin.slice(0, 1)}
            role="img"
            aria-label={`Created by ${task.createdBy.githubLogin}`}
          />
        )}
        {task.assignee && <span className="hint">assigned to {task.assignee.githubLogin}</span>}
        {task.assigneeMachineName && <span className="hint">on {task.assigneeMachineName}</span>}
      </div>
      {task.prUrl && (
        <a href={task.prUrl} target="_blank" rel="noreferrer">
          PR #{task.prNumber}
        </a>
      )}
      {unmet.length > 0 && (
        <span className="badge stop">
          blocked by {unmet.map((d) => `#${d.issueNumber}`).join(', ')}
        </span>
      )}
      {(task.failedAttempts ?? 0) > 0 && (
        <p
          className="hint task-error"
          title={`Failed ${task.failedAttempts} times: last error: ${task.lastError ?? 'unknown'}`}
        >
          Failed {task.failedAttempts} times: last error: {task.lastError ?? 'unknown'}
        </p>
      )}
      {task.needsAttention && (
        <p className="warning" role="alert">
          Needs attention{task.needsAttentionReason ? `: ${task.needsAttentionReason}` : ''}
        </p>
      )}
      {hasLogs(task) && <TaskLogsButton task={task} />}
      {task.canRetry && onRetry && (
        <button
          disabled={retrying}
          aria-label={`Retry #${task.issueNumber}`}
          onClick={() => onRetry(task.id)}
        >
          Retry
        </button>
      )}
      {(task.status === 'TODO' || task.status === 'BLOCKED') && <WhyNotRunning taskId={task.id} />}
      {task.status === 'TODO' && (
        <p className="hint task-take">
          Take it: <code>orch take {task.issueNumber}</code>
        </p>
      )}
      {task.status === 'PROPOSED' && canApprove && (
        <button
          className="primary"
          disabled={approving}
          aria-label={`Approve #${task.issueNumber}`}
          onClick={() => onApprove(task.id)}
        >
          Approve
        </button>
      )}
    </article>
  );
}
