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
    PropertiesService.getScriptProperties().deleteProperty('SORIYA_MAIL_CHECKPOINT');
    PropertiesService.getScriptProperties().deleteProperty('SORIYA_RESCAN_OFFSET');
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
  const p = PropertiesService.getScriptProperties();
  // Historique limité à 2026 : la relecture repart du début, sur la nouvelle plage de recherche.
  if (p.getProperty('SORIYA_MIG_HISTORY_2026') !== 'ok') {
    if (p.getProperty('SORIYA_RESCAN_UNTIL')) p.deleteProperty('SORIYA_RESCAN_OFFSET');
    p.setProperty('SORIYA_MIG_HISTORY_2026', 'ok');
  }
  // Relecture complète demandée dans la configuration (RESCAN_REQUEST).
  if (SORIYA_CONFIG.RESCAN_REQUEST && p.getProperty('SORIYA_RESCAN_REQUEST') !== SORIYA_CONFIG.RESCAN_REQUEST) {
    p.setProperty('SORIYA_RESCAN_UNTIL', String(Date.now() + 6 * 3600 * 1000));
    p.deleteProperty('SORIYA_RESCAN_OFFSET');
    p.setProperty('SORIYA_RESCAN_REQUEST', SORIYA_CONFIG.RESCAN_REQUEST);
  }
  if (p.getProperty('SORIYA_MIG_PURGE_BEFORE_START') !== 'ok') soriyaPurgeAvantHistorique_();
  // Nouvelle adresse dans SHARE_WITH : accès aux journaux, au tableau de bord et aux prospects (interface web).
  const shareKey = JSON.stringify(SORIYA_CONFIG.SHARE_WITH || []);
  if (p.getProperty('SORIYA_SHARED_WITH') !== shareKey) {
    soriyaPartagerInterface_();
    p.setProperty('SORIYA_SHARED_WITH', shareKey);
  }
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
  // Expéditeurs « +33… » enregistrés sans apostrophe : Sheets les affichait en #ERROR!.
  const pr = PropertiesService.getScriptProperties();
  if (pr.getProperty('SORIYA_MIG_SENDER_TEXT') !== 'ok') {
    const j = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
    [j.main, j.dup].forEach(function (sh) {
      const n = sh.getLastRow() - 1;
      if (n < 1) return;
      const range = sh.getRange(2, 3, n, 1);
      const formulas = range.getFormulas();
      const values = range.getValues();
      let changed = false;
      const out = values.map(function (v, i) {
        const m = /\+?(\d{8,15})\s*\(WhatsApp\)/.exec(formulas[i][0] || '');
        if (m) { changed = true; return ["'+" + m[1] + ' (WhatsApp)']; }
        return [formulas[i][0] ? formulas[i][0] : v[0]];
      });
      if (changed) range.setValues(out);
    });
    pr.setProperty('SORIYA_MIG_SENDER_TEXT', 'ok');
  }
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
      r[col('Expéditeur') - 1] = "'+" + info.sender + ' (WhatsApp)';
      if (info.date) r[col('Reçu le') - 1] = info.date;
      r[col('Fichier reçu') - 1] = info.originalName;
      fixed++;
    });
    range.setValues(values);
  });
  return fixed;
}

// ---------- Complément des anciens documents (nouvelles colonnes) ----------

// Colonnes ajoutées après coup, à compléter en relisant les PDF déjà archivés.
const SORIYA_BACKFILL = {
  confirmation: ['prix_ht', 'attente', 'prestations'],
  lettre_voiture: ['prestations', 'transporteur'],
};

/**
 * Relit avec Claude les PDF déjà archivés pour remplir les colonnes ajoutées après coup
 * (Montant HT, Attente, Prestations réalisées, Transporteur). Seules les cellules vides sont remplies ;
 * noms et dossiers des fichiers ne changent pas. Avance par petits lots (appelé à la fin des passages
 * WhatsApp, qui sont légers) et reprend là où il s'était arrêté. Renvoie le nombre de lignes complétées.
 */
