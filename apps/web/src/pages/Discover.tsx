import { useQuery } from '@tanstack/react-query';
import { fetchDiscover } from '../api/endpoints';
import { ParticipationForm } from '../components/ParticipationForm';

export function Discover() {
  const q = useQuery({ queryKey: ['projects', 'discover'], queryFn: fetchDiscover });
  return (
    <section>
      <h1>Discover</h1>
      <p className="hint">Choose the projects you lend your Claude capacity to.</p>
      {q.isPending && <p className="hint">Loading...</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {q.isSuccess && q.data.length === 0 && <p className="hint">No projects to discover yet.</p>}
      {q.data?.map((item) => (
        <article className="card" key={item.project.id} aria-label={item.project.fullName}>
          <div className="row between">
            <h2>{item.project.fullName}</h2>
            <span className="hint">
              owner: {item.owner.githubLogin} · your role: {item.myRole}
            </span>
          </div>
          <ParticipationForm key={item.myParticipation?.id ?? 'new'} item={item} />
        </article>
      ))}
    </section>
  );
}
