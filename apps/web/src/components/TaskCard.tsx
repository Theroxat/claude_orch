import { useQuery } from '@tanstack/react-query';
import type { BlockReason, TaskView } from '@orch/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchWhyNotRunning } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT } from '../i18n/index.ts';
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['why-not-running', taskId],
    queryFn: () => fetchWhyNotRunning(taskId),
    enabled: open,
  });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t('backlog.why.summary')}</summary>
      {open && q.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {open && q.error && <p className="error">{errorMessage(q.error)}</p>}
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
          {q.data.members.length === 0 && <p className="hint">{t('backlog.why.noParticipant')}</p>}
          <ul className="plain">
            {q.data.members.map((m) => (
              <li key={m.user.id}>
                @{m.user.githubLogin}:{' '}
                {m.eligible
                  ? t('backlog.why.eligible')
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
  const t = useT();
  const rich = useRich();
  const unmet = unmetDeps(task);
  const failedText = t('backlog.card.failed', {
    count: task.failedAttempts ?? 0,
    error: task.lastError ?? t('backlog.card.unknown'),
  });
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
      aria-label={t('backlog.card.label', { number: String(task.issueNumber) })}
      data-highlighted={highlighted || undefined}
      tabIndex={highlighted ? -1 : undefined}
    >
      <div className="row between">
        <a className="issue" href={task.issueUrl} target="_blank" rel="noreferrer">
          #{task.issueNumber}
        </a>
        <span className="row">
          <span className="tag" title={t('backlog.card.size')}>
            {task.size}
          </span>
          <span className="tag" title={t('backlog.card.model')}>
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
            alt={t('backlog.card.createdBy', { login: task.createdBy.githubLogin })}
          />
        ) : (
          <span
            className="avatar small"
            data-initial={task.createdBy.githubLogin.slice(0, 1)}
            role="img"
            aria-label={t('backlog.card.createdBy', { login: task.createdBy.githubLogin })}
          />
        )}
        {task.assignee && (
          <span className="hint">
            {t('backlog.card.assignedTo', { login: task.assignee.githubLogin })}
          </span>
        )}
        {task.assigneeMachineName && (
          <span className="hint">
            {t('backlog.card.onMachine', { machine: task.assigneeMachineName })}
          </span>
        )}
      </div>
      {task.prUrl && (
        <a href={task.prUrl} target="_blank" rel="noreferrer">
          {t('backlog.card.pr', { number: String(task.prNumber) })}
        </a>
      )}
      {unmet.length > 0 && (
        <span className="badge stop">
          {t('backlog.card.blockedBy', {
            list: unmet.map((d) => `#${d.issueNumber}`).join(', '),
          })}
        </span>
      )}
      {(task.failedAttempts ?? 0) > 0 && (
        <p className="hint task-error" title={failedText}>
          {failedText}
        </p>
      )}
      {task.needsAttention && (
        <p className="warning" role="alert">
          {task.needsAttentionReason
            ? t('backlog.card.needsAttentionReason', { reason: task.needsAttentionReason })
            : t('backlog.card.needsAttention')}
        </p>
      )}
      {hasLogs(task) && <TaskLogsButton task={task} />}
      {task.canRetry && onRetry && (
        <button
          disabled={retrying}
          aria-label={t('backlog.card.retryLabel', { number: String(task.issueNumber) })}
          onClick={() => onRetry(task.id)}
        >
          {t('backlog.card.retry')}
        </button>
      )}
      {(task.status === 'TODO' || task.status === 'BLOCKED') && <WhyNotRunning taskId={task.id} />}
      {task.status === 'TODO' && (
        <p className="hint task-take">
          {rich(
            'backlog.card.takeIt',
            { code: (c) => <code>{c}</code> },
            { number: String(task.issueNumber) },
          )}
        </p>
      )}
      {task.status === 'PROPOSED' && canApprove && (
        <button
          className="primary"
          disabled={approving}
          aria-label={t('backlog.card.approveLabel', { number: String(task.issueNumber) })}
          onClick={() => onApprove(task.id)}
        >
          {t('backlog.card.approve')}
        </button>
      )}
    </article>
  );
}