function soriyaBackfill_(started) {
  const props = PropertiesService.getScriptProperties();
  if (!SORIYA_CONFIG.BACKFILL_ENABLED) return 0;
  if (props.getProperty('SORIYA_BACKFILL_DONE') === 'v1') return 0;
  if (!props.getProperty('CLAUDE_API_KEY')) return 0;
  if (props.getProperty('SORIYA_BACKFILL_V2') !== 'ok') soriyaResetFreeFill_();
  let done = 0;
  let finished = true;
  let failures = 0;
  ['confirmation', 'lettre_voiture'].forEach(function (typeKey) {
    if (failures >= 3) { finished = false; return; }
    if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) { finished = false; return; }
    const progressKey = 'SORIYA_BACKFILL_ROW_' + typeKey;
    const t = soriyaDocType_(typeKey);
    const j = soriyaJournalSpreadsheet_(soriyaRootFolder_(typeKey), typeKey);
    const col = function (title) { return j.headers.indexOf(title) + 1; };
    const fieldCols = SORIYA_BACKFILL[typeKey].map(function (k) {
      return { key: k, col: col(t.fields.filter(function (f) { return f[0] === k; })[0][1]) };
    });
    const last = j.main.getLastRow();
    let row = Math.max(2, Number(props.getProperty(progressKey) || 2));
    for (; row <= last; row++) {
      if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) { finished = false; break; }
      const values = j.main.getRange(row, 1, 1, j.headers.length).getValues()[0];
      const status = String(values[col('Statut') - 1]);
      const url = String(values[col('Lien Drive') - 1]);
      const empty = fieldCols.filter(function (fc) { return values[fc.col - 1] === '' || values[fc.col - 1] === null; });
      const id = (/\/d\/([\w-]+)/.exec(url) || [])[1];
      if (!id || !empty.length || !(status.indexOf('Archivé') === 0 || status.indexOf('À vérifier') === 0)) continue;
      if (/lecture IA impossible|sans lecture IA/.test(status)) continue; // repris par soriyaRelireNonLus_
      const recu = values[col('Reçu le') - 1];
      if (recu instanceof Date && recu < soriyaHistoryStart_()) continue; // avant le début de l'historique
      try {
        const blob = DriveApp.getFileById(id).getBlob();
        if (blob.getBytes().length > SORIYA_CONFIG.MAX_PDF_MB_FOR_AI * 1024 * 1024) continue;
        const data = soriyaReadPdf(blob, 'Relecture d\'un document déjà archivé', typeKey, SORIYA_CONFIG.BACKFILL_MODEL);
        empty.forEach(function (fc) {
          if (data[fc.key]) j.main.getRange(row, fc.col).setValue(data[fc.key]);
        });
        done++;
        failures = 0;
      } catch (e) {
        Logger.log('Complément ligne %s (%s) : %s', row, typeKey, e.message);
        // Plusieurs échecs d'affilée = problème général (clé, modèle…) : on s'arrête sans sauter de lignes.
        if (++failures >= 3) {
          finished = false;
          props.setProperty('SORIYA_BACKFILL_LAST_ERROR', e.message);
          props.setProperty(progressKey, String(row - 2)); // on reprendra à la première ligne en échec
          break;
        }
      }
      props.setProperty(progressKey, String(row + 1));
    }
    if (row <= last) finished = false;
    else props.setProperty(progressKey, String(row));
  });
  if (finished) props.setProperty('SORIYA_BACKFILL_DONE', 'v1');
  if (failures >= 3) throw new Error(props.getProperty('SORIYA_BACKFILL_LAST_ERROR') + ' (' + done + ' ligne(s) complétée(s))');
  return done;
}

/**
 * Le complément gratuit (mots-clés tirés des Remarques, sans montants) a rempli « Prestations réalisées »
 * avant d'être retiré. On vide ces cellules et on reprend la relecture depuis le début, pour que Claude
 * les remplisse à partir du PDF (avec quantités et montants). Une seule fois.
 */
