import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { addProject, fetchAvailableRepos, fetchInstallUrl } from '../api/endpoints';

const ADMIN_NOTE =
  'Only repositories where you are an admin are listed: the project owner must be a repository admin.';

/** Repository list + "Install the GitHub App" guide. Shared by the dialog and the setup wizard. */
export function RepoPicker({ onAdded, pollMs }: { onAdded: () => void; pollMs?: number }) {
  const qc = useQueryClient();
  const repos = useQuery({
    queryKey: ['repos', 'available'],
    queryFn: fetchAvailableRepos,
    refetchInterval: pollMs ?? false,
  });
  const install = useQuery({ queryKey: ['install-url'], queryFn: fetchInstallUrl });
  const add = useMutation({
    mutationFn: (githubRepoId: number) => addProject({ githubRepoId }),
    onSuccess: async () => {
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
  const noRepos = repos.isSuccess && list.length === 0;
  return (
    <>
      {repos.isPending && <p className="hint">Loading repositories...</p>}
      {repos.error && <p className="error">{repos.error.message}</p>}
      {add.error && <p className="error">{add.error.message}</p>}
      <ul className="list">
        {list.map((r) => (
          <li key={r.githubRepoId}>
            <span>
              {r.fullName} {r.private && <span className="badge">private</span>}
            </span>
            {r.alreadyAdded ? (
              <span className="badge ok">Added</span>
            ) : (
              <button
                className="primary"
                disabled={add.isPending}
                aria-label={`Add ${r.fullName}`}
                onClick={() => add.mutate(r.githubRepoId)}
              >
                Add
              </button>
            )}
          </li>
        ))}
      </ul>
      {noRepos ? (
        <section className="onboarding" aria-label="Install the GitHub App first">
          <h3>Install the GitHub App first</h3>
          <p>
            Signing in with GitHub doesn&apos;t give orch access to any repository. You need to
            install the orch GitHub App on the repositories you want to add to the pool.
          </p>
          <ol>
            <li>
              Click <strong>Install the GitHub App</strong>.{' '}
              {install.data ? (
                <a
                  className="btn primary"
                  href={install.data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Install the GitHub App
                </a>
              ) : (
                <span className="hint">Loading the install link...</span>
              )}
            </li>
            <li>Pick your account or organization.</li>
            <li>
              Choose <strong>Only select repositories</strong> and tick the repos you want in the
              pool (or <strong>All repositories</strong>).
            </li>
            <li>
              Click <strong>Install</strong>. GitHub sends you back to orch.
            </li>
            <li>
              Click <strong>Refresh</strong> below.
            </li>
          </ol>
          <button disabled={repos.isFetching} onClick={() => void repos.refetch()}>
            Refresh
          </button>
          <p className="hint">{ADMIN_NOTE}</p>
        </section>
      ) : (
        <>
          <p className="hint">
            Repository missing?{' '}
            {install.data ? (
              <a href={install.data.url} target="_blank" rel="noopener noreferrer">
                Install the GitHub App
              </a>
            ) : (
              'Install the GitHub App'
            )}{' '}
            on it.
          </p>
          <p className="hint">{ADMIN_NOTE}</p>
        </>
      )}
    </>
  );
}

export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Add repository">
        <div className="row between">
          <h2>Add repository</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <RepoPicker onAdded={onClose} />
      </div>
    </div>
  );
}
