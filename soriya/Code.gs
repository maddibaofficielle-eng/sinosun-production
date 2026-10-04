/**
 * Soriya — boucle principale : Gmail (libellé ecotime) → Google Drive + Journal.
 *
 * Fonctions à lancer depuis l'éditeur Apps Script :
 *   installerSoriya()    → crée le déclencheur automatique et fait un premier passage
 *   soriyaRun()          → un passage manuel
 *   apercuSoriya()       → affiche dans les journaux ce qui serait traité, sans rien archiver
 *   desinstallerSoriya() → arrête le déclencheur automatique
 */

// Colonnes communes à tous les journaux ; les colonnes extraites dépendent du type de document.
const JOURNAL_BASE_HEADERS = [
  'Traité le', 'Reçu le', 'Expéditeur', 'Objet', 'Fichier reçu', 'Nom dans Drive', 'Lien Drive', 'Statut',
];

function installerSoriya() {
  soriyaEnsureTriggers_(true);
  Logger.log('Soriya est en service : passages toutes les ' + SORIYA_CONFIG.TRIGGER_EVERY_MINUTES +
    ' minutes, rapport quotidien à ' + SORIYA_CONFIG.DAILY_REPORT_HOUR + ' h.');
  soriyaRun();
}

function desinstallerSoriya() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'soriyaRun'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function apercuSoriya() {
  const threads = GmailApp.search(soriyaQuery_(), 0, 50);
  const root = soriyaRootFolder_('confirmation');
  soriyaEnsureStructure_(root);
  const journal = soriyaJournal_(root, 'confirmation');
  let count = 0;
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      soriyaPdfs_(msg).forEach(function (att) {
        const key = msg.getId() + ':' + att.getName();
        const status = journal.keys.has(key) ? 'déjà archivé' : 'À TRAITER';
        if (status === 'À TRAITER') count++;
        Logger.log('[%s] %s — %s — %s', status, msg.getDate(), msg.getSubject(), att.getName());
      });
    });
  });
  Logger.log('%s PDF en attente. Recherche Gmail utilisée : %s', count, soriyaQuery_());
}

function soriyaRun() {
  if (!soriyaTryLock_('Mailing')) return; // un passage Mailing est déjà en cours
  const started = Date.now();
  const report = { archived: [], duplicates: 0, errors: [] };

  try {
    soriyaEnsureTriggers_();
    soriyaMigrations_();
    const root = soriyaRootFolder_('confirmation');
    soriyaEnsureStructure_(root);
    const journal = soriyaJournal_(root, 'confirmation');
    const doneLabel = GmailApp.getUserLabelByName(SORIYA_CONFIG.PROCESSED_LABEL) ||
      GmailApp.createLabel(SORIYA_CONFIG.PROCESSED_LABEL);
    const aiEnabled = !!PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

    // Recherche par pages de 100 conversations : rien n'est oublié, même avec un long historique.
    const query = soriyaQuery_();
    let timeUp = false;
    for (let start = 0; !timeUp; start += 100) {
     const threads = GmailApp.search(query, start, 100);
     if (!threads.length) break;
     for (let t = 0; t < threads.length; t++) {
      if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) { timeUp = true; break; } // suite au prochain passage
      const thread = threads[t];
      let threadComplete = true;

      const messages = thread.getMessages();
      for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        const pdfs = soriyaPdfs_(msg);
        for (let a = 0; a < pdfs.length; a++) {
          if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) { threadComplete = false; break; }
          const att = pdfs[a];
          const key = msg.getId() + ':' + att.getName();
          if (journal.keys.has(key)) continue;

          try {
            const outcome = soriyaArchive_(msg, att, key, root, journal, aiEnabled);
            if (outcome.duplicate) report.duplicates++;
            else report.archived.push(outcome);
          } catch (e) {
            threadComplete = false; // pas inscrit au journal → nouvel essai au prochain passage
            report.errors.push(msg.getSubject() + ' / ' + att.getName() + ' : ' + e.message);
          }
        }
      }
      if (threadComplete) thread.addLabel(doneLabel);
     }
    }
  } catch (e) {
    report.errors.push('Erreur générale : ' + e.message);
  } finally {
    soriyaUnlock_('Mailing');
  }

  Logger.log('Soriya · Mailing : %s archivé(s), %s doublon(s), %s erreur(s).',
    report.archived.length, report.duplicates, report.errors.length);
  soriyaFinish_('Mailing', report);
}

