import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchMyProjects } from '../api/endpoints';
import { AddRepoDialog } from '../components/AddRepoDialog';
import { GettingStarted } from '../components/GettingStarted';
import { ProjectCard } from '../components/ProjectCard';

export function Projects() {
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });
  return (
    <section>
      <div className="row between">
        <h1>My projects</h1>
        <button className="primary" onClick={() => setAdding(true)}>
          Add repository
        </button>
      </div>
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
      {q.data?.map((p) => (
        <ProjectCard key={p.id} project={p} />
      ))}
      {adding && <AddRepoDialog onClose={() => setAdding(false)} />}
    </section>
  );
}
