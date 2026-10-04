/**
 * Soriya — remise à zéro complète (Mailing + WhatsApp).
 *
 *   reinitialiserSoriya() → à lancer UNE fois depuis l'éditeur (fichier Maintenance.gs).
 *
 * 1. Mailing : vide le « Journal Soriya » et met à la corbeille les PDF déjà archivés
 *    (ils seront re-téléchargés depuis Gmail, où les mails d'origine restent intacts).
 * 2. WhatsApp : WhatsApp ne permet pas de re-télécharger les anciens messages, donc AUCUN PDF
 *    n'est supprimé. Tous les PDF (archivés, « À vérifier », mis de côté) sont remis dans
 *    « Soriya - Entrée WhatsApp » sous leur nom WhatsApp d'origine ; les copies identiques
 *    (même contenu) partent à la corbeille, il n'en reste qu'un exemplaire.
 *    Le « Journal Lettres de voiture » est vidé.
 * 3. Les deux dossiers retrouvent la même structure (année/mois en cours + « À vérifier »).
 * 4. Les deux activités repartent seules, toutes les 5 minutes (Config.gs : TRIGGER_EVERY_MINUTES).
 *    Pendant 6 h, Mailing relit tout l'historique Gmail (pas seulement les 30 derniers jours).
 *
 * Les fichiers mis à la corbeille restent récupérables 30 jours dans la Corbeille de Google Drive.
 */
function reinitialiserSoriya() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // attend la fin d'un passage en cours
  try {
    // Plus de passage automatique pendant le ménage.
    desinstallerSoriya();
    desinstallerSoriyaWhatsApp();

    // ---------- Mailing ----------
    const confRoot = soriyaRootFolder_('confirmation');
    const confTrashed = soriyaTrashSubfolders_(confRoot);
    soriyaResetJournal_(confRoot, 'confirmation');
    soriyaEnsureStructure_(confRoot);
    Logger.log('Mailing : journal vidé, %s PDF archivés mis à la corbeille (re-téléchargés depuis Gmail).',
      confTrashed);

    // ---------- WhatsApp ----------
    const ldvRoot = soriyaRootFolder_('lettre_voiture');
    const inbox = soriyaWhatsAppInbox_();
    let restored = 0;
    soriyaAllFiles_(ldvRoot, true).concat(soriyaAllFiles_(inbox, false)).forEach(function (f) {
      if (!soriyaIsPdf_(f)) return;
      f.setName(soriyaWhatsAppOriginalName_(f));
      f.moveTo(inbox);
      restored++;
    });
    // Les sous-dossiers vidés (années, mois, « À vérifier », « Doublons »…) disparaissent.
    soriyaTrashEmptySubfolders_(ldvRoot);
    soriyaTrashEmptySubfolders_(inbox);

    // Une seule copie de chaque PDF (comparaison du contenu, pas du nom).
    const seen = new Set();
    let duplicates = 0;
    soriyaWhatsAppPdfs_(inbox).forEach(function (f) {
      const hash = soriyaSha256_(f.getBlob().getBytes());
      if (seen.has(hash)) {
        f.setTrashed(true);
        duplicates++;
      } else {
        seen.add(hash);
      }
    });
    soriyaResetJournal_(ldvRoot, 'lettre_voiture');
    soriyaEnsureStructure_(ldvRoot);
    Logger.log('WhatsApp : journal vidé, %s PDF remis en traitement, %s copie(s) en double mise(s) à la corbeille.',
      restored - duplicates, duplicates);

    // ---------- Relance ----------
    PropertiesService.getScriptProperties()
      .setProperty('SORIYA_RESCAN_UNTIL', String(Date.now() + 6 * 3600 * 1000));
    PropertiesService.getScriptProperties().deleteProperty('SORIYA_DASHBOARD_STATE');
    soriyaEnsureTriggers_(true);
    Logger.log('Relance : passages toutes les %s min (Mailing et WhatsApp en parallèle). Tableau de bord : %s',
      SORIYA_CONFIG.TRIGGER_EVERY_MINUTES, soriyaDashboardFile_().getUrl());
  } finally {
    lock.releaseLock();
  }
}