/** Archive une pièce jointe PDF : lecture IA, classement Drive, ligne de journal. */
function soriyaArchive_(msg, att, key, root, journal, aiEnabled) {
  const blob = att.copyBlob();
  const hash = soriyaSha256_(blob.getBytes());
  const base = [
    new Date(), msg.getDate(), msg.getFrom(), msg.getSubject(), att.getName(),
  ];

  // Même PDF déjà reçu dans un autre mail : on ne le stocke pas deux fois.
  if (journal.hashes.has(hash)) {
    journal.appendDuplicate(base.concat(['', '', 'Doublon (déjà archivé)'], soriyaEmptyFields_('confirmation'), [key, hash]));
    return { duplicate: true };
  }

  const c = soriyaClassify_(blob, 'Objet du mail : ' + msg.getSubject(), msg.getDate(), root, aiEnabled, 'confirmation');
  const data = c.data, status = c.status, folder = c.folder;
  const name = soriyaUniqueName_(folder, c.name);
  const file = folder.createFile(blob.setName(name));
  file.setDescription([
    'Archivé par Soriya depuis Gmail (' + SORIYA_CONFIG.GMAIL_LABEL + ').',
    'De : ' + msg.getFrom(),
    'Objet : ' + msg.getSubject(),
    'Fichier d\'origine : ' + att.getName(),
    data ? 'Extraction : ' + JSON.stringify(data) : '',
  ].join('\n'));

  journal.append(base.concat([name, file.getUrl(), status], soriyaFieldsRow_(data, 'confirmation'), [key, hash]));

  return { name: name, url: file.getUrl(), status: status };
}

/**
 * Lecture IA + choix du dossier et du nom. Partagé par toutes les activités de Soriya.
 * @return {{data: ?Object, status: string, folder: GoogleAppsScript.Drive.Folder, name: string}}
 */
function soriyaClassify_(blob, context, fallbackDate, root, aiEnabled, typeKey) {
  const t = soriyaDocType_(typeKey);
  let data = null;
  let status = 'Archivé';
  if (!aiEnabled) {
    status = 'Archivé (sans lecture IA)';
  } else if (blob.getBytes().length > SORIYA_CONFIG.MAX_PDF_MB_FOR_AI * 1024 * 1024) {
    status = 'Archivé (PDF trop lourd pour la lecture IA)';
  } else {
    try {
      data = soriyaReadPdf(blob, context, typeKey);
    } catch (e) {
      status = 'Archivé — lecture IA impossible : ' + e.message;
    }
  }

  const toReview = data !== null && (!data[t.typeFlag] || data.confiance === 'basse');
  if (toReview) status = 'À vérifier — ' + (data.remarques || 'lecture incertaine');

  let refDate = fallbackDate;
  if (data) {
    for (let i = 0; i < t.dateFields.length; i++) {
      const d = soriyaParseDate_(data[t.dateFields[i]]);
      if (d) { refDate = d; break; }
    }
  }
  const folder = toReview
    ? soriyaSubFolder_(root, [SORIYA_CONFIG.REVIEW_FOLDER])
    : soriyaSubFolder_(root, [
      Utilities.formatDate(refDate, Session.getScriptTimeZone(), 'yyyy'),
      Utilities.formatDate(refDate, Session.getScriptTimeZone(), 'MM'),
    ]);
  return { data: data, status: status, folder: folder, name: soriyaFileName_(refDate, data, blob.getName() || 'document.pdf', typeKey) };
}

/** Colonnes extraites du Journal, puis confiance et remarques. */
function soriyaFieldsRow_(data, typeKey) {
  if (!data) return soriyaEmptyFields_(typeKey);
  return soriyaDocType_(typeKey).fields
    .map(function (f) { return data[f[0]] || ''; })
    .concat([data.confiance, data.remarques || '']);
}

// ---------- Gmail ----------

function soriyaQuery_() {
  // Dans la recherche Gmail, espaces et "/" d'un libellé s'écrivent avec des tirets.
  const label = SORIYA_CONFIG.GMAIL_LABEL.toLowerCase().replace(/[\s\/]+/g, '-');
  // Après reinitialiserSoriya(), tout l'historique est relu pendant quelques heures.
  const rescanUntil = Number(PropertiesService.getScriptProperties().getProperty('SORIYA_RESCAN_UNTIL') || 0);
  const days = Date.now() < rescanUntil ? 3650 : SORIYA_CONFIG.SEARCH_WINDOW_DAYS;
  return 'label:' + label + ' has:attachment filename:pdf newer_than:' + days + 'd';
}

function soriyaPdfs_(msg) {
  return msg.getAttachments({ includeInlineImages: false }).filter(function (att) {
    return att.getContentType() === 'application/pdf' || /\.pdf$/i.test(att.getName());
  });
}

// ---------- Drive ----------

