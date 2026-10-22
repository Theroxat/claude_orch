import { useEffect } from 'react';
import { useToast } from '../ui/Toast';
import { registerServiceWorker } from './register';

/** Registers the service worker and offers a reload once a new version is ready. */
export function UpdatePrompt() {
  const toast = useToast();
  useEffect(() => {
    const reload = registerServiceWorker(() =>
      toast('New version available', 'info', {
        sticky: true,
        action: { label: 'Reload', onClick: () => reload() },
      }),
    );
  }, [toast]);
  return null;
}
