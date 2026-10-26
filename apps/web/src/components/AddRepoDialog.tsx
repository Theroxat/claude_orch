import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { addProject, fetchAvailableRepos, fetchInstallUrl } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT } from '../i18n/index.ts';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { presenceProps, usePresence } from '../ui/presence';
import { useToast } from '../ui/Toast';

const BOLD = { b: (c: ReactNode) => <strong>{c}</strong> };

/** Repository list + "Install the GitHub App" guide. Shared by the dialog and the setup wizard. */
export function RepoPicker({ onAdded, pollMs }: { onAdded: () => void; pollMs?: number }) {
  const t = useT();
  const rich = useRich();
  const qc = useQueryClient();
  const toast = useToast();
  const repos = useQuery({
    queryKey: ['repos', 'available'],
    queryFn: fetchAvailableRepos,
    refetchInterval: pollMs ?? false,
  });
  const install = useQuery({ queryKey: ['install-url'], queryFn: fetchInstallUrl });
  const add = useMutation({
    mutationFn: (githubRepoId: number) => addProject({ githubRepoId }),
    onSuccess: async (p) => {
      toast(t('projects.picker.addedToast', { name: p.fullName }));
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['repos'] });
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
      onAdded();
    },
  });
  const refetchRepos = repos.refetch;
  useEffect(() => {
    const onFocus = () => void refetchRepos();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetchRepos]);
  const list = repos.data ?? [];
  const rows = usePresence(repos.data, (r) => String(r.githubRepoId));
  const noRepos = repos.isSuccess && list.length === 0;
  return (
    <>
      {repos.isPending && <p className="hint">{t('projects.picker.loading')}</p>}
      {repos.error && <p className="error">{errorMessage(repos.error)}</p>}
      {add.error && <p className="error">{errorMessage(add.error)}</p>}
      <ul className="list">
        {rows.map(({ key, item: r, phase }) => (
          <li key={key} {...presenceProps(phase)}>
            <span className="who">
              <strong>{r.fullName}</strong>
              {r.private && <span className="badge">{t('projects.card.private')}</span>}
            </span>
            {r.alreadyAdded ? (
              <span className="badge ok">{t('projects.picker.added')}</span>
            ) : (
              <button
                className="primary"
                disabled={add.isPending}
                aria-label={t('projects.picker.addAria', { name: r.fullName })}
                onClick={() => add.mutate(r.githubRepoId)}
              >
                {t('projects.picker.add')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {noRepos ? (
        <section className="onboarding" aria-label={t('projects.picker.installFirst')}>
          <h3>{t('projects.picker.installFirst')}</h3>
          <p>{t('projects.picker.installBody')}</p>
          <ol>
            <li>
              {rich('projects.picker.step1', BOLD)}{' '}
              {install.data ? (
                <a
                  className="btn primary"
                  href={install.data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="github" />
                  {t('projects.picker.installApp')}
                </a>
              ) : (
                <span className="hint">{t('projects.picker.installLoading')}</span>
              )}
            </li>
            <li>{t('projects.picker.step2')}</li>
            <li>{rich('projects.picker.step3', BOLD)}</li>
            <li>{rich('projects.picker.step4', BOLD)}</li>
            <li>{rich('projects.picker.step5', BOLD)}</li>
          </ol>
          <button disabled={repos.isFetching} onClick={() => void repos.refetch()}>
            {t('projects.picker.refresh')}
          </button>
          <p className="hint">{t('projects.picker.adminNote')}</p>
        </section>
      ) : (
        <>
          <p className="hint">
            {rich('projects.picker.missing', {
              link: (c) =>
                install.data ? (
                  <a href={install.data.url} target="_blank" rel="noopener noreferrer">
                    {c}
                  </a>
                ) : (
                  c
                ),
            })}
          </p>
          <p className="hint">{t('projects.picker.adminNote')}</p>
        </>
      )}
    </>
  );
}

export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal label={t('projects.list.add')} title={t('projects.list.add')} onClose={onClose} wide>
      {/* Closes in the same render as the new project card appears, which animates in. */}
      <RepoPicker onAdded={onClose} />
    </Modal>
  );
}
