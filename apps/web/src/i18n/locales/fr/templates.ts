import type en from '../en/templates.ts';
import type { Catalog } from '../../types.ts';

export default {
  scope: {
    builtin: 'Intégré',
    personal: 'Personnel',
    project: 'Partagé',
  },
  fill: {
    legend: 'Remplir le modèle',
    filledOf: '{filled} sur {total} remplis',
    preview: 'Aperçu',
  },
  picker: {
    start: 'Partir d’un modèle',
    using: 'Modèle utilisé : <strong>{name}</strong>',
    remove: 'Retirer le modèle',
    search: 'Rechercher un modèle',
    searchPlaceholder: 'bug, mise à jour, tests…',
    loading: 'Chargement des modèles…',
    noMatch: 'Aucun modèle ne correspond à « {query} ».',
  },
  editor: {
    copyName: '{name} (copie)',
    saved: 'Modèle « {name} » enregistré',
    nameRequired: 'Le nom est obligatoire.',
    bodyRequired: 'La description de la tâche est obligatoire.',
    titleEdit: 'Modifier le modèle',
    titleNew: 'Nouveau modèle',
    name: 'Nom',
    description: 'Description courte (facultative)',
    title: 'Titre',
    titlePlaceholder: 'Mettre à jour {package} vers {version}',
    body: 'Description de la tâche (Markdown)',
    bodyPlaceholder: '## Objectif\n\nMettre à jour `{package}` vers `{version}`.',
    bodyHint: 'Écrire {slot} à l’endroit où l’auteur d’une tâche renseigne une valeur.',
    noSlots: 'Aucun champ à remplir pour l’instant.',
    slots: 'Champs à remplir :',
    criteria: 'Critères d’acceptation (un par ligne)',
    size: 'Taille',
    model: 'Modèle',
    labels: 'Labels GitHub (séparés par des virgules, {max} au maximum)',
    askDependencies: 'Rappeler de choisir les dépendances',
    save: 'Enregistrer le modèle',
  },
  manager: {
    shared: 'Modèles partagés',
    mine: 'Mes modèles',
    new: 'Nouveau modèle',
    hintShared:
      'Toute personne pouvant soumettre des tâches à ce projet peut en démarrer une à partir de ces modèles. Seul le propriétaire peut les modifier.',
    hintMine:
      'Des squelettes pour le travail récurrent, visibles uniquement par leur auteur. Les modèles intégrés ci-dessous peuvent être copiés et adaptés.',
    loading: 'Chargement des modèles…',
    emptyTitle: 'Aucun modèle pour l’instant.',
    emptyCanManage: 'En créer un, ou copier un modèle intégré pour partir d’une bonne base.',
    emptyReadOnly: 'Le propriétaire du projet n’en a partagé aucun.',
    builtins: 'Modèles intégrés ({count})',
    copyToMine: 'Copier dans mes modèles',
    deleteLabel: 'Supprimer le modèle',
    deleteTitle: 'Supprimer « {name} » ?',
    deleteNote: 'Les tâches déjà créées à partir de ce modèle ne sont pas affectées.',
    deleteNoteShared:
      'Les tâches déjà créées à partir de ce modèle ne sont pas affectées. Les membres du projet ne le verront plus.',
    deleted: 'Modèle « {name} » supprimé',
    sizeModel: 'taille {size} / {model}',
  },
} satisfies Catalog<typeof en>;
