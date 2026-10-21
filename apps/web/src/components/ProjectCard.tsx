import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectView, UpdateProjectRequest } from '@orch/shared';
import {
  decideParticipant,
  deleteProject,
  fetchParticipants,
  updateProject,
} from '../api/endpoints';
import { presenceProps, usePresence, type Phase } from '../ui/presence';
import { useToast } from '../ui/Toast';

const PARTICIPATE_HELP: Record<ProjectView['whoCanParticipate'], string> = {
  GITHUB:
    'Only people who are collaborators on the GitHub repository can lend their Claude capacity. Anyone else is told to ask you for access.',
  ALLOWLIST:
    'Only people you or an admin explicitly allowed on this server can lend their Claude capacity, whether or not they are GitHub collaborators.',
  ALL_MEMBERS: 'Every user of this orch server can lend their Claude capacity to this project.',
};

function ParticipantsApproval({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['projects', projectId, 'participants'],
    queryFn: () => fetchParticipants(projectId),
  });
  const decide = useMutation({
    mutationFn: (v: { userId: string; login: string; decision: 'approve' | 'reject' }) =>
      decideParticipant(projectId, v.userId, v.decision),
    onSuccess: (_r, v) => {
      toast(v.decision === 'approve' ? `${v.login} approved` : `${v.login} rejected`);
      return qc.invalidateQueries({ queryKey: ['projects', projectId, 'participants'] });
    },
  });
  const pending = q.data?.filter((p) => p.participation.status === 'pending');
  const rows = usePresence(pending, (p) => p.user.id);
  return (
    <div className="subpanel">
      <h3>Pending participants</h3>
      {q.error && <p className="error">{q.error.message}</p>}
      {decide.error && <p className="error">{decide.error.message}</p>}
      {q.isSuccess && pending?.length === 0 && <p className="hint">No pending requests.</p>}
      <ul className="list">
        {rows.map(({ key, item: p, phase }) => (
          <li key={key} {...presenceProps(phase)}>
            <span className="who">
              <strong>{p.user.githubLogin}</strong>
              <span className="badge">{p.participation.budgetPercent}%</span>
              <span className="badge">{p.participation.mode}</span>
            </span>
            <span className="row">
              <button
                className="primary"
                aria-label={`Approve ${p.user.githubLogin}`}
                onClick={() =>
                  decide.mutate({
                    userId: p.user.id,
                    login: p.user.githubLogin,
                    decision: 'approve',
                  })
                }
              >
                Approve
              </button>
              <button
                className="danger"
                aria-label={`Reject ${p.user.githubLogin}`}
                onClick={() =>
                  decide.mutate({
                    userId: p.user.id,
                    login: p.user.githubLogin,
                    decision: 'reject',
                  })
                }
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

export function ProjectCard({ project, phase = 'idle' }: { project: ProjectView; phase?: Phase }) {
  const qc = useQueryClient();
  const toast = useToast();
  const update = useMutation({
    mutationFn: (patch: UpdateProjectRequest) => updateProject(project.id, patch),
    onSuccess: () => {
      toast(`${project.fullName} settings saved`);
      return qc.invalidateQueries({ queryKey: ['projects', 'mine'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => {
      toast(`${project.fullName} removed from orch`);
      // The repo picker caches `alreadyAdded` per repository: drop it so reopening the dialog
      // never flashes a removed repo as "Added" before the refetch lands.
      qc.removeQueries({ queryKey: ['repos'] });
      qc.removeQueries({ queryKey: ['projects', project.id] });
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['projects', 'mine'] }),
        qc.invalidateQueries({ queryKey: ['projects', 'discover'] }),
        qc.invalidateQueries({ queryKey: ['onboarding'] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['pool'] }),
      ]);
    },
  });
  const id = project.id;
  return (
    <article className="card" aria-label={project.fullName} {...presenceProps(phase)}>
      <div className="card-head">
        <div className="row">
          <h2>{project.fullName}</h2>
          {project.isPrivate && <span className="badge">private</span>}
        </div>
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
            <option value="ALL_MEMBERS">All orch users on this server</option>
            <option value="COLLABORATORS">Collaborators only</option>
            <option value="ALLOWLIST">Allowlist only</option>
          </select>
        </label>
        <div className="field">
          <label htmlFor={`part-${id}`}>Who can participate</label>
          <select
            aria-describedby={`part-help-${id}`}
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
            <option value="ALL_MEMBERS">All orch users on this server</option>
          </select>
          <span className="hint" id={`part-help-${id}`}>
            {PARTICIPATE_HELP[project.whoCanParticipate]}
          </span>
        </div>
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
          <span className="check-line">
            <input
              type="checkbox"
              checked={project.requireParticipantApproval}
              onChange={(e) => update.mutate({ requireParticipantApproval: e.target.checked })}
            />
            Require participant approval
          </span>
          <span className="hint">New participants stay pending until you approve them.</span>
        </label>
      </div>
      <ParticipantsApproval projectId={project.id} />
    </article>
  );
}
