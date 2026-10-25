import type en from '../en/projects.ts';
import type { Catalog } from '../../types.ts';

export default {
  list: {
    title: 'Mes projets',
    lede: 'Dépôts que je possède dans orch, qui peut les voir, et qui peut prêter de la capacité ou soumettre des tâches.',
    add: 'Ajouter un dépôt',
    emptyTitle: 'Ajouter un premier dépôt au pool',
    emptyBody:
      'Installer la GitHub App orch sur un dépôt, puis l’ajouter ici pour commencer à partager.',
    emptyAction: 'Ajouter un premier dépôt',
  },
  card: {
    private: 'privé',
    remove: 'Retirer',
    removeConfirm: 'Retirer {name} d’orch ?',
    saved: 'Paramètres de {name} enregistrés',
    removed: '{name} retiré d’orch',
    visibility: 'Visibilité',
    allUsers: 'Tous les utilisateurs d’orch sur ce serveur',
    collaboratorsOnly: 'Collaborateurs uniquement',
    allowlistOnly: 'Liste d’autorisation uniquement',
    whoParticipate: 'Qui peut participer',
    githubCollaborators: 'Collaborateurs GitHub',
    allowlist: 'Liste d’autorisation',
    whoSubmit: 'Qui peut soumettre',
    githubWrite: 'Accès en écriture GitHub ou plus',
    requireApproval: 'Exiger l’approbation des participants',
    requireApprovalHint:
      'Les nouveaux participants restent en attente tant que tu ne les as pas approuvés.',
    sharedTemplates: 'Modèles partagés',
    participateHelp: {
      GITHUB:
        'Seules les personnes collaboratrices du dépôt GitHub peuvent prêter leur capacité Claude. Les autres sont invitées à demander l’accès au propriétaire.',
      ALLOWLIST:
        'Seules les personnes explicitement autorisées sur ce serveur par le propriétaire ou un administrateur peuvent prêter leur capacité Claude, qu’elles soient ou non collaboratrices GitHub.',
      ALL_MEMBERS:
        'Tous les utilisateurs de ce serveur orch peuvent prêter leur capacité Claude à ce projet.',
    },
  },
  reject: {
    label: 'Refuser un participant',
    title: 'Refuser {login} ?',
    reason: 'Motif (facultatif, communiqué à {login})',
    tooLong: 'Le motif est limité à {max} caractères.',
    confirm: 'Confirmer le refus',
  },
  approvals: {
    heading: 'Participants en attente',
    approvalOff:
      'L’approbation est désactivée : les nouveaux participants sont actifs dès leur arrivée. Il reste possible de les refuser.',
    none: 'Aucune demande en attente.',
    approved: '{login} approuvé',
    rejected: '{login} refusé',
    backPending: '{login} est de retour dans les demandes en attente',
    budget: '{percent} %',
    previouslyRejectedOn: 'Refusé le {date}',
    previouslyRejected: 'déjà refusé',
    previouslyRejectedReason: 'déjà refusé ({reason})',
    approve: 'Approuver',
    approveAria: 'Approuver {login}',
    reject: 'Refuser',
    rejectAria: 'Refuser {login}',
    rejectedHeading: 'Membres refusés',
    rejectedBadge: 'refusé',
    undoPending: 'Annuler : remettre en attente',
    undoPendingAria: 'Annuler le refus de {login} : remettre en attente',
    undoApprove: 'Annuler : approuver',
    undoApproveAria: 'Annuler le refus de {login} : approuver',
    mode: {
      auto: 'auto',
      approval: 'approbation',
    },
  },
  owner: {
    title: 'Participer à mon pool',
    group: '{title} : {name}',
    hint: 'Facultatif. Mon agent prend alors les tâches de ce projet comme celui de n’importe quel membre, dans la limite de ce budget et de ce mode. En tant que propriétaire, je suis approuvé automatiquement.',
  },
  form: {
    participate: 'Participer',
    pendingApproval: 'En attente d’approbation du propriétaire',
    active: 'Actif',
    rejectedByOwner: 'Refusé par le propriétaire',
    ownerReason: 'Motif du propriétaire : {reason}',
    noReason: 'Le propriétaire n’a donné aucun motif.',
    askAgain: 'Enregistrer avec « Participer » coché relance la demande.',
    budget: 'Budget (% de ma capacité Claude)',
    budgetSlider: 'Curseur du budget',
    budgetInvalid: 'Le budget doit être un nombre entier compris entre 0 et 100.',
    mode: 'Mode',
    auto: 'Auto',
    autoHint: 'Les tâches démarrent sur ma machine sans me demander.',
    approval: 'Approbation',
    approvalHint:
      'J’approuve chaque demande avant que quoi que ce soit s’exécute. Recommandé pour commencer.',
    saved: 'Participation à {name} enregistrée',
    cannotCollaborator:
      'Seuls les collaborateurs GitHub de {name} peuvent rejoindre le projet. Demander au propriétaire ({owner}) de t’ajouter comme collaborateur sur GitHub, ou de définir « Qui peut participer » sur « Tous les utilisateurs d’orch sur ce serveur » dans Projets.',
    cannotBlocked:
      'Le propriétaire ({owner}) t’a empêché de rejoindre {name}. Lui demander de modifier cela dans Projets.',
    cannotAllowlist:
      'Seules les personnes de la liste d’autorisation de {name} peuvent rejoindre le projet. Demander au propriétaire ({owner}) de t’autoriser, ou de définir « Qui peut participer » sur « Tous les utilisateurs d’orch sur ce serveur » dans Projets.',
  },
  picker: {
    loading: 'Chargement des dépôts…',
    added: 'Ajouté',
    add: 'Ajouter',
    addAria: 'Ajouter {name}',
    addedToast: '{name} ajouté à orch',
    installFirst: 'Installer d’abord la GitHub App',
    installBody:
      'Se connecter avec GitHub ne donne à orch l’accès à aucun dépôt. Il faut installer la GitHub App orch sur les dépôts à ajouter au pool.',
    installApp: 'Installer la GitHub App',
    installLoading: 'Chargement du lien d’installation…',
    step1: 'Cliquer sur <b>Installer la GitHub App</b>.',
    step2: 'Choisir son compte ou son organisation.',
    step3:
      'Choisir <b>Only select repositories</b> et cocher les dépôts à mettre dans le pool (ou <b>All repositories</b>).',
    step4: 'Cliquer sur <b>Install</b>. GitHub renvoie ensuite vers orch.',
    step5: 'Cliquer sur <b>Actualiser</b> ci-dessous.',
    refresh: 'Actualiser',
    missing: 'Un dépôt manque ? <link>Installer la GitHub App</link> dessus.',
    adminNote:
      'Seuls les dépôts dont tu es administrateur sont listés : le propriétaire du projet doit être administrateur du dépôt.',
  },
  discover: {
    title: 'Découvrir',
    lede: 'Choisir les projets auxquels je prête ma capacité Claude.',
    empty: 'Aucun projet à découvrir pour l’instant.',
    owner: 'propriétaire : {login}',
    role: 'mon rôle : {role}',
    roles: {
      owner: 'propriétaire',
      submitter: 'peut soumettre',
      proposer: 'peut proposer',
      none: 'aucun',
    },
  },
} satisfies Catalog<typeof en>;
