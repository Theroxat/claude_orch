import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchMyProjects } from '../api/endpoints';
import { AddRepoDialog } from '../components/AddRepoDialog';
import { GettingStarted } from '../components/GettingStarted';
import { ProjectCard } from '../components/ProjectCard';
import { usePresence } from '../ui/presence';

export function Projects() {
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });
  const projects = usePresence(q.data, (p) => p.id);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>My projects</h1>
          <p className="lede">
            Repositories you own in orch, who can see them, and who may lend capacity or submit
            tasks.
          </p>
        </div>
        <div className="page-actions">
          <button className="primary" onClick={() => setAdding(true)}>
            Add repository
          </button>
        </div>
      </header>
      <GettingStarted />
      {q.isPending && <p className="hint">Loading...</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {q.isSuccess && q.data.length === 0 && (
        <div className="onboarding">
          <h2>Add your first repository to the pool</h2>
          <p>Install the orch GitHub App on a repository, then add it here to start sharing.</p>
          <button className="primary" onClick={() => setAdding(true)}>
            Add your first repository
          </button>
        </div>
      )}
      {projects.map(({ key, item, phase }) => (
        <ProjectCard key={key} project={item} phase={phase} />
      ))}
      {adding && <AddRepoDialog onClose={() => setAdding(false)} />}
    </section>
  );
}
