import type en from '../en/claudeCode.ts';
import type { Catalog } from '../../types.ts';

export default {
  page: {
    lede: 'Connecter Claude Code à orch via MCP, pour qu’il puisse consulter le pool et envoyer des tâches à ta place.',
    loadingApps: 'Chargement des applications…',
    loadingTokens: 'Chargement des jetons…',
    never: 'jamais',
  },
  connect: {
    label: 'Connecter Claude Code',
    title: 'Connecter Claude Code',
    step1: 'Exécuter cette commande dans le terminal :',
    step2:
      'Dans Claude Code, exécuter <code>/mcp</code>, choisir <code>orch</code>, puis Authenticate.',
    step3: 'Le navigateur s’ouvre : se connecter avec GitHub et approuver. C’est tout.',
    hint: 'Aucun jeton à copier : l’accès est accordé via la connexion GitHub.',
  },
  usage: {
    label: 'Mode d’emploi',
    title: 'Mode d’emploi',
    intro:
      'Une fois connecté, demander à Claude Code des choses comme : « découper cette fonctionnalité en tâches et les envoyer au pool orch ».',
  },
  tools: {
    view_pool: 'Voir qui est dans le pool, sa disponibilité et sa marge estimée.',
    list_tasks: 'Lister les tâches de tes projets, éventuellement filtrées par projet ou statut.',
    submit_task:
      'Créer des tâches (tickets GitHub) et les envoyer au pool, aux membres ou à tout le monde.',
    take_task: 'Prendre une tâche pour soi afin que son agent l’exécute.',
    task_status: 'Consulter le statut d’une tâche (progression, pull request).',
  },
  apps: {
    title: 'Applications connectées',
    empty: 'Aucune application connectée pour l’instant.',
    label: 'Application {name}',
    authorized: 'Autorisée {when}',
    lastUsed: 'Dernière utilisation : {when}',
    revoke: 'Révoquer',
    revokeLabel: 'Révoquer l’accès',
    revokeTitle: 'Révoquer {name} ?',
    revokeBody: 'Cette application perdra l’accès immédiatement et devra être autorisée à nouveau.',
    revoked: 'Accès de {name} révoqué',
    confirm: 'Confirmer la révocation',
  },
  tokens: {
    title: 'Jetons d’accès personnels pour les scripts',
    hint: 'Pour les scripts et la CI, utiliser un jeton d’accès personnel (<code>{prefix}</code>) avec la forme <code>{header}</code> de la commande.',
    mine: 'Mes jetons',
    empty: 'Aucun jeton pour l’instant.',
    label: 'Jeton {name}',
    revoked: 'Révoqué',
    active: 'Actif',
    created: 'Créé {when}',
    lastUsed: 'Dernière utilisation : {when}',
    expires: 'Expiration : {when}',
    revoke: 'Révoquer',
    revokeLabel: 'Révoquer le jeton',
    revokeTitle: 'Révoquer {name} ?',
    revokeBody: 'Les sessions Claude Code utilisant ce jeton perdront l’accès immédiatement.',
    revokedToast: 'Jeton {name} révoqué',
    confirm: 'Confirmer la révocation',
  },
  create: {
    label: 'Créer un jeton',
    title: 'Créer un jeton d’accès personnel',
    hint: 'Créer un jeton personnel, puis exécuter la commande <code>claude mcp add</code> générée.',
    name: 'Nom du jeton',
    days: 'Expire dans (jours, facultatif)',
    submit: 'Créer le jeton',
    shownOnce:
      'Cette commande contient ton jeton et ne s’affiche qu’une fois. La copier maintenant.',
  },
  mcp: {
    copy: 'Copier la commande',
    copied: 'Commande copiée',
  },
} satisfies Catalog<typeof en>;
