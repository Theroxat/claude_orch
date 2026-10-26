import { useQuery } from '@tanstack/react-query';
import type { DiscoverItem, ProjectView } from '@orch/shared';
import { fetchParticipants } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useT } from '../i18n/index.ts';
import { ParticipationForm } from './ParticipationForm';

/**
 * The owner lends their own Claude capacity to their project. Same form and same PUT as any
 * member: nothing is enabled unless the owner saves it, and the server approves it at once.
 */
export function OwnerParticipation({ project, title }: { project: ProjectView; title?: string }) {
  const t = useT();
  const heading = title ?? t('projects.owner.title');
  const key = ['projects', project.id, 'participants'];
  const q = useQuery({ queryKey: key, queryFn: () => fetchParticipants(project.id) });
  if (q.error) return <p className="error">{errorMessage(q.error)}</p>;
  if (!q.isSuccess) return null;
  const row = q.data.find((p) => p.user.id === project.ownerId);
  const mine = row?.participation ?? null;
  const item: DiscoverItem = {
    project,
    // Only read by the cannot-participate note, which an owner never sees.
    owner: { githubLogin: row?.user.githubLogin ?? '', avatarUrl: row?.user.avatarUrl ?? null },
    myRole: 'owner',
    myParticipation: mine,
    canParticipate: true,
    cannotParticipateReason: null,
  };
  return (
    <div
      className="subpanel"
      aria-label={t('projects.owner.group', { title: heading, name: project.fullName })}
      role="group"
    >
      <ParticipationForm
        key={mine?.id ?? 'new'}
        item={item}
        title={heading}
        invalidateKeys={[key]}
      />
      <p className="hint">{t('projects.owner.hint')}</p>
    </div>
  );
}
