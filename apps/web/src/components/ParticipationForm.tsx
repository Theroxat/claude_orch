import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiParticipationMode, DiscoverItem } from '@orch/shared';
import type { QueryKey } from '@tanstack/react-query';
import { putParticipation } from '../api/endpoints';
import { useChangeCount } from '../ui/presence';
import { useToast } from '../ui/Toast';

export function validateBudget(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 0 && n <= 100 ? n : null;
}

function CannotParticipate({ item }: { item: DiscoverItem }) {
  const { fullName } = item.project;
  const owner = item.owner.githubLogin;
  const reason = item.cannotParticipateReason;
  return (
    <p className="hint" role="note">
      {reason === 'NOT_GITHUB_COLLABORATOR'
        ? `Only GitHub collaborators of ${fullName} can join. Ask the owner (${owner}) to either add you as a collaborator on GitHub, or set 'Who can participate' to 'All orch users on this server' in Projects.`
        : reason === 'BLOCKED_BY_OWNER'
          ? `The owner (${owner}) has blocked you from joining ${fullName}. Ask them to change this in Projects.`
          : `Only people on the allowlist of ${fullName} can join. Ask the owner (${owner}) to allow you, or set 'Who can participate' to 'All orch users on this server' in Projects.`}
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
      toast(`Participation in ${item.project.fullName} saved`);
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
          Participate
        </label>
        <span key={statusChanges} className="row" data-changed={statusChanges > 0 || undefined}>
          {p?.status === 'pending' && <span className="badge pending">Pending owner approval</span>}
          {p?.status === 'active' && <span className="badge ok">Active</span>}
          {p?.status === 'rejected' && <span className="badge stop">Rejected by owner</span>}
        </span>
      </div>
      {p?.status === 'rejected' && (
        <p className="hint" role="note">
          {p.rejectionReason ? `Owner's reason: ${p.rejectionReason}` : 'The owner gave no reason.'}{' '}
          Saving with Participate checked asks again.
        </p>
      )}
      <div className="grid">
        <div className="field">
          <label htmlFor={`budget-${id}`}>Budget (% of my Claude capacity)</label>
          <div className="budget">
            <input
              type="range"
              aria-label="Budget slider"
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
              Budget must be a whole number between 0 and 100.
            </span>
          )}
        </div>
        <fieldset className="field">
          <legend>Mode</legend>
          <label className="radio">
            <input
              type="radio"
              name={`mode-${id}`}
              checked={mode === 'auto'}
              onChange={() => setMode('auto')}
            />{' '}
            <strong>Auto</strong>
            <span className="hint">Tasks start on my machine without asking me.</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name={`mode-${id}`}
              checked={mode === 'approval'}
              onChange={() => setMode('approval')}
            />{' '}
            <strong>Approval</strong>
            <span className="hint">
              I approve each request before anything runs. Recommended to start.
            </span>
          </label>
        </fieldset>
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
      <div className="card-foot">
        <button className="primary" type="submit" disabled={save.isPending || invalid}>
          Save
        </button>
      </div>
    </form>
  );
}
