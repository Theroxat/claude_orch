import type en from '../en/common.ts';
import type { Catalog } from '../../types.ts';

export default {
  actions: {
    cancel: 'Annuler',
    close: 'Fermer',
    save: 'Enregistrer',
    delete: 'Supprimer',
    edit: 'Modifier',
    retry: 'Réessayer',
    copy: 'Copier',
    copied: 'Copié',
    copyFailed: 'Échec de la copie',
    loadMore: 'Charger plus',
  },
  status: {
    loading: 'Chargement…',
    loadingPage: 'Chargement de la page',
    saving: 'Enregistrement…',
  },
  time: {
    now: 'maintenant',
    in: 'dans {duration}',
    ago: 'il y a {duration}',
    hoursMinutes: '{h} h {m} min',
    minutes: '{m} min',
    expired: 'expiré',
  },
  toast: {
    rateLimitedFor: 'Trop de requêtes. Réessayer dans {seconds} s.',
    rateLimited: 'Trop de requêtes. Réessayer dans un instant.',
  },
} satisfies Catalog<typeof en>;
