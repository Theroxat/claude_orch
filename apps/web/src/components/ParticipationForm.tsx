import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiParticipationMode, DiscoverItem } from '@orch/shared';
import type { QueryKey } from '@tanstack/react-query';
import { putParticipation } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useT } from '../i18n/index.ts';
import { useChangeCount } from '../ui/presence';
import { useToast } from '../ui/Toast';

export function validateBudget(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 0 && n <= 100 ? n : null;
}

function CannotParticipate({ item }: { item: DiscoverItem }) {
  const t = useT();
  const { fullName } = item.project;
  const owner = item.owner.githubLogin;
  const reason = item.cannotParticipateReason;
  return (
    <p className="hint" role="note">
      {reason === 'NOT_GITHUB_COLLABORATOR'
        ? t('projects.form.cannotCollaborator', { name: fullName, owner })
        : reason === 'BLOCKED_BY_OWNER'
          ? t('projects.form.cannotBlocked', { name: fullName, owner })
          : t('projects.form.cannotAllowlist', { name: fullName, owner })}
    </p>
  );
}

interface FormProps {
  item: DiscoverItem;
  /** Optional heading shown above the form. */
  title?: string;
  /** Extra queries to refresh after a save (Discover is always refreshed). */
  invalidateKeys?: QueryKey[];
}

export function ParticipationForm(props: FormProps) {
  const { item } = props;
  if (!item.canParticipate && !item.myParticipation?.participating) {
    return <CannotParticipate item={item} />;
  }
  return <ParticipationFields {...props} />;
}

function ParticipationFields({ item, title, invalidateKeys = [] }: FormProps) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const p = item.myParticipation;
  const statusChanges = useChangeCount(p?.status);
  const id = item.project.id;
  const [participating, setParticipating] = useState(p?.participating ?? false);
  const [budget, setBudget] = useState(String(p?.budgetPercent ?? 20));
  const [mode, setMode] = useState<ApiParticipationMode>(p?.participating ? p.mode : 'approval');
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: (v: {
      participating: boolean;
      budgetPercent: number;
      mode: ApiParticipationMode;
    }) => putParticipation(id, v),
    onSuccess: () => {
      toast(t('projects.form.saved', { name: item.project.fullName }));
      return Promise.all(
        [['projects', 'discover'], ...invalidateKeys].map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
  const parsed = validateBudget(budget);
  const invalid = parsed === null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (parsed === null) return;
        save.mutate({ participating, budgetPercent: parsed, mode });
      }}
    >
      {title && <h3>{title}</h3>}
      <div className="row">
        <label className="check-line">
          <input
            type="checkbox"
            checked={participating}
            onChange={(e) => setParticipating(e.target.checked)}
          />
          {t('projects.form.participate')}
        </label>
        <span key={statusChanges} className="row" data-changed={statusChanges > 0 || undefined}>
          {p?.status === 'pending' && (
            <span className="badge pending">{t('projects.form.pendingApproval')}</span>
          )}
          {p?.status === 'active' && <span className="badge ok">{t('projects.form.active')}</span>}
          {p?.status === 'rejected' && (
            <span className="badge stop">{t('projects.form.rejectedByOwner')}</span>
          )}
        </span>
      </div>
      {p?.status === 'rejected' && (
        <p className="hint" role="note">
          {p.rejectionReason
            ? t('projects.form.ownerReason', { reason: p.rejectionReason })
            : t('projects.form.noReason')}{' '}
          {t('projects.form.askAgain')}
        </p>
      )}
      <div className="grid">
        <div className="field">
          <label htmlFor={`budget-${id}`}>{t('projects.form.budget')}</label>
          <div className="budget">
            <input
              type="range"
              aria-label={t('projects.form.budgetSlider')}
              min={0}
              max={100}
              value={parsed ?? 0}
              onChange={(e) => setBudget(e.target.value)}
            />
            <input
              id={`budget-${id}`}
              type="number"
              min={0}
              max={100}
              step={1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          {(touched || invalid) && invalid && (
            <span className="error" role="alert">
              {t('projects.form.budgetInvalid')}
            </span>
          )}
        </div>
        <fieldset className="field">
          <legend>{t('projects.form.mode')}</legend>
          <label className="radio">
            <input
              type="radio"
              name={`mode-${id}`}
              checked={mode === 'auto'}
              onChange={() => setMode('auto')}
            />{' '}
            <strong>{t('projects.form.auto')}</strong>
            <span className="hint">{t('projects.form.autoHint')}</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name={`mode-${id}`}
              checked={mode === 'approval'}
              onChange={() => setMode('approval')}
            />{' '}
            <strong>{t('projects.form.approval')}</strong>
            <span className="hint">{t('projects.form.approvalHint')}</span>
          </label>
        </fieldset>
      </div>
      {save.error && <p className="error">{errorMessage(save.error)}</p>}
      <div className="card-foot">
        <button className="primary" type="submit" disabled={save.isPending || invalid}>
          {t('common.actions.save')}
        </button>
      </div>
    </form>
  );
}
