import type en from '../en/usage.ts';
import type { Catalog } from '../../types.ts';

export default {
  title: 'Consommation',
  lede: {
    admin:
      'Jetons et exécutions de tâches de tous les membres : mes propres exécutions, plus tout ce qui a tourné dans les projets dont je suis propriétaire. Tous les chiffres sont des estimations.',
    own: 'Jetons et exécutions de tâches visibles : mes propres exécutions, plus tout ce qui a tourné dans les projets dont je suis propriétaire. Tous les chiffres sont des estimations.',
  },
  na: 'n/d',
  range: {
    label: 'Période',
    d7: '7 jours',
    d30: '30 jours',
    d90: '90 jours',
    last: 'sur {days}',
  },
  loading: 'Chargement de la consommation',
  units: {
    k: '{value} k',
    m: '{value} M',
    b: '{value} Md',
  },
  tokensTitle: {
    weighted: { one: '{count} jeton pondéré', other: '{count} jetons pondérés' },
    raw: { one: '{count} jeton', other: '{count} jetons' },
  },
  cols: {
    runs: 'Exécutions',
    failed: 'Échouées',
    tokens: 'Jetons',
    day: 'Jour',
    task: 'Tâche',
  },
  runs: {
    succeeded: { one: '{count} réussie', other: '{count} réussies' },
    failed: { one: '{count} échouée', other: '{count} échouées' },
  },
  tiles: {
    tokens: 'Jetons',
    tokensNote: 'pondérés, {range}',
    runs: 'Exécutions de tâches',
    successRate: 'Taux de réussite',
    successRateNone: 'aucune exécution terminée pour l’instant',
    successRateNote: 'des exécutions terminées',
    busiest: 'Budget le plus sollicité',
    busiestNone: 'aucune participation active',
  },
  empty: {
    runs: '<strong>Aucune exécution terminée {range}.</strong> Les exécutions apparaissent ici dès qu’une tâche réussit ou échoue sur l’un de mes projets. Essayer une période plus longue.',
    range: 'Rien à afficher pour cette période.',
  },
  chart: {
    title: 'Jetons par jour',
    total: '{tokens} jetons',
    peak: 'pic de {tokens} le {day}',
    nothing: 'rien d’enregistré sur cette période',
    readout: {
      one: '{tokens} jetons, {count} exécution',
      other: '{tokens} jetons, {count} exécutions',
    },
    aria: {
      one: 'Jetons pondérés par jour sur {count} jour. Utiliser les flèches gauche et droite pour lire chaque jour.',
      other:
        'Jetons pondérés par jour sur {count} jours. Utiliser les flèches gauche et droite pour lire chaque jour.',
    },
    viewTable: 'Afficher sous forme de tableau',
    dailyUsage: 'Consommation quotidienne',
    tableCaption: 'Jetons pondérés et exécutions par jour',
  },
  budget: {
    title: 'Budget sur cette fenêtre de 5 h',
    hint: 'Ce que chaque projet a pris sur la part de capacité qui lui est allouée.',
    unknown: '{percent} % de la capacité, budget inconnu',
    used: '{used} sur {budget} ({percent} % de la capacité)',
    meter: 'Budget utilisé par {name}',
    valueUnknown: 'inconnu',
    nearLimit: 'Limite proche',
  },
  byProject: {
    title: 'Par projet',
    caption: 'Consommation par projet',
    head: 'Projet',
  },
  byMember: {
    title: 'Par membre',
    caption: 'Consommation par membre',
    head: 'Membre',
  },
  top: {
    title: 'Tâches les plus coûteuses',
    label: 'Tâches les plus coûteuses',
    caption: 'Tâches ayant consommé le plus de jetons',
  },
  split: {
    title: 'Types de jetons',
    hintAdmin: {
      one: 'Décomptes bruts de tous les agents, usage personnel inclus. Conservés {count} jour.',
      other: 'Décomptes bruts de tous les agents, usage personnel inclus. Conservés {count} jours.',
    },
    hintOwn: {
      one: 'Décomptes bruts de mes agents, usage personnel inclus. Conservés {count} jour.',
      other: 'Décomptes bruts de mes agents, usage personnel inclus. Conservés {count} jours.',
    },
    input: 'Entrée',
    output: 'Sortie',
    cacheWrite: 'Écriture du cache',
    cacheRead: 'Lecture du cache',
  },
} satisfies Catalog<typeof en>;
