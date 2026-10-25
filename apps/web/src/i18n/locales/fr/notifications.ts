import type en from '../en/notifications.ts';
import type { Catalog } from '../../types.ts';

export default {
  event: {
    task_done: {
      label: 'Tâche terminée',
      description: 'La pull request d’une tâche a été fusionnée.',
    },
    task_failed: { label: 'Tâche échouée', description: 'Une exécution a échoué ou a été perdue.' },
    task_needs_attention: {
      label: 'Attention requise',
      description: 'Une tâche ne démarre plus, ou la connexion à Claude n’est plus valide.',
    },
    pr_review: {
      label: 'Pull request à relire',
      description: 'Une pull request a été ouverte pour une tâche et attend une relecture.',
    },
    consent_request: {
      label: 'Tâche proposée',
      description: 'Une tâche attend une approbation sur mes machines.',
    },
    access_request: {
      label: 'Demande d’accès',
      description: 'Quelqu’un a demandé l’accès à ce serveur. Réservé aux administrateurs.',
    },
    participation_request: {
      label: 'Demande de participation',
      description:
        'Quelqu’un a demandé à rejoindre le pool d’un de mes projets. Réservé aux propriétaires de projet.',
    },
  },
  channel: {
    in_app: 'Dans l’application',
    email: 'E-mail',
    slack: 'Slack',
    discord: 'Discord',
    webhook: 'Webhook',
    push: 'Navigateur',
  },
  bell: {
    title: 'Notifications',
    labelUnread: {
      one: 'Notifications, {count} non lue',
      other: 'Notifications, {count} non lues',
    },
    markAllRead: 'Tout marquer comme lu',
    empty:
      'Rien pour l’instant. Les résultats des tâches et les demandes à traiter apparaissent ici.',
    unread: 'Non lue',
    settings: 'Paramètres des notifications',
  },
  settings: {
    title: 'Notifications',
    lede: 'Choisir où orch envoie les notifications quand une tâche se termine, échoue ou est en attente.',
    loading: 'Chargement des paramètres de notification…',
    whereToSend: 'Où envoyer',
    whatToSend: 'Quoi envoyer',
    event: 'Événement',
    roleAdmins: 'Admins',
    roleOwners: 'Propriétaires de projet',
    greyedHint:
      'Les canaux grisés ont besoin d’une destination ci-dessus. Enregistrer une destination pour l’activer.',
    save: 'Enregistrer les paramètres de notification',
    saved: 'Paramètres de notification enregistrés',
    saveFailed: 'Impossible d’enregistrer les paramètres',
    removeFailed: 'Impossible de supprimer la destination',
    emailRemoved: 'Adresse e-mail supprimée',
    webhookRemoved: 'Webhook supprimé',
    eventOnChannel: '{event} : {channel}',
    channelNotSetUp: '{channel} n’est pas configuré',
    send: 'Envoyer un test',
    remove: 'Supprimer',
    sendTo: 'Envoyer un test à {name}',
    removeTarget: 'Supprimer {name}',
    testSent: 'Test envoyé à {name}',
    testNotSetUp: '{name} n’est pas encore configuré',
    testFailed: 'Échec du test vers {name} : {error}',
    unknownError: 'erreur inconnue',
    replaceUrl: 'Remplacer l’URL',
    urlSet: 'Défini : <code>{hint}</code>. Coller une nouvelle URL pour la remplacer.',
    urlHidden: 'masqué',
    email: {
      label: 'Adresse e-mail',
      available: 'Les notifications sont envoyées à cette adresse une fois confirmée.',
      unavailable:
        'Ce serveur n’a pas de paramètres e-mail, l’envoi par e-mail est donc indisponible. Demander à un administrateur de les configurer.',
      verified: 'Vérifiée',
      pending: 'Confirmation en attente',
      pendingHint:
        'Rien n’est envoyé à cette adresse tant que le lien reçu par e-mail n’a pas été ouvert.',
      resend: 'Renvoyer la confirmation',
      resent: 'E-mail de confirmation envoyé. Vérifier la boîte de réception.',
      resendFailed: 'Impossible d’envoyer l’e-mail de confirmation',
    },
    slack: {
      label: 'URL du webhook entrant Slack',
      hint: 'Les messages sont publiés dans le canal pour lequel le webhook a été créé.',
    },
    discord: {
      label: 'URL du webhook Discord',
      hint: 'Les messages sont publiés dans le canal pour lequel le webhook a été créé.',
    },
    webhook: {
      label: 'URL du webhook JSON',
      hint: 'Reçoit chaque notification dans une requête POST JSON.',
    },
    inApp: { hint: 'La cloche de l’en-tête. Toujours disponible.' },
    browser: {
      enable: 'Activer les notifications du navigateur',
      notEnabled: 'Les notifications du navigateur n’ont pas été activées',
      enabled: 'Notifications du navigateur activées',
      enableFailed: 'Impossible d’activer les notifications du navigateur : {error}',
      disabled: 'Notifications du navigateur désactivées',
      disableFailed: 'Impossible de désactiver les notifications du navigateur : {error}',
      checking: 'Vérification de ce navigateur…',
      unsupported:
        'Ce navigateur ne peut pas afficher de notifications. Sur iPhone et iPad, ajouter d’abord orch à l’écran d’accueil.',
      unavailable:
        'Ce serveur n’a pas de clés push, les notifications du navigateur sont donc indisponibles. Demander à un administrateur de les configurer.',
      denied:
        'Les notifications sont bloquées pour ce site. Les autoriser dans les paramètres du navigateur pour ce site, puis réessayer.',
      off: 'Afficher une notification système sur cet appareil, même quand orch est fermé.',
      onOne: 'Ce navigateur reçoit les notifications.',
      onMany: {
        one: 'Ce navigateur est activé. {count} navigateur reçoit les notifications.',
        other: 'Ce navigateur est activé. {count} navigateurs reçoivent les notifications.',
      },
    },
  },
  push: {
    incompleteSubscription: 'Le navigateur a renvoyé un abonnement incomplet',
    workerNotInstalled: 'Le service worker des notifications push ne s’est pas installé',
    workerFailed: 'Le service worker des notifications push a échoué',
  },
} satisfies Catalog<typeof en>;
