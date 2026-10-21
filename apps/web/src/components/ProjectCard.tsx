import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectView, UpdateProjectRequest } from '@orch/shared';
import {
  decideParticipant,
  deleteProject,
  fetchParticipants,
  updateProject,
} from '../api/endpoints';

function ParticipantsApproval({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['projects', projectId, 'participants'],
    queryFn: () => fetchParticipants(projectId),
  });
  const decide = useMutation({
    mutationFn: (v: { userId: string; decision: 'approve' | 'reject' }) =>
      decideParticipant(projectId, v.userId, v.decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', projectId, 'participants'] }),
  });
  const pending = (q.data ?? []).filter((p) => p.participation.status === 'pending');
  return (
    <div>
      <h3>Pending participants</h3>
      {q.error && <p className="error">{q.error.message}</p>}
      {decide.error && <p className="error">{decide.error.message}</p>}
      {q.isSuccess && pending.length === 0 && <p className="hint">No pending requests.</p>}
      <ul className="list">
        {pending.map((p) => (
          <li key={p.user.id}>
            <span>
              {p.user.githubLogin} ({p.participation.budgetPercent}%, {p.participation.mode})
            </span>
            <span className="row">
              <button
                className="primary"
                aria-label={`Approve ${p.user.githubLogin}`}
                onClick={() => decide.mutate({ userId: p.user.id, decision: 'approve' })}
              >
                Approve
              </button>
              <button
                className="danger"
                aria-label={`Reject ${p.user.githubLogin}`}
                onClick={() => decide.mutate({ userId: p.user.id, decision: 'reject' })}
              >
                Reject
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectCard({ project }: { project: ProjectView }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (patch: UpdateProjectRequest) => updateProject(project.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', 'mine'] }),
  });
  const remove = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', 'mine'] }),
  });
  const id = project.id;
  return (
    <article className="card" aria-label={project.fullName}>
      <div className="row between">
        <h2>
          {project.fullName} {project.isPrivate && <span className="badge">private</span>}
        </h2>
        <button
          className="danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Remove ${project.fullName} from orch?`)) remove.mutate();
          }}
        >
          Remove
        </button>
      </div>
      {update.error && <p className="error">{update.error.message}</p>}
      {remove.error && <p className="error">{remove.error.message}</p>}
      <div className="grid">
        <label className="field" htmlFor={`vis-${id}`}>
          Visibility
          <select
            id={`vis-${id}`}
            value={project.visibility}
            onChange={(e) =>
              update.mutate({ visibility: e.target.value as ProjectView['visibility'] })
            }
          >
            <option value="ALL_MEMBERS">All members</option>
            <option value="COLLABORATORS">Collaborators only</option>
            <option value="ALLOWLIST">Allowlist only</option>
          </select>
        </label>
        <label className="field" htmlFor={`part-${id}`}>
          Who can participate
          <select
            id={`part-${id}`}
            value={project.whoCanParticipate}
            onChange={(e) =>
              update.mutate({
                whoCanParticipate: e.target.value as ProjectView['whoCanParticipate'],
              })
            }
          >
            <option value="GITHUB">GitHub collaborators</option>
            <option value="ALLOWLIST">Allowlist</option>
            <option value="ALL_MEMBERS">All members</option>
          </select>
        </label>
        <label className="field" htmlFor={`sub-${id}`}>
          Who can submit
          <select
            id={`sub-${id}`}
            value={project.whoCanSubmit}
            onChange={(e) =>
              update.mutate({ whoCanSubmit: e.target.value as ProjectView['whoCanSubmit'] })
            }
          >
            <option value="GITHUB">GitHub write access or more</option>
            <option value="ALLOWLIST">Allowlist</option>
          </select>
        </label>
        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={project.requireParticipantApproval}
              onChange={(e) => update.mutate({ requireParticipantApproval: e.target.checked })}
            />{' '}
            Require participant approval
          </span>
          <span className="hint">New participants stay pending until you approve them.</span>
        </label>
      </div>
      <ParticipantsApproval projectId={project.id} />
    </article>
  );
}
