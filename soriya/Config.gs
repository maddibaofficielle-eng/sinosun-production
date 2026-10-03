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

  // IMPORTANT : Soriya lit la boîte Gmail du compte Google qui a créé ce projet Apps Script.
  // Pour lire gfd.logistic@gmail.com, le projet doit être créé en étant connecté à ce compte.

  // Dossier Drive de destination, optionnel. Laisser vide ('') pour utiliser le Drive du compte
  // qui exécute Soriya. Pour ranger dans le Drive d'un AUTRE compte : partager un dossier de ce
  // compte en « Éditeur » avec gfd.logistic@gmail.com, puis coller ici l'identifiant du dossier
  // (la fin de son adresse : drive.google.com/drive/folders/<IDENTIFIANT>).
  DRIVE_FOLDER_ID: '',

  // Nom du dossier racine si DRIVE_FOLDER_ID est vide (créé automatiquement s'il n'existe pas).
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
  // Destinataire du compte rendu ('' = le compte qui exécute Soriya).
  NOTIFY_EMAIL: '',

  // ---------- Activité WhatsApp : lettres de voiture ----------
  // Dossier Drive des lettres de voiture (même principe que DRIVE_FOLDER_ID / DRIVE_ROOT_FOLDER).
  // Dossier déjà créé dans le Drive de gfd.logistic (Make y dépose les PDF par son identifiant).
  LDV_DRIVE_FOLDER_ID: '1LZam-eS359D5WGTRIu5v8r_pqX2HLgED',
  LDV_ROOT_FOLDER: 'Ecotime - Lettres de Voiture',
  LDV_JOURNAL_NAME: 'Journal Lettres de voiture',

  // Make dépose les PDF reçus sur le WhatsApp de Soriya (06 52 13 53 08) dans ce dossier de dépôt,
  // à la racine de Mon Drive, nommés WA_<expéditeur>_<horodatage>_<nom d'origine>.pdf.
  // Il reste hors de « Ecotime - Lettres de Voiture » pour que ce dossier soit rangé exactement
  // comme « Ecotime - Confirmations d'affrètement ». Make le désigne par son identifiant.
  WHATSAPP_INBOX_FOLDER: 'Soriya - Entrée WhatsApp',
  WHATSAPP_INBOX_FOLDER_ID: '1oviHzQyky-42psksAhTUEuZtnRQfKhiu',
  // Seuls les PDF envoyés par ces numéros sont traités (format 06…, 07… ou +33…).
  WHATSAPP_ALLOWED_SENDERS: ['0769391541', '0651516936'],

  // Marge de sécurité : Apps Script coupe une exécution à 6 minutes.
  MAX_RUNTIME_MS: 5 * 60 * 1000,
};