function soriyaResetFreeFill_() {
  const props = PropertiesService.getScriptProperties();
  const only = new RegExp('^\\s*(?:' + SORIYA_PRESTATIONS_RE.source + ')(?:\\s*;\\s*(?:' + SORIYA_PRESTATIONS_RE.source + '))*\\s*$', 'i');
  let cleared = 0;
  ['confirmation', 'lettre_voiture'].forEach(function (typeKey) {
    const j = soriyaJournalSpreadsheet_(soriyaRootFolder_(typeKey), typeKey);
    const n = j.main.getLastRow() - 1;
    const i = j.headers.indexOf('Prestations réalisées');
    if (n < 1 || i < 0) return;
    const range = j.main.getRange(2, i + 1, n, 1);
    const values = range.getValues().map(function (r) {
      if (r[0] && only.test(String(r[0]))) { cleared++; return ['']; }
      return r;
    });
    range.setValues(values);
    props.deleteProperty('SORIYA_BACKFILL_ROW_' + typeKey);
  });
  props.deleteProperty('SORIYA_BACKFILL_DONE');
  props.setProperty('SORIYA_BACKFILL_V2', 'ok');
  Logger.log('Complément gratuit annulé : %s cellule(s) vidée(s), relecture reprise depuis le début.', cleared);
}

// ---------- Complément gratuit (sans IA) ----------

// Prestations Ecotime reconnues dans la colonne « Remarques » déjà remplie lors de la première lecture.
const SORIYA_PRESTATIONS_RE = /\b(GV ILE DE FRANCE|GV TARIF AU KILOM[EÈ]TRE|FOURGON (?:IDF|ILE DE FRANCE)|BREAK (?:IDF|ILE DE FRANCE)|PORTEUR(?: \d+ ?T| IDF| ILE DE FRANCE)?|SEMI(?:-REMORQUE)?|MANUTENTION|HAYON|ATTENTE)\b/gi;

/**
 * Remplit gratuitement (aucun appel à Claude) « Prestations réalisées » et « Attente » des anciennes
 * lignes, à partir de la colonne « Remarques ». Seules les cellules vides sont remplies.
 * S'exécute une seule fois (propriété SORIYA_BACKFILL_FREE). Renvoie le nombre de lignes complétées.
 */
function soriyaBackfillFree_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SORIYA_BACKFILL_FREE') === 'v1') return 0;
  let done = 0;
  ['confirmation', 'lettre_voiture'].forEach(function (typeKey) {
    const j = soriyaJournalSpreadsheet_(soriyaRootFolder_(typeKey), typeKey);
    const n = j.main.getLastRow() - 1;
    if (n < 1) return;
    const iRem = j.headers.indexOf('Remarques');
    const iPre = j.headers.indexOf('Prestations réalisées');
    const iAtt = j.headers.indexOf('Attente');
    if (iRem < 0 || iPre < 0) return;
    const range = j.main.getRange(2, 1, n, j.headers.length);
    const rows = range.getValues();
    const pre = [], att = [];
    rows.forEach(function (r) {
      const rem = String(r[iRem] || '');
      let p = r[iPre];
      let a = iAtt >= 0 ? r[iAtt] : '';
      let changed = false;
      if (p === '' || p === null) {
        const seen = {};
        (rem.match(SORIYA_PRESTATIONS_RE) || []).forEach(function (m) { seen[m.toUpperCase()] = true; });
        const list = Object.keys(seen);
        if (list.length) { p = list.join(' ; '); changed = true; }
      }
      if (iAtt >= 0 && (a === '' || a === null)) {
        const m = /attente[^.;]*?(\d+\s?h\s?\d*|\d+\s?min|\d+(?:[.,]\d+)?\s?€)/i.exec(rem);
        if (m) { a = m[1].trim(); changed = true; }
      }
      if (changed) done++;
      pre.push([p]);
      att.push([a]);
    });
    j.main.getRange(2, iPre + 1, n, 1).setValues(pre);
    if (iAtt >= 0) j.main.getRange(2, iAtt + 1, n, 1).setValues(att);
  });
  props.setProperty('SORIYA_BACKFILL_FREE', 'v1');
  Logger.log('Complément gratuit : %s ligne(s) complétée(s)', done);
  return done;
}

