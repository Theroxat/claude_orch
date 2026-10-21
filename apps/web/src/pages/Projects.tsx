import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchMyProjects } from '../api/endpoints';
import { AddRepoDialog } from '../components/AddRepoDialog';
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
      {q.isPending && <p className="hint">Loading...</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {q.isSuccess && q.data.length === 0 && (
        <p className="hint">You have not added any project yet.</p>
      )}
      {q.data?.map((p) => (
        <ProjectCard key={p.id} project={p} />
      ))}
      {adding && <AddRepoDialog onClose={() => setAdding(false)} />}
    </section>
  );
}
