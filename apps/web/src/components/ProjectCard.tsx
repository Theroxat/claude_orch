import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  REJECTION_REASON_MAX,
  type ApiParticipationMode,
  type ProjectView,
  type UpdateProjectRequest,
} from '@orch/shared';
import {
  decideParticipant,
  deleteProject,
  fetchParticipants,
  undoRejection,
  updateProject,
} from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { formatDate } from '../i18n/format.ts';
import { useT, type MessageKey } from '../i18n/index.ts';
import { Modal, closeModal } from '../ui/Modal';
import { presenceProps, usePresence, type Phase } from '../ui/presence';
import { useToast } from '../ui/Toast';
import { OwnerParticipation } from './OwnerParticipation';
import { TemplatesManager } from './TemplatesManager';

const PARTICIPATE_HELP = {
  GITHUB: 'projects.card.participateHelp.GITHUB',
  ALLOWLIST: 'projects.card.participateHelp.ALLOWLIST',
  ALL_MEMBERS: 'projects.card.participateHelp.ALL_MEMBERS',
} as const satisfies Record<ProjectView['whoCanParticipate'], MessageKey>;

const MODE_LABEL = {
  auto: 'projects.approvals.mode.auto',
  approval: 'projects.approvals.mode.approval',
} as const satisfies Record<ApiParticipationMode, MessageKey>;

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
  const t = useT();
  const [reason, setReason] = useState('');
  const tooLong = reason.trim().length > REJECTION_REASON_MAX;
  return (
    <Modal
      label={t('projects.reject.label')}
      title={t('projects.reject.title', { login })}
      onClose={onClose}
      tone="danger"
    >
      <label className="field">
        {t('projects.reject.reason', { login })}
        <textarea
          rows={3}
          maxLength={REJECTION_REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {tooLong && (
        <p className="error" role="alert">
          {t('projects.reject.tooLong', { max: REJECTION_REASON_MAX })}
        </p>
      )}
      {error && <p className="error">{errorMessage(error)}</p>}
      <div className="modal-actions">
        <button onClick={() => closeModal(onClose)}>{t('common.actions.cancel')}</button>
        <button
          className="danger solid"
          disabled={pending || tooLong}
          onClick={() => onConfirm(reason.trim())}
        >
          {t('projects.reject.confirm')}
        </button>
      </div>
    </Modal>
  );
}