// ---------- Outils de maintenance ----------

/** Vide un journal (onglets « Journal » et « Doublons ») et réécrit les en-têtes à jour. */
function soriyaResetJournal_(root, typeKey) {
  const j = soriyaJournalSpreadsheet_(root, typeKey);
  [j.main, j.dup].forEach(function (sh) {
    sh.clear();
    sh.getRange(1, 1, 1, j.headers.length).setValues([j.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
}

/** Met à la corbeille tous les sous-dossiers (et leur contenu). Renvoie le nombre de PDF concernés. */
function soriyaTrashSubfolders_(root) {
  let count = 0;
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    count += soriyaAllFiles_(f, true).filter(soriyaIsPdf_).length;
    f.setTrashed(true);
  }
  return count;
}

/** Liste les fichiers d'un dossier ; avec deep = true, uniquement ceux de ses sous-dossiers (récursif). */
function soriyaAllFiles_(folder, deep) {
  const out = [];
  if (!deep) {
    const sub = folder.getFolders();
    while (sub.hasNext()) {
      const files = sub.next().getFiles();
      while (files.hasNext()) out.push(files.next());
    }
    return out;
  }
  const stack = [];
  const top = folder.getFolders();
  while (top.hasNext()) stack.push(top.next());
  while (stack.length) {
    const f = stack.pop();
    const files = f.getFiles();
    while (files.hasNext()) out.push(files.next());
    const subs = f.getFolders();
    while (subs.hasNext()) stack.push(subs.next());
  }
  return out;
}

function soriyaTrashEmptySubfolders_(root) {
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    soriyaTrashEmptySubfolders_(f);
    if (!f.getFiles().hasNext() && !f.getFolders().hasNext()) f.setTrashed(true);
  }
}

function soriyaIsPdf_(f) {
  return f.getMimeType() === 'application/pdf' || /\.pdf$/i.test(f.getName());
}

/** Retrouve le nom WA_<expéditeur>_<horodatage>_<nom>.pdf d'un PDF déjà renommé par Soriya. */
function soriyaWhatsAppOriginalName_(f) {
  if (/^WA_/.test(f.getName())) return f.getName();
  const desc = f.getDescription() || '';
  const line = function (label) {
    const m = new RegExp('^' + label + ' : (.*)$', 'm').exec(desc);
    return m ? m[1].trim() : '';
  };
  if (line('Nom WhatsApp')) return line('Nom WhatsApp');
  const sender = line('De').replace(/\D/g, '') || '0';
  const received = Date.parse(line('Reçu le')) || f.getDateCreated().getTime();
  const original = line('Fichier d\'origine') || f.getName();
  return 'WA_' + sender + '_' + Math.floor(received / 1000) + '_' + original;
}

// ---------- Mises à jour ponctuelles (exécutées une seule fois, automatiquement) ----------

/** Appelé au début de chaque passage Mailing : applique les mises à jour pas encore faites. */
function soriyaMigrations_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SORIYA_MIG_CONFIRMATION_NAMES_V2') !== 'done') {
    const n = renommerConfirmations();
    props.setProperty('SORIYA_MIG_CONFIRMATION_NAMES_V2', 'done');
    Logger.log('Mise à jour : %s confirmation(s) renommée(s).', n);
  }
}

/**
 * Renomme toutes les confirmations déjà archivées au format 02-10-2026_Confirmation_affretement_662518.pdf
 * (date du document, n° d'affrètement ; _2, _3… si le nom existe déjà dans le dossier)
 * et met à jour la colonne « Nom dans Drive » du journal. Peut être relancée sans risque.
 */
