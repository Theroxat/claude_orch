import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchMyProjects } from '../api/endpoints';
import { AddRepoDialog } from '../components/AddRepoDialog';
import { GettingStarted } from '../components/GettingStarted';
import { ProjectCard } from '../components/ProjectCard';
import { useT } from '../i18n/index.ts';
import { errorMessage } from '../i18n/errors.ts';
import { usePresence } from '../ui/presence';

export function Projects() {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });
  const projects = usePresence(q.data, (p) => p.id);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{t('projects.list.title')}</h1>
          <p className="lede">{t('projects.list.lede')}</p>
        </div>
        <div className="page-actions">
          <button className="primary" onClick={() => setAdding(true)}>
            {t('projects.list.add')}
          </button>
        </div>
      </header>
      <GettingStarted />
      {q.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {q.error && <p className="error">{errorMessage(q.error)}</p>}
      {q.isSuccess && q.data.length === 0 && (
        <div className="onboarding">
          <h2>{t('projects.list.emptyTitle')}</h2>
          <p>{t('projects.list.emptyBody')}</p>
          <button className="primary" onClick={() => setAdding(true)}>
            {t('projects.list.emptyAction')}
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
