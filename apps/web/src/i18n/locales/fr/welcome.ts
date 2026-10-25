import type en from '../en/welcome.ts';
import type { Catalog } from '../../types.ts';

export default {
  wizard: {
    title: {
      welcome: 'Bienvenue sur orch',
      repo: 'Ajouter ton dépôt',
      join: 'Rejoindre un projet',
      machine: 'Installer ta machine',
      claude: 'Connecter Claude sur ta machine',
      mcp: 'Connecter Claude Code (MCP)',
      done: 'Tout est prêt',
    },
    explain: {
      welcome:
        'orch partage une liste de tâches entre membres de l’équipe ; chacun exécute les tâches sur sa propre machine, avec son propre abonnement Claude.',
      repo: 'Installer la GitHub App orch sur le dépôt, puis le choisir. Il rejoint la liste de tâches partagée.',
      join: 'Choisir le projet d’un membre de l’équipe et décider quelle part de ta capacité Claude lui prêter.',
      machine:
        'L’agent exécute les tâches sur la machine qui a ton abonnement Claude. Générer la commande d’installation et l’exécuter là-bas.',
      claude:
        'Se connecter une fois à Claude sur cette machine pour que les tâches puissent s’exécuter avec ton abonnement.',
      mcp: 'Permettre à Claude Code de consulter le pool et d’y envoyer des tâches via orch.',
      done: 'Voici ce qui est configuré, et quelques commandes utiles au quotidien.',
    },
    summary: {
      github_app_installed: 'GitHub App installée',
      project_added: 'Projet ajouté ou rejoint',
      participation_set: 'Participation définie',
      agent_connected: 'Machine connectée',
      claude_connected: 'Claude connecté sur ta machine',
      mcp_connected: 'Claude Code connecté (MCP)',
    },
    exit: 'Quitter la configuration',
    logout: 'Se déconnecter',
    progress: 'Progression de la configuration',
    stepText: 'Étape {step} sur {total}',
    nav: 'Navigation de l’assistant',
    back: 'Retour',
    skip: 'Passer pour l’instant',
    continue: 'Continuer',
    finish: 'Terminer',
    alreadyDone: 'Déjà fait. Tu peux continuer.',
    chooseOwn: 'Je veux ajouter mon propre dépôt',
    chooseJoin: 'Je rejoins le projet d’un membre de l’équipe',
    both: 'Tu pourras faire les deux plus tard.',
    repo: {
      already: 'Tu as déjà un dépôt dans orch.',
      lend: 'Facultatif : prêter ta propre capacité à {name}',
      waiting: 'En attente de l’apparition des dépôts. Cette page se met à jour toute seule.',
    },
    join: {
      none: 'Aucun projet à rejoindre pour l’instant. Demander à un membre de l’équipe d’ajouter son dépôt et de t’en donner l’accès.',
      owner: 'propriétaire : {login}',
      waitingApproval:
        'En attente de l’approbation du propriétaire. Tu peux continuer, rien n’est bloqué.',
    },
    machine: {
      hint: 'Exécuter ceci sur la machine où tu développes (Docker est nécessaire).',
      waiting: 'En attente de la connexion de ta machine…',
      connected: 'Connectée',
      connectedNamed: 'Connectée : {name}',
    },
    claude: {
      intro:
        'À la fin de l’installation, il t’a été proposé de connecter Claude. Si tu as passé cette étape, exécute ceci sur ta machine :',
      machineDown: 'Ta machine n’est pas encore connectée (étape précédente).',
      waiting: 'En attente de la connexion de Claude…',
      connected: 'Claude est connecté sur ta machine',
    },
    mcp: {
      then: 'Ensuite, dans Claude Code, saisir <code>/mcp</code> → <code>orch</code> → Authenticate.',
      waiting: 'En attente de la connexion de Claude Code…',
      connected: 'Claude Code est connecté',
      tryPrompt: 'Essayer ensuite un prompt comme :',
      prompt: 'Découpe cette fonctionnalité en petites tâches et envoie-les au pool orch',
    },
    done: {
      stepDone: 'Fait',
      stepNotDone: 'Pas fait',
      backlog: 'Backlog',
      pool: 'Pool',
      projects: 'Projets',
      cheatSheet: 'Aide-mémoire',
      status: '<code>orch status</code> : vérifier ton agent',
      take: '<code>orch take {n}</code> : prendre la tâche n',
      attach: '<code>orch attach {n}</code> : suivre ou rejoindre la tâche n',
      finish: '<code>orch done {n}</code> : terminer la tâche n',
    },
  },
  card: {
    title: {
      github_app_installed: 'Installer la GitHub App',
      project_added: 'Ajouter ou rejoindre un projet',
      participation_set: 'Choisir la capacité prêtée',
      agent_connected: 'Installer ta machine',
      claude_connected: 'Connecter Claude sur ta machine',
      mcp_connected: 'Connecter Claude Code (MCP)',
    },
    explain: {
      github_app_installed:
        'La GitHub App orch permet à orch de lire les tickets et d’ouvrir des pull requests.',
      project_added:
        'Ajouter un dépôt que tu administres, ou rejoindre un projet partagé avec toi.',
      participation_set:
        'Choisir un projet et un budget pour que ta machine puisse prendre ses tâches.',
      agent_connected: 'L’agent exécute les tâches sur la machine qui a ton abonnement Claude.',
      claude_connected:
        'Se connecter une fois à Claude sur cette machine pour que les tâches puissent s’exécuter.',
      mcp_connected:
        'Permettre à Claude Code de consulter le pool et de soumettre des tâches via orch.',
    },
    show: 'Afficher les premiers pas',
    hide: 'Masquer',
    installLinkError: 'Impossible d’obtenir le lien d’installation',
    addRepo: 'Ajouter un dépôt',
    joinProject: 'Rejoindre un projet',
    runLogin: 'Exécuter <code>orch login</code> sur cette machine.',
    ariaLabel: 'Premiers pas',
    heading: 'Premiers pas',
    progress: '{done}/{total} faits',
    openWizard: 'Ouvrir l’assistant de configuration',
    allSet: 'Tout est prêt. Cette carte peut être masquée.',
    stateDone: 'Fait',
    stateUnknown: 'Inconnu',
    stateTodo: 'À faire',
    onMachine: 'sur {name}',
    loginUnverified: 'Connexion à Claude pas encore vérifiée : exécuter <code>orch doctor</code>',
    inconclusive: 'Vérification impossible ({error}) {when}',
    inconclusiveFallback: 'erreur',
    verified: 'Connexion à Claude vérifiée {when}',
  },
} satisfies Catalog<typeof en>;