function renommerConfirmations() {
  const root = soriyaRootFolder_('confirmation');
  const t = soriyaDocType_('confirmation');
  const ok = new RegExp('^\\d{2}-\\d{2}-\\d{4}_' + t.fileName.label + '_[A-Za-z0-9-]+(_\\d+)?\\.pdf$');

  // Journal : Lien Drive → ligne (pour lire le n° d'affrètement et écrire le nouveau nom).
  const j = soriyaJournalSpreadsheet_(root, 'confirmation');
  const col = function (title) { return j.headers.indexOf(title) + 1; };
  const rows = {};
  const last = j.main.getLastRow();
  if (last > 1) {
    j.main.getRange(2, 1, last - 1, j.headers.length).getValues().forEach(function (r, i) {
      const url = r[col('Lien Drive') - 1];
      if (url) rows[String(url)] = { row: i + 2, number: r[col('N° affrètement') - 1] };
    });
  }

  let renamed = 0;
  soriyaAllFiles_(root, true).filter(soriyaIsPdf_).forEach(function (f) {
    if (ok.test(f.getName())) return; // déjà au bon format
    const entry = rows[f.getUrl()] || {};
    // Données lues par Claude lors de l'archivage (gardées dans la description du fichier).
    let data = {};
    const m = /^Extraction : (.*)$/m.exec(f.getDescription() || '');
    if (m) {
      try { data = JSON.parse(m[1]); } catch (e) { /* description incomplète */ }
    }
    if (!data.numero_affretement && entry.number) data.numero_affretement = String(entry.number);

    let date = null;
    t.dateFields.some(function (k) { date = soriyaParseDate_(data[k]); return !!date; });
    if (!date) {
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(f.getName());
      const fr = /^(\d{2})-(\d{2})-(\d{4})/.exec(f.getName());
      if (iso) date = new Date(+iso[1], +iso[2] - 1, +iso[3]);
      else if (fr) date = new Date(+fr[3], +fr[2] - 1, +fr[1]);
      else date = f.getDateCreated();
    }

    const parents = f.getParents();
    const folder = parents.hasNext() ? parents.next() : root;
    const name = soriyaUniqueName_(folder, soriyaFileName_(date, data, '', 'confirmation'));
    f.setName(name);
    if (entry.row) j.main.getRange(entry.row, col('Nom dans Drive')).setValue(name);
    renamed++;
  });
  return renamed;
}

/** Appelé au début de chaque passage WhatsApp : applique les mises à jour pas encore faites. */
function soriyaWhatsAppMigrations_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SORIYA_MIG_LDV_SENDERS') !== 'done') {
    const n = corrigerExpediteursWhatsApp();
    props.setProperty('SORIYA_MIG_LDV_SENDERS', 'done');
    Logger.log('Mise à jour : %s ligne(s) du Journal Lettres de voiture corrigée(s).', n);
  }
}

/**
 * Corrige « Expéditeur », « Reçu le » et « Fichier reçu » dans le Journal Lettres de voiture à partir
 * du nom WhatsApp (les premiers PDF avaient un horodatage au format date que Soriya ne lisait pas,
 * d'où « inconnu »). Peut être relancée sans risque.
 */
function corrigerExpediteursWhatsApp() {
  const j = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const col = function (title) { return j.headers.indexOf(title) + 1; };
  let fixed = 0;
  [j.main, j.dup].forEach(function (sh) {
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const range = sh.getRange(2, 1, n, j.headers.length);
    const values = range.getValues();
    values.forEach(function (r) {
      const info = soriyaWhatsAppParseName_(String(r[col('Fichier reçu') - 1]));
      if (!info) return;
      r[col('Expéditeur') - 1] = '+' + info.sender + ' (WhatsApp)';
      if (info.date) r[col('Reçu le') - 1] = info.date;
      r[col('Fichier reçu') - 1] = info.originalName;
      fixed++;
    });
    range.setValues(values);
  });
  return fixed;
}