/** À lancer à la main si besoin : refait le complément gratuit (cellules vides seulement). */
function completerColonnesGratuit() {
  PropertiesService.getScriptProperties().deleteProperty('SORIYA_BACKFILL_FREE');
  Logger.log('%s ligne(s) complétée(s)', soriyaBackfillFree_());
}

// ---------- Rapprochement confirmation ↔ lettre de voiture ----------

const SORIYA_NO_LDV = 'Aucune lettre de voiture';

/**
 * Remplit la colonne « Transporteur » du journal des confirmations : pour chaque confirmation, Soriya
 * cherche la lettre de voiture qui porte le même numéro (N° affrètement = N° lettre de voiture) et
 * recopie son transporteur ; sinon « Aucune lettre de voiture ». Recalculé à chaque passage (rapide :
 * deux lectures de feuille, une écriture seulement si quelque chose a changé). Renvoie le nombre de
 * confirmations rapprochées.
 */
function soriyaRapprocherTransporteurs_() {
  const digits = function (x) { return String(x || '').replace(/\D/g, ''); };
  const ldv = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const byNumber = {};
  const nL = ldv.main.getLastRow() - 1;
  if (nL > 0) {
    const iNum = ldv.headers.indexOf('N° lettre de voiture');
    const iTr = ldv.headers.indexOf('Transporteur');
    ldv.main.getRange(2, 1, nL, ldv.headers.length).getValues().forEach(function (r) {
      const k = digits(r[iNum]);
      if (k && !byNumber[k]) byNumber[k] = String(r[iTr] || '').trim() || 'Lettre de voiture trouvée (transporteur non indiqué)';
    });
  }
  const conf = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  const nC = conf.main.getLastRow() - 1;
  if (nC < 1) return 0;
  const iNum = conf.headers.indexOf('N° affrètement');
  const iOut = conf.headers.indexOf('Transporteur');
  const numbers = conf.main.getRange(2, iNum + 1, nC, 1).getValues();
  const outRange = conf.main.getRange(2, iOut + 1, nC, 1);
  const before = outRange.getValues();
  let matched = 0;
  let changed = false;
  const after = numbers.map(function (r, i) {
    const k = digits(r[0]);
    const v = k && byNumber[k] ? byNumber[k] : (k ? SORIYA_NO_LDV : '');
    if (k && byNumber[k]) matched++;
    if (String(before[i][0]) !== v) changed = true;
    return [v];
  });
  if (changed) outRange.setValues(after);
  return matched;
}

// ---------- Reprise des documents rangés sans lecture ----------

/**
 * Relit les documents archivés sans lecture IA (clé absente, crédit épuisé, panne de l'API) :
 * Claude les lit, ils sont renommés et rangés au bon endroit, et leur ligne du journal est complétée.
 * S'arrête dès qu'une lecture échoue encore (inutile d'insister). Renvoie le nombre de documents repris.
 */