/** Dossier Drive racine d'un type de document (créé s'il n'existe pas). */
function soriyaRootFolder_(typeKey) {
  const ldv = typeKey === 'lettre_voiture';
  const id = ldv ? SORIYA_CONFIG.LDV_DRIVE_FOLDER_ID : SORIYA_CONFIG.DRIVE_FOLDER_ID;
  const name = ldv ? SORIYA_CONFIG.LDV_ROOT_FOLDER : SORIYA_CONFIG.DRIVE_ROOT_FOLDER;
  // Dossier désigné par son identifiant (partagé ou déjà existant) : on lui redonne le nom configuré.
  if (id) {
    const folder = DriveApp.getFolderById(id);
    if (folder.getName() !== name) folder.setName(name);
    return folder;
  }
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/**
 * Même rangement pour chaque dossier de documents : <année>/<mois> du mois en cours et « À vérifier ».
 * Les autres mois se créent au fil des documents archivés.
 */
function soriyaEnsureStructure_(root) {
  const now = new Date();
  soriyaSubFolder_(root, [
    Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy'),
    Utilities.formatDate(now, Session.getScriptTimeZone(), 'MM'),
  ]);
  soriyaSubFolder_(root, [SORIYA_CONFIG.REVIEW_FOLDER]);
}

/** Nom libre dans le dossier : ajoute _2, _3… si un fichier porte déjà ce nom. */
function soriyaUniqueName_(folder, name) {
  if (!folder.getFilesByName(name).hasNext()) return name;
  const base = name.replace(/\.pdf$/i, '');
  for (let i = 2; ; i++) {
    const candidate = base + '_' + i + '.pdf';
    if (!folder.getFilesByName(candidate).hasNext()) return candidate;
  }
}

function soriyaSubFolder_(parent, path) {
  return path.reduce(function (folder, name) {
    const it = folder.getFoldersByName(name);
    return it.hasNext() ? it.next() : folder.createFolder(name);
  }, parent);
}

/** Ex. : 2026-09-24_TRANSPORTS DUPONT_AF-12345.pdf (date_transporteur_numéro) */
function soriyaFileName_(date, data, originalName, typeKey) {
  const t = soriyaDocType_(typeKey);
  if (t.fileName) {
    // Ex. : 02-10-2026_Lettres_de_voiture_662518.pdf ou 02-10-2026_Confirmation_affretement_662518.pdf
    const f = t.fileName;
    const day = Utilities.formatDate(date, Session.getScriptTimeZone(), f.datePattern);
    if (!f.numberField) return day + '_' + f.label + '.pdf';
    const number = String((data && data[f.numberField]) || originalName.replace(/\.pdf$/i, ''))
      .replace(/^\s*n(?:°|o\.?|º)\s*/i, '') // « N° 662 518 » → « 662 518 »
      .replace(/[^A-Za-z0-9-]+/g, '');
    return [day, f.label, number || 'sans-numero']
      .join('_').slice(0, 150) + '.pdf';
  }
  const day = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const parts = [day];
  soriyaDocType_(typeKey).nameFields.forEach(function (f) {
    if (data && data[f]) parts.push(data[f]);
  });
  if (parts.length === 1) parts.push(originalName.replace(/\.pdf$/i, ''));
  return parts.join('_')
    .replace(/[\\\/:*?"<>|#%]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) + '.pdf';
}

// ---------- Journal (Google Sheet) ----------

function soriyaJournalHeaders_(typeKey) {
  return JOURNAL_BASE_HEADERS
    .concat(soriyaDocType_(typeKey).fields.map(function (f) { return f[1]; }))
    .concat(['Confiance', 'Remarques', 'Clé', 'Empreinte SHA-256']);
}

/** Ouvre (ou crée) le journal d'un type de document : onglet « Journal » + onglet « Doublons ». */
function soriyaJournalSpreadsheet_(root, typeKey) {
  const name = typeKey === 'lettre_voiture' ? SORIYA_CONFIG.LDV_JOURNAL_NAME : SORIYA_CONFIG.JOURNAL_NAME;
  const headers = soriyaJournalHeaders_(typeKey);
  const it = root.getFilesByName(name);
  let ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(name);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    ss.getSheets()[0].setName('Journal');
  }
  const main = ss.getSheets()[0];
  const dup = ss.getSheetByName('Doublons') || ss.insertSheet('Doublons');
  [main, dup].forEach(function (sh) {
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  return { ss: ss, main: main, dup: dup, headers: headers };
}

function soriyaJournal_(root, typeKey) {
  const j = soriyaJournalSpreadsheet_(root, typeKey);
  const keys = new Set();
  const hashes = new Set();
  const keyCol = j.headers.length - 1;
  [j.main, j.dup].forEach(function (sh) {
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;
    sh.getRange(2, keyCol, lastRow - 1, 2).getValues().forEach(function (r) {
      if (r[0]) keys.add(String(r[0]));
      if (r[1] && sh === j.main) hashes.add(String(r[1])); // seuls les fichiers réellement archivés font foi
    });
  });
  function remember(row) {
    keys.add(String(row[row.length - 2]));
    if (row[row.length - 1]) hashes.add(String(row[row.length - 1]));
  }
  return {
    keys: keys,
    hashes: hashes,
    append: function (row) { j.main.appendRow(row); remember(row); },
    appendDuplicate: function (row) { j.dup.appendRow(row); remember(row); },
  };
}

function soriyaEmptyFields_(typeKey) {
  // Champs extraits + confiance + remarques
  return new Array(soriyaDocType_(typeKey).fields.length + 2).fill('');
}

// ---------- Utilitaires ----------

function soriyaSha256_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

function soriyaParseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
