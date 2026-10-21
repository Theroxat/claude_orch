import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiParticipationMode, DiscoverItem } from '@orch/shared';
import { putParticipation } from '../api/endpoints';

export function validateBudget(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= 0 && n <= 100 ? n : null;
}

export function ParticipationForm({ item }: { item: DiscoverItem }) {
  const qc = useQueryClient();
  const p = item.myParticipation;
  const id = item.project.id;
  const [participating, setParticipating] = useState(p?.participating ?? false);
  const [budget, setBudget] = useState(String(p?.budgetPercent ?? 20));
  const [mode, setMode] = useState<ApiParticipationMode>(p?.mode ?? 'approval');
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: (v: {
      participating: boolean;
      budgetPercent: number;
      mode: ApiParticipationMode;
    }) => putParticipation(id, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', 'discover'] }),
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
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={participating}
            onChange={(e) => setParticipating(e.target.checked)}
          />{' '}
          Participate
        </label>
        {p?.status === 'pending' && <span className="badge pending">Pending owner approval</span>}
        {p?.status === 'active' && <span className="badge ok">Active</span>}
        {p?.status === 'rejected' && <span className="badge">Rejected by owner</span>}
      </div>
      <div className="grid">
        <div className="field">
          <label htmlFor={`budget-${id}`}>Budget (% of my Claude capacity)</label>
          <div className="row">
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
              style={{ width: 80 }}
            />
          </div>
          {(touched || invalid) && invalid && (
            <span className="error" role="alert">
              Budget must be a whole number between 0 and 100.
            </span>
          )}
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Mode</legend>
          <label className="radio">
            <input
              type="radio"
              name={`mode-${id}`}
              checked={mode === 'auto'}
              onChange={() => setMode('auto')}
            />{' '}
            Auto
            <span className="hint">Tasks start on my machine without asking me.</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name={`mode-${id}`}
              checked={mode === 'approval'}
              onChange={() => setMode('approval')}
            />{' '}
            Approval
            <span className="hint">I approve each request before anything runs.</span>
          </label>
        </fieldset>
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
      <button className="primary" type="submit" disabled={save.isPending || invalid}>
        Save
      </button>
    </form>
  );
}
