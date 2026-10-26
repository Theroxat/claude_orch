import { useT } from '../i18n/index.ts';

/** Shown on a cold load while a page chunk downloads. */
export function PageFallback() {
  const t = useT();
  return (
    <p className="page-loading">
      <span className="spinner" aria-hidden="true" /> {t('common.status.loading')}
    </p>
  );
}
