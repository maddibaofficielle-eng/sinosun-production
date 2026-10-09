/**
 * Soriya — agent IA d'archivage des confirmations d'affrètement.
 * Configuration centrale. Modifiez uniquement ce fichier pour adapter Soriya.
 */
const SORIYA_CONFIG = {
  // Libellé (dossier) Gmail surveillé.
  GMAIL_LABEL: 'ecotime',
  // Libellés Gmail supplémentaires lus comme des confirmations / commandes (nouveaux donneurs d'ordre).
  // Appliquez le libellé « clients » aux mails de commande de vos nouveaux clients : Soriya les traite pareil.
  EXTRA_GMAIL_LABELS: ['clients'],
  // Expéditeurs dont les PDF sont traités même si le mail n'a pas reçu le libellé (filtre Gmail manquant…).
  GMAIL_SENDERS: ['ecotimegroup.com'],
  // Objectif de diversification : part maximale du CA venant du premier donneur d'ordre.
  MAX_SHARE_TOP_CLIENT: 0.8,

  // Libellé ajouté aux conversations traitées (repère visuel dans Gmail).
  PROCESSED_LABEL: 'ecotime/Archivé par Soriya',

  // Fenêtre de recherche : Soriya ne regarde que les mails des N derniers jours.
  // Mettre une grande valeur (ex. 3650) pour la première exécution afin de rattraper l'historique.
  SEARCH_WINDOW_DAYS: 30,

  // Début de l'historique traité : les mails reçus avant cette date sont ignorés
  // (ni lus par Claude, ni archivés, ni relus). Format AAAA-MM-JJ.
  HISTORY_START: '2026-01-01',

  // Relecture complète de la boîte (depuis HISTORY_START) : changer cette valeur relance une relecture
  // au prochain passage (ex. après avoir rangé d'anciens mails dans le libellé « ecotime »).
  RESCAN_REQUEST: '2026-10-06-a',

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

  // Fréquence des passages automatiques, en minutes (1, 5, 10, 15 ou 30).
  TRIGGER_EVERY_MINUTES: 5,
  // Heures des passages Gmail et WhatsApp (4 par jour). Si un passage n'a pas tout traité, une suite est
  // lancée quelques minutes après (au plus SUITE_MAX fois), au lieu d'attendre le passage suivant.
  RUN_HOURS: [0, 8, 14, 20],

  // Relances Ecotime : lettres de voiture sans confirmation (voir Relances.gs).
  // MODE 'brouillon' = mails préparés dans Gmail › Brouillons, à relire et envoyer ; 'envoi' = envoyés automatiquement.
  RELANCES: {
    ENABLED: true,
    MODE: 'brouillon',
    TO: 'info@ecotimegroup.com',
    HOUR: 8,
    SIGNATURE: ['Mohamed DIABY, Gérant', 'L\'équipe GFD LOGISTIC', '1 avenue de Verdun – 93360 Neuilly-Plaisance',
      '06 52 13 53 08 – gfd.logistic@gmail.com'],
  },
  SUITE_AFTER_MINUTES: 3,
  SUITE_MAX: 12,

  // Intelligence (Claude). Si aucune clé API n'est enregistrée, Soriya archive quand même
  // les PDF, mais sans lecture ni renommage intelligent.
  CLAUDE_MODEL: 'claude-sonnet-5-5', // bon rapport qualité/prix pour l'extraction (Opus : 'claude-opus-5-5')
  CLAUDE_EFFORT: 'low', // extraction simple : 'low' reste rapide ; passer à 'medium' si besoin
  MAX_PDF_MB_FOR_AI: 20,

  // Un seul e-mail par jour (rapport du jour), envoyé vers l'heure indiquée.
  SEND_SUMMARY_EMAIL: true,
  DAILY_REPORT_HOUR: 18,
  // Journaux et tableau de bord partagés en lecture seule avec ces adresses.
  SHARE_WITH: ['diabymohamed85@gmail.com', 'soriya.paletou@gmail.com'],
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
  // Numéros autorisés à envoyer des PDF (format 06…, 07… ou +33…).
  // Liste vide [] = tous les PDF reçus sur le WhatsApp de Soriya sont traités, quel que soit l'expéditeur.
  // Pour filtrer à nouveau, par exemple : ['0769391541', '0651516936']
  WHATSAPP_ALLOWED_SENDERS: [],
  // À qui appartiennent les pièces (tickets, factures, devis…) envoyées par chaque numéro WhatsApp.
  WHATSAPP_OWNERS: {
    '0769391541': 'CHEICK',
    '0651516936': 'MOHAMED',
    '0783794351': 'VINCENT',
    '0675640084': 'SORIYA',
  },
  // Nom du groupe WhatsApp dont les exports de discussion (.zip) sont déposés dans le dossier d'entrée.
  WHATSAPP_GROUP_NAME: 'Lettre de voiture',

  // Adresse publique de l'interface web (déploiement « Soriya interface web »).
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbw8NAz4kKY0k4aUc2VMTFNI3m_dn6LL3i1DhbCRUla1_RJUbkcQiSblA5mqUevj9qY-NA/exec',
  // Interface à accès par compte Google, sans clé (projet « Soriya - Interface », dossier soriya-web/).
  // Si renseignée, c'est elle qui est affichée dans le tableau de bord.
  // Lien court (tinyurl.com/soriya-gfd → https://script.google.com/macros/s/AKfycbzs5Y9lPhUWmcVa229rCFnTs2HIg-eBnpL33TPRt8wwpXHsfMTXHMAT7rp5KiVrAl_Y/exec).
  WEB_APP_SIMPLE_URL: 'https://tinyurl.com/soriya-gfd',

  // Complément des anciens documents (relecture des PDF archivés pour les nouvelles colonnes).
  // false = en pause.
  BACKFILL_ENABLED: true,
  // Modèle de la relecture ('' = le même que CLAUDE_MODEL). Option économique : 'claude-haiku-4-5'.
  BACKFILL_MODEL: '',

  // Marge de sécurité : Apps Script coupe une exécution à 6 minutes.
  MAX_RUNTIME_MS: 4 * 60 * 1000,
};
