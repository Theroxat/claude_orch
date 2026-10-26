import { useQuery } from '@tanstack/react-query';
import { fetchDiscover } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useT } from '../i18n/index.ts';
import { ParticipationForm } from '../components/ParticipationForm';

export function Discover() {
  const t = useT();
  const q = useQuery({ queryKey: ['projects', 'discover'], queryFn: fetchDiscover });
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{t('projects.discover.title')}</h1>
          <p className="lede">{t('projects.discover.lede')}</p>
        </div>
      </header>
      {q.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {q.error && <p className="error">{errorMessage(q.error)}</p>}
      {q.isSuccess && q.data.length === 0 && (
        <p className="empty">{t('projects.discover.empty')}</p>
      )}
      {q.data?.map((item) => (
        <article className="card" key={item.project.id} aria-label={item.project.fullName}>
          <div className="card-head">
            <h2>{item.project.fullName}</h2>
            <span className="row">
              <span className="card-meta">
                {t('projects.discover.owner', { login: item.owner.githubLogin })}
              </span>
              <span className="badge">
                {t('projects.discover.role', { role: t(`projects.discover.roles.${item.myRole}`) })}
              </span>
            </span>
          </div>
          <ParticipationForm key={item.myParticipation?.id ?? 'new'} item={item} />
        </article>
      ))}
    </section>
  );
}
