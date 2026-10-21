import type { TaskView } from '@orch/shared';

export function unmetDeps(task: TaskView) {
  return task.dependsOn.filter((d) => d.status !== 'DONE');
}

export function TaskCard({
  task,
  canApprove,
  approving,
  onApprove,
}: {
  task: TaskView;
  canApprove: boolean;
  approving: boolean;
  onApprove: (id: string) => void;
}) {
  const unmet = unmetDeps(task);
  return (
    <article className="task-card" aria-label={`Task #${task.issueNumber}`}>
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