function soriyaRelireNonLus_(started, report) {
  if (!PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY')) return 0;
  let done = 0;
  const types = ['confirmation', 'lettre_voiture'];
  for (let t = 0; t < types.length; t++) {
    const typeKey = types[t];
    const root = soriyaRootFolder_(typeKey);
    const j = soriyaJournalSpreadsheet_(root, typeKey);
    const n = j.main.getLastRow() - 1;
    if (n < 1) continue;
    const col = function (title) { return j.headers.indexOf(title); };
    const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
    for (let r = 0; r < rows.length; r++) {
      if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) return done;
      const status = String(rows[r][col('Statut')]);
      if (!/^Archivé (— lecture IA impossible|\(sans lecture IA\))/.test(status)) continue;
      if (rows[r][col('Reçu le')] instanceof Date && rows[r][col('Reçu le')] < soriyaHistoryStart_()) continue;
      const id = (/\/d\/([\w-]+)/.exec(String(rows[r][col('Lien Drive')])) || [])[1];
      if (!id) continue;
      let file;
      try { file = DriveApp.getFileById(id); } catch (e) { continue; } // fichier supprimé
      if (!file.getSize()) continue; // fichier vide (réception WhatsApp incomplète) : rien à lire
      const received = rows[r][col('Reçu le')] instanceof Date ? rows[r][col('Reçu le')] : file.getDateCreated();
      const blob = file.getBlob().setName(String(rows[r][col('Fichier reçu')]) || file.getName());
      let c;
      try {
        c = soriyaClassify_(blob, String(rows[r][col('Objet')]) + ' — ' + String(rows[r][col('Expéditeur')]),
          received, root, true, typeKey);
      } catch (e) {
        report.errors.push('Reprise des documents non lus en pause : ' + e.message);
        return done;
      }
      if (!c.data) {
        // Crédit épuisé ou API indisponible : on réessaiera au prochain passage. Autre erreur : document suivant.
        if (/credit balance|HTTP (429|5\d\d)|overloaded/i.test(c.status)) {
          report.errors.push('Reprise des documents non lus en pause : ' + c.status);
          return done;
        }
        continue;
      }
      c.name = soriyaUniqueName_(c.folder, c.name);
      file.setName(c.name);
      file.moveTo(c.folder);
      const fields = soriyaFieldsRow_(c.data, typeKey);
      j.main.getRange(r + 2, col('Nom dans Drive') + 1, 1, 3).setValues([[c.name, file.getUrl(), c.status]]);
      j.main.getRange(r + 2, JOURNAL_BASE_HEADERS.length + 1, 1, fields.length).setValues([fields]);
      done++;
    }
  }
  return done;
}

// ---------- Lettres de voiture sans numéro ----------

/**
 * Une lettre de voiture sans numéro ne compte pas : sa ligne est retirée du journal et son fichier mis
 * à la corbeille de Drive (récupérable 30 jours). Les documents pas encore lus (crédit Claude épuisé…)
 * et ceux mis de côté (expéditeur non autorisé) sont gardés : ils seront relus ou décidés plus tard.
 */
function soriyaSupprimerLdvSansNumero_() {
  const j = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const n = j.main.getLastRow() - 1;
  if (n < 1) return 0;
  const col = function (title) { return j.headers.indexOf(title); };
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  let removed = 0;
  for (let r = rows.length - 1; r >= 0; r--) { // de bas en haut : les suppressions ne décalent pas les lignes restantes
    if (String(rows[r][col('N° lettre de voiture')]).trim()) continue;
    const status = String(rows[r][col('Statut')]);
    if (!/^(Archivé|À vérifier)/.test(status) || /^Archivé (— lecture IA impossible|\(sans lecture IA\))/.test(status)) continue;
    const id = (/\/d\/([\w-]+)/.exec(String(rows[r][col('Lien Drive')])) || [])[1];
    if (id) {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* fichier déjà supprimé */ }
    }
    Logger.log('Lettre de voiture sans numéro retirée : %s (%s)', rows[r][col('Nom dans Drive')], status);
    j.main.deleteRow(r + 2);
    removed++;
  }
  return removed;
}

// ---------- Retrait des confirmations reçues avant le début de l'historique ----------

/**
 * Retire du journal des confirmations les lignes reçues avant HISTORY_START (onglets Journal et
 * Doublons) et met leurs PDF à la corbeille de Drive (récupérables 30 jours), puis supprime les
 * dossiers devenus vides. Avance par lots (environ 2 min par passage) et reprend au passage suivant.
 */
