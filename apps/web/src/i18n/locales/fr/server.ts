import type en from '../en/server.ts';
import type { Catalog } from '../../types.ts';

export default {
  page: {
    title: 'Mon serveur',
    lede: 'Les machines qui exécutent des tâches avec ton abonnement Claude. Mettre l’une d’elles en pause empêche le démarrage de nouvelles tâches dessus.',
    machines: 'Mes machines',
    loading: 'Chargement des machines…',
    empty: 'Aucune machine pour l’instant. Générer une commande d’installation ci-dessus.',
  },
  toast: {
    resumed: '{machine} reprise',
    paused: '{machine} mise en pause',
    revoked: '{machine} révoquée',
  },
  revoke: {
    label: 'Révoquer la machine',
    title: 'Révoquer {machine} ?',
    body: 'L’agent sera déconnecté et ses identifiants invalidés. Pour réutiliser cette machine, il faudra installer à nouveau l’agent.',
    confirm: 'Confirmer la révocation',
  },
  agent: {
    online: 'En ligne',
    offline: 'Hors ligne',
    version: 'Version {version}',
    versionUnknown: 'inconnue',
    lastSeen: 'Vue {when}',
    pausedNotice: 'En pause : aucune nouvelle tâche ne démarrera sur cette machine',
    pauseLabel: 'Mettre {machine} en pause',
    revokeLabel: 'Révoquer {machine}',
    pause: 'Mettre en pause',
    resume: 'Reprendre',
    revoke: 'Révoquer',
  },
  time: {
    never: 'jamais',
    justNow: 'à l’instant',
    secondsAgo: 'il y a {n} s',
    minutesAgo: 'il y a {n} min',
    hoursAgo: 'il y a {n} h',
    daysAgo: 'il y a {n} j',
  },
  claude: {
    rejected: 'Claude a rejeté le jeton (401){where} : exécuter <code>orch login</code>',
    noToken: 'Aucun jeton Claude{where} : exécuter <code>orch login</code>',
    expired: 'La connexion à Claude a expiré{where} : exécuter <code>orch login</code>',
    couldNotVerify: 'Vérification impossible ({error}) {when}',
    verified: 'Connexion à Claude vérifiée {when}',
    notVerified: 'Connexion à Claude pas encore vérifiée : exécuter <code>orch doctor</code>',
    notConnected: 'Claude : non connecté : exécuter <code>orch login</code>',
  },
  usage: {
    none: 'Estimation : aucune consommation signalée pour l’instant',
    estimate: 'Estimation',
    tokens: '≈ {tokens} jetons dans la fenêtre de 5 h',
    marginUnknown: 'marge inconnue',
    margin: 'marge ≈ {margin} %',
    resetsAt: 'réinitialisation à {time}',
    rateLimitedUntil: 'Limite de débit atteinte jusqu’à {time}',
  },
  update: {
    requested: 'Mise à jour demandée',
    deferred: 'En attente de la fin des tâches en cours',
    pulling: 'Téléchargement de la v{version}',
    restarting: 'Redémarrage…',
    failed: 'Échec de la mise à jour : {detail}',
    unknownError: 'erreur inconnue',
    done: 'Mise à jour effectuée',
    statusLabel: 'État de la mise à jour de {machine}',
    now: 'Mettre à jour maintenant',
    nowLabel: 'Mettre à jour {machine} maintenant',
    whenIdle: 'Mettre à jour quand l’agent est inactif',
    whenIdleLabel: 'Mettre à jour {machine} quand l’agent est inactif',
    manual:
      'L’agent est hors ligne ou trop ancien pour la mise à jour en un clic : le mettre à jour manuellement',
    available: 'v{version} · mise à jour disponible : v{latest}',
    upToDate: 'À jour',
  },
  install: {
    generateNew: 'Générer une nouvelle commande',
    generate: 'Générer la commande d’installation',
    shownOnce:
      'Affichée une seule fois : cette commande contient un jeton à usage unique. La copier maintenant, elle ne pourra pas être affichée à nouveau.',
    installs:
      'Cette commande installe l’agent, connecte ton compte Claude et ajoute la commande <code>orch</code>.',
    expired: 'Jeton expiré. En générer un nouveau.',
    expiresIn: 'Expire dans {time}',
    label: 'Installer l’agent',
    title: 'Installer l’agent',
    intro:
      'Exécuter une commande sur la machine qui dispose de ton abonnement Claude. Docker est requis.',
    afterwards: 'Ensuite',
    afterwardsHint:
      'Utiliser <code>orch status</code> pour vérifier l’agent, <code>{take}</code> pour prendre une tâche et <code>{login}</code> pour se reconnecter à Claude si besoin.',
  },
} satisfies Catalog<typeof en>;
