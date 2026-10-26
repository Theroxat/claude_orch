import type en from '../en/auth.ts';
import type { Catalog } from '../../types.ts';

export default {
  consent: {
    ariaLabel: 'Autoriser l’application',
    rejected: 'Demande d’autorisation rejetée',
    title: 'Autoriser {client}',
    body: '<strong>{client}</strong> (redirection vers <code>{host}</code>) veut utiliser les outils MCP d’orch (consulter le pool, lister, soumettre et prendre des tâches) en tant que <strong>{login}</strong>.',
    warning: 'N’approuver que si cette demande vient d’être lancée depuis Claude Code.',
    approve: 'Approuver',
    deny: 'Refuser',
  },
  confirmEmail: {
    ariaLabel: 'Confirmer l’adresse e-mail',
    doneTitle: 'Adresse e-mail confirmée',
    doneBody:
      'orch peut maintenant envoyer des notifications à <strong>{address}</strong>. Choisir les événements concernés dans les paramètres de notification.',
    settings: 'Paramètres de notification',
    title: 'Confirmer ton adresse e-mail',
    lede: 'Confirmer que orch peut t’envoyer des notifications à l’adresse ajoutée dans tes paramètres.',
    incomplete: 'Ce lien est incomplet. Utiliser le lien reçu par e-mail.',
    invalid:
      'Ce lien est invalide ou a expiré. En demander un nouveau dans les paramètres de notification.',
    confirm: 'Confirmer',
  },
} satisfies Catalog<typeof en>;