function ParticipantsApproval({ project }: { project: ProjectView }) {
  const t = useT();
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
      toast(
        v.decision === 'approve'
          ? t('projects.approvals.approved', { login: v.login })
          : t('projects.approvals.rejected', { login: v.login }),
      );
      if (v.decision === 'reject') closeModal(() => setToReject(null));
      return refresh();
    },
  });
  const undo = useMutation({
    mutationFn: (v: { userId: string; login: string; to: 'pending' | 'approved' }) =>
      undoRejection(projectId, v.userId, { to: v.to }),
    onSuccess: (_r, v) => {
      toast(
        v.to === 'approved'
          ? t('projects.approvals.approved', { login: v.login })
          : t('projects.approvals.backPending', { login: v.login }),
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
      <h3>{t('projects.approvals.heading')}</h3>
      {!project.requireParticipantApproval && (
        <p className="hint">{t('projects.approvals.approvalOff')}</p>
      )}
      {q.error && <p className="error">{errorMessage(q.error)}</p>}
      {decide.error && !toReject && <p className="error">{errorMessage(decide.error)}</p>}
      {undo.error && <p className="error">{errorMessage(undo.error)}</p>}
      {q.isSuccess && pending?.length === 0 && (
        <p className="hint">{t('projects.approvals.none')}</p>
      )}
      <ul className="list">
        {rows.map(({ key, item: p, phase }) => (
          <li key={key} {...presenceProps(phase)}>
            <span className="who">
              <strong>{p.user.githubLogin}</strong>
              <span className="badge">
                {t('projects.approvals.budget', { percent: p.participation.budgetPercent })}
              </span>
              <span className="badge">{t(MODE_LABEL[p.participation.mode])}</span>
              {p.participation.previouslyRejectedAt && (
                <span
                  className="badge stop"
                  title={t('projects.approvals.previouslyRejectedOn', {
                    date: formatDate(p.participation.previouslyRejectedAt, {}),
                  })}
                >
                  {p.participation.rejectionReason
                    ? t('projects.approvals.previouslyRejectedReason', {
                        reason: p.participation.rejectionReason,
                      })
                    : t('projects.approvals.previouslyRejected')}
                </span>
              )}
            </span>
            <span className="row">
              <button
                className="primary"
                aria-label={t('projects.approvals.approveAria', { login: p.user.githubLogin })}
                onClick={() =>
                  decide.mutate({
                    userId: p.user.id,
                    login: p.user.githubLogin,
                    decision: 'approve',
                  })
                }
              >
                {t('projects.approvals.approve')}
              </button>
              <button
                className="danger"
                aria-label={t('projects.approvals.rejectAria', { login: p.user.githubLogin })}
                onClick={() => {
                  decide.reset();
                  setToReject({ userId: p.user.id, login: p.user.githubLogin });
                }}
              >
                {t('projects.approvals.reject')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {rejected.length > 0 && <h3>{t('projects.approvals.rejectedHeading')}</h3>}
      <ul className="list">
        {rejectedRows.map(({ key, item: p, phase }) => (
          <li key={key} {...presenceProps(phase)}>
            <span className="who">
              <strong>{p.user.githubLogin}</strong>
              <span className="badge stop">{t('projects.approvals.rejectedBadge')}</span>
              {p.participation.rejectionReason && (
                <span className="hint">{p.participation.rejectionReason}</span>
              )}
            </span>
            <span className="row">
              <button
                aria-label={t('projects.approvals.undoPendingAria', { login: p.user.githubLogin })}
                disabled={undo.isPending}
                onClick={() =>
                  undo.mutate({ userId: p.user.id, login: p.user.githubLogin, to: 'pending' })
                }
              >
                {t('projects.approvals.undoPending')}
              </button>
              <button
                className="primary"
                aria-label={t('projects.approvals.undoApproveAria', { login: p.user.githubLogin })}
                disabled={undo.isPending}
                onClick={() =>
                  undo.mutate({ userId: p.user.id, login: p.user.githubLogin, to: 'approved' })
                }
              >
                {t('projects.approvals.undoApprove')}
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
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const update = useMutation({
    mutationFn: (patch: UpdateProjectRequest) => updateProject(project.id, patch),
    onSuccess: () => {
      toast(t('projects.card.saved', { name: project.fullName }));
      return qc.invalidateQueries({ queryKey: ['projects', 'mine'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => {
      toast(t('projects.card.removed', { name: project.fullName }));
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
          {project.isPrivate && <span className="badge">{t('projects.card.private')}</span>}
        </div>
        <button
          className="danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(t('projects.card.removeConfirm', { name: project.fullName })))
              remove.mutate();
          }}
        >
          {t('projects.card.remove')}
        </button>
      </div>
      {update.error && <p className="error">{errorMessage(update.error)}</p>}
      {remove.error && <p className="error">{errorMessage(remove.error)}</p>}
      <div className="grid">
        <label className="field" htmlFor={`vis-${id}`}>
          {t('projects.card.visibility')}
          <select
            id={`vis-${id}`}
            value={project.visibility}
            onChange={(e) =>
              update.mutate({ visibility: e.target.value as ProjectView['visibility'] })
            }
          >
            <option value="ALL_MEMBERS">{t('projects.card.allUsers')}</option>
            <option value="COLLABORATORS">{t('projects.card.collaboratorsOnly')}</option>
            <option value="ALLOWLIST">{t('projects.card.allowlistOnly')}</option>
          </select>
        </label>
        <div className="field">
          <label htmlFor={`part-${id}`}>{t('projects.card.whoParticipate')}</label>
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
            <option value="GITHUB">{t('projects.card.githubCollaborators')}</option>
            <option value="ALLOWLIST">{t('projects.card.allowlist')}</option>
            <option value="ALL_MEMBERS">{t('projects.card.allUsers')}</option>
          </select>
          <span className="hint" id={`part-help-${id}`}>
            {t(PARTICIPATE_HELP[project.whoCanParticipate])}
          </span>
        </div>
        <label className="field" htmlFor={`sub-${id}`}>
          {t('projects.card.whoSubmit')}
          <select
            id={`sub-${id}`}
            value={project.whoCanSubmit}
            onChange={(e) =>
              update.mutate({ whoCanSubmit: e.target.value as ProjectView['whoCanSubmit'] })
            }
          >
            <option value="GITHUB">{t('projects.card.githubWrite')}</option>
            <option value="ALLOWLIST">{t('projects.card.allowlist')}</option>
          </select>
        </label>
        <label className="field">
          <span className="check-line">
            <input
              type="checkbox"
              checked={project.requireParticipantApproval}
              onChange={(e) => update.mutate({ requireParticipantApproval: e.target.checked })}
            />
            {t('projects.card.requireApproval')}
          </span>
          <span className="hint">{t('projects.card.requireApprovalHint')}</span>
        </label>
      </div>
      <details className="tpl-details" onToggle={(e) => setTemplatesOpen(e.currentTarget.open)}>
        <summary>{t('projects.card.sharedTemplates')}</summary>
        {templatesOpen && (
          <TemplatesManager scope="project" projectId={project.id} heading={false} />
        )}
      </details>
      <OwnerParticipation project={project} />
      <ParticipantsApproval project={project} />
    </article>
  );
}
