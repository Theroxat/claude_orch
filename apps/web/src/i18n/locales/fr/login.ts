import type en from '../en/login.ts';
import type { Catalog } from '../../types.ts';

export default {
  lede: 'Partager sa capacité Claude Code avec son équipe.',
  signIn: 'Se connecter avec GitHub',
  facts: {
    issues: 'Les tâches sont des tickets GitHub, réunis dans un pool commun.',
    machines:
      'Chacune s’exécute sur la machine d’un membre de l’équipe, avec son propre abonnement Claude.',
    review: 'orch pousse une branche et ouvre la pull request pour relecture.',
  },
} satisfies Catalog<typeof en>;