function soriyaPurgeAvantHistorique_() {
  // Le passage WhatsApp écrit aussi dans ce journal (rapprochement des transporteurs) : on attend qu'il soit libre.
  if (!soriyaTryLock_('WhatsApp')) return;
  const props = PropertiesService.getScriptProperties();
  const started = Date.now();
  const budget = 2 * 60 * 1000;
  const start = soriyaHistoryStart_();
  let finished = true;
  try {
    const root = soriyaRootFolder_('confirmation');
    const j = soriyaJournalSpreadsheet_(root, 'confirmation');
    const iRecu = j.headers.indexOf('Reçu le');
    const iUrl = j.headers.indexOf('Lien Drive');
    [j.main, j.dup].forEach(function (sh) {
      const n = sh.getLastRow() - 1;
      if (n < 1 || !finished) return;
      const rows = sh.getRange(2, 1, n, j.headers.length).getValues();
      const old = [];
      rows.forEach(function (r, i) { if (r[iRecu] instanceof Date && r[iRecu] < start) old.push(i + 2); });
      // Du bas vers le haut, pour que la suppression d'une ligne ne décale pas les suivantes.
      const done = [];
      for (let k = old.length - 1; k >= 0; k--) {
        if (Date.now() - started > budget) { finished = false; break; }
        const id = (/\/d\/([\w-]+)/.exec(String(rows[old[k] - 2][iUrl])) || [])[1];
        if (id) {
          try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* déjà supprimé */ }
        }
        done.push(old[k]);
      }
      // Sheets refuse de supprimer toutes les lignes non figées : dans ce cas, on vide simplement.
      if (done.length && done.length === sh.getMaxRows() - 1) {
        sh.getRange(2, 1, n, j.headers.length).clearContent();
        done.length = 0;
      }
      // Suppression par blocs de lignes consécutives (done est trié du bas vers le haut).
      for (let k = 0; k < done.length;) {
        let end = k;
        while (end + 1 < done.length && done[end + 1] === done[end] - 1) end++;
        sh.deleteRows(done[end], k === end ? 1 : done[k] - done[end] + 1);
        k = end + 1;
      }
      Logger.log('Avant %s : %s ligne(s) retirée(s) de « %s ».', SORIYA_CONFIG.HISTORY_START, done.length, sh.getName());
    });
    if (finished) {
      soriyaTrashEmptyFolders_(root, Number(SORIYA_CONFIG.HISTORY_START.slice(0, 4)));
      props.setProperty('SORIYA_MIG_PURGE_BEFORE_START', 'ok');
    }
  } finally {
    soriyaUnlock_('WhatsApp');
  }
}

/** Met à la corbeille les dossiers d'année antérieurs à startYear qui ne contiennent plus aucun fichier. */
function soriyaTrashEmptyFolders_(root, startYear) {
  const hasFiles = function (folder) {
    if (folder.searchFiles('trashed = false').hasNext()) return true;
    const sub = folder.getFolders();
    while (sub.hasNext()) if (hasFiles(sub.next())) return true;
    return false;
  };
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (/^\d{4}$/.test(f.getName()) && Number(f.getName()) < startYear && !hasFiles(f)) f.setTrashed(true);
  }
}

// ---------- Partage des fichiers lus par l'interface web ----------

/** Journaux et tableau de bord en lecture, liste des prospects en modification, pour chaque adresse de SHARE_WITH. */
function soriyaPartagerInterface_() {
  const files = [];
  ['confirmation', 'lettre_voiture'].forEach(function (t) {
    files.push([DriveApp.getFileById(soriyaJournalSpreadsheet_(soriyaRootFolder_(t), t).ss.getId()), false]);
  });
  try { files.push([soriyaDashboardFile_(), false]); } catch (e) { Logger.log('Tableau de bord : %s', e.message); }
  try { files.push([DriveApp.getFileById(soriyaProspectsSheet_().getParent().getId()), true]); } catch (e) { Logger.log('Prospects : %s', e.message); }
  (SORIYA_CONFIG.SHARE_WITH || []).forEach(function (email) {
    files.forEach(function (f) {
      try {
        if (f[1]) f[0].addEditor(email); else f[0].addViewer(email);
      } catch (e) {
        Logger.log('Partage de %s avec %s impossible : %s', f[0].getName(), email, e.message);
      }
    });
  });
}
