import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { REJECTION_REASON_MAX, type ProjectView, type UpdateProjectRequest } from '@orch/shared';
import {
  decideParticipant,
  deleteProject,
  fetchParticipants,
  undoRejection,
  updateProject,
} from '../api/endpoints';
import { Modal, closeModal } from '../ui/Modal';
import { presenceProps, usePresence, type Phase } from '../ui/presence';
import { useToast } from '../ui/Toast';
import { OwnerParticipation } from './OwnerParticipation';
import { TemplatesManager } from './TemplatesManager';

const PARTICIPATE_HELP: Record<ProjectView['whoCanParticipate'], string> = {
  GITHUB:
    'Only people who are collaborators on the GitHub repository can lend their Claude capacity. Anyone else is told to ask you for access.',
  ALLOWLIST:
    'Only people you or an admin explicitly allowed on this server can lend their Claude capacity, whether or not they are GitHub collaborators.',
  ALL_MEMBERS: 'Every user of this orch server can lend their Claude capacity to this project.',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function RejectDialog({
  login,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  login: string;
  pending: boolean;
  error: Error | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const tooLong = reason.trim().length > REJECTION_REASON_MAX;
  return (
    <Modal label="Reject participant" title={`Reject ${login}?`} onClose={onClose} tone="danger">
      <label className="field">
        Reason (optional, shown to {login})
        <textarea
          rows={3}
          maxLength={REJECTION_REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {tooLong && (
        <p className="error" role="alert">
          The reason is limited to {REJECTION_REASON_MAX} characters.
        </p>
      )}
      {error && <p className="error">{error.message}</p>}
      <div className="modal-actions">
        <button onClick={() => closeModal(onClose)}>Cancel</button>
        <button
          className="danger solid"
          disabled={pending || tooLong}
          onClick={() => onConfirm(reason.trim())}
        >
          Confirm reject
        </button>
      </div>
    </Modal>
  );
}

function ParticipantsApproval({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [toReject, setToReject] = useState<{ userId: string; login: string } | null>(null);
  const key = ['projects', projectId, 'participants'];
  const q = useQuery({ queryKey: key, queryFn: () => fetchParticipants(projectId) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const decide = useMutation({
    mutationFn: (v: {
      userId: string;
      login: string;
      decision: 'approve' | 'reject';
      reason?: string;
    }) => decideParticipant(projectId, v.userId, v.decision, v.reason),
    onSuccess: (_r, v) => {
      toast(v.decision === 'approve' ? `${v.login} approved` : `${v.login} rejected`);
      if (v.decision === 'reject') closeModal(() => setToReject(null));
      return refresh();
    },
  });
  const undo = useMutation({
    mutationFn: (v: { userId: string; login: string; to: 'pending' | 'approved' }) =>
      undoRejection(projectId, v.userId, { to: v.to }),
    onSuccess: (_r, v) => {
      toast(
        v.to === 'approved' ? `${v.login} approved` : `${v.login} is back in the pending requests`,
      );
      return refresh();
    },
  });
  // The owner's own row is managed in "Participate in my pool", never approved or rejected here.
  const members = q.data?.filter((p) => p.user.id !== project.ownerId);
  const pending = members?.filter((p) => p.participation.status === 'pending');
  const rejected = members?.filter((p) => p.participation.status === 'rejected') ?? [];
  const rows = usePresence(pending, (p) => p.user.id);
  const rejectedRows = usePresence(rejected, (p) => p.user.id);
  return (
    <div className="subpanel">
      <h3>Pending participants</h3>
      {!project.requireParticipantApproval && (
        <p className="hint">
          Approval is off: new participants are active as soon as they join. You can still reject
          them.
        </p>
      )}
      {q.error && <p className="error">{q.error.message}</p>}
      {decide.error && !toReject && <p className="error">{decide.error.message}</p>}
      {undo.error && <p className="error">{undo.error.message}</p>}
      {q.isSuccess && pending?.length === 0 && <p className="hint">No pending requests.</p>}
      <ul className="list">
        {rows.map(({ key, item: p, phase }) => (
          <li key={key} {...presenceProps(phase)}>
            <span className="who">
              <strong>{p.user.githubLogin}</strong>
              <span className="badge">{p.participation.budgetPercent}%</span>
              <span className="badge">{p.participation.mode}</span>
              {p.participation.previouslyRejectedAt && (
                <span
                  className="badge stop"
                  title={`Rejected on ${formatDate(p.participation.previouslyRejectedAt)}`}
                >
                  previously rejected
                  {p.participation.rejectionReason ? ` (${p.participation.rejectionReason})` : ''}
                </span>
              )}
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
                onClick={() => {
                  decide.reset();
                  setToReject({ userId: p.user.id, login: p.user.githubLogin });
                }}
              >
                Reject
              </button>
            </span>
          </li>
        ))}
      </ul>
      {rejected.length > 0 && <h3>Rejected members</h3>}
      <ul className="list">
        {rejectedRows.map(({ key, item: p, phase }) => (
          <li key={key} {...presenceProps(phase)}>
            <span className="who">
              <strong>{p.user.githubLogin}</strong>
              <span className="badge stop">rejected</span>
              {p.participation.rejectionReason && (
                <span className="hint">{p.participation.rejectionReason}</span>
              )}
            </span>
            <span className="row">
              <button
                aria-label={`Undo rejection of ${p.user.githubLogin}: back to pending`}
                disabled={undo.isPending}
                onClick={() =>
                  undo.mutate({ userId: p.user.id, login: p.user.githubLogin, to: 'pending' })
                }
              >
                Undo: back to pending
              </button>
              <button
                className="primary"
                aria-label={`Undo rejection of ${p.user.githubLogin}: approve`}
                disabled={undo.isPending}
                onClick={() =>
                  undo.mutate({ userId: p.user.id, login: p.user.githubLogin, to: 'approved' })
                }
              >
                Undo: approve
              </button>
            </span>
          </li>
        ))}
      </ul>
      {toReject && (
        <RejectDialog
          login={toReject.login}
          pending={decide.isPending}
          error={decide.error}
          onClose={() => setToReject(null)}
          onConfirm={(reason) =>
            decide.mutate({ ...toReject, decision: 'reject', reason: reason || undefined })
          }
        />
      )}
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
  const [templatesOpen, setTemplatesOpen] = useState(false);
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
      <details className="tpl-details" onToggle={(e) => setTemplatesOpen(e.currentTarget.open)}>
        <summary>Shared templates</summary>
        {templatesOpen && (
          <TemplatesManager scope="project" projectId={project.id} heading={false} />
        )}
      </details>
      <OwnerParticipation project={project} />
      <ParticipantsApproval project={project} />
    </article>
  );
}
