import type en from '../en/layout.ts';
import type { Catalog } from '../../types.ts';

export default {
  nav: {
    label: 'Principale',
    projects: 'Projets',
    discover: 'Découvrir',
    pool: 'Pool',
    requests: 'Demandes',
    backlog: 'Backlog',
    history: 'Historique',
    usage: 'Consommation',
    claudeCode: 'Claude Code',
    myServer: 'Mon serveur',
    access: 'Accès',
    pendingRequests: { one: '{count} demande en attente', other: '{count} demandes en attente' },
    pendingAccess: {
      one: '{count} demande d’accès en attente',
      other: '{count} demandes d’accès en attente',
    },
  },
  header: {
    home: 'Accueil orch',
    setupWizard: 'Assistant de configuration',
    gettingStarted: {
      one: 'Premiers pas : {count} étape sur {total} terminée',
      other: 'Premiers pas : {count} étapes sur {total} terminées',
    },
    docs: 'Documentation',
    repo: 'Dépôt GitHub',
    logOut: 'Se déconnecter',
  },
  theme: {
    toLight: 'Passer au thème clair',
    toDark: 'Passer au thème sombre',
    light: 'Thème clair',
    dark: 'Thème sombre',
  },
  language: {
    label: 'Langue',
  },
  notFound: {
    label: 'Page introuvable',
    title: 'Page introuvable',
    body: 'Cette page n’existe pas.',
    back: 'Retour à orch',
  },
  copy: {
    failed: 'Échec de la copie. Sélectionner la commande et la copier à la main.',
  },
  pwa: {
    updateReady: 'Nouvelle version disponible',
    reload: 'Recharger',
  },
  agentUpdate: {
    label: 'Mise à jour de l’agent',
    outdated: 'L’agent de <strong>{machine}</strong> n’est pas à jour (v{from} → v{to})',
    manual: 'Mettre à jour à la main',
    ifFails: 'En cas d’échec :',
  },
} satisfies Catalog<typeof en>;
