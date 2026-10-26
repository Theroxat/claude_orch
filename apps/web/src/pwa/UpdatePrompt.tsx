import { useEffect } from 'react';
import { t } from '../i18n/index.ts';
import { useToast } from '../ui/Toast';
import { registerServiceWorker, reloadOnStaleChunk } from './register';

/** Registers the service worker and offers a reload once a new version is ready. */
export function UpdatePrompt() {
  const toast = useToast();
  useEffect(() => reloadOnStaleChunk(), []);
  useEffect(() => {
    const reload = registerServiceWorker(() =>
      toast(t('layout.pwa.updateReady'), 'info', {
        sticky: true,
        action: { label: t('layout.pwa.reload'), onClick: () => reload() },
      }),
    );
  }, [toast]);
  return null;
}
