/**
 * Soriya — agent IA d'archivage des confirmations d'affrètement.
 * Configuration centrale. Modifiez uniquement ce fichier pour adapter Soriya.
 */
const SORIYA_CONFIG = {
  // Libellé (dossier) Gmail surveillé.
  GMAIL_LABEL: 'ecotime',

  // Libellé ajouté aux conversations traitées (repère visuel dans Gmail).
  PROCESSED_LABEL: 'ecotime/Archivé par Soriya',

  // Fenêtre de recherche : Soriya ne regarde que les mails des N derniers jours.
  // Mettre une grande valeur (ex. 3650) pour la première exécution afin de rattraper l'historique.
  SEARCH_WINDOW_DAYS: 30,

  // Dossier racine dans Google Drive (créé automatiquement s'il n'existe pas).
  DRIVE_ROOT_FOLDER: "Ecotime - Confirmations d'affrètement",

  // Sous-dossier pour les PDF que Soriya juge douteux (pas une confirmation, ou lecture incertaine).
  REVIEW_FOLDER: 'À vérifier',

  // Nom du Google Sheet de suivi (créé dans le dossier racine).
  JOURNAL_NAME: 'Journal Soriya',

  // Fréquence de la vérification automatique, en minutes (1, 5, 10, 15 ou 30).
  TRIGGER_EVERY_MINUTES: 15,

  // Intelligence (Claude). Si aucune clé API n'est enregistrée, Soriya archive quand même
  // les PDF, mais sans lecture ni renommage intelligent.
  CLAUDE_MODEL: 'claude-opus-5',
  CLAUDE_EFFORT: 'low', // extraction simple : 'low' reste rapide ; passer à 'medium' si besoin
  MAX_PDF_MB_FOR_AI: 20,

  // Envoyer un e-mail récapitulatif au propriétaire du script après chaque passage qui a archivé des fichiers.
  SEND_SUMMARY_EMAIL: true,

  // Marge de sécurité : Apps Script coupe une exécution à 6 minutes.
  MAX_RUNTIME_MS: 5 * 60 * 1000,
};
