import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addProject, fetchAvailableRepos, fetchInstallUrl } from '../api/endpoints';

export function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const repos = useQuery({ queryKey: ['repos', 'available'], queryFn: fetchAvailableRepos });
  const install = useQuery({ queryKey: ['install-url'], queryFn: fetchInstallUrl });
  const add = useMutation({
    mutationFn: (githubRepoId: number) => addProject({ githubRepoId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['repos'] });
      onClose();
    },
  });
  const list = repos.data ?? [];
  const noRepos = repos.isSuccess && list.length === 0;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Add repository">
        <div className="row between">
          <h2>Add repository</h2>
          <button onClick={onClose}>Close</button>
        </div>
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
        {noRepos && (
          <p className="hint">
            No repositories available. The GitHub App may not be installed on any of your
            repositories yet.
          </p>
        )}
        <p className="hint">
          Repository missing?{' '}
          {install.data ? (
            <a href={install.data.url}>Install the GitHub App</a>
          ) : (
            'Install the GitHub App'
          )}{' '}
          on it, then reopen this dialog.
        </p>
      </div>
    </div>
  );
}
