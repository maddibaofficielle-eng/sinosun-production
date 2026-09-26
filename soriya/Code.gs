/**
 * Soriya — boucle principale : Gmail (libellé ecotime) → Google Drive + Journal.
 *
 * Fonctions à lancer depuis l'éditeur Apps Script :
 *   installerSoriya()    → crée le déclencheur automatique et fait un premier passage
 *   soriyaRun()          → un passage manuel
 *   apercuSoriya()       → affiche dans les journaux ce qui serait traité, sans rien archiver
 *   desinstallerSoriya() → arrête le déclencheur automatique
 */

const JOURNAL_HEADERS = [
  'Traité le', 'Date du mail', 'Expéditeur', 'Objet', 'Fichier reçu', 'Nom dans Drive',
  'Lien Drive', 'Statut', 'N° affrètement', 'Date confirmation', "Donneur d'ordre",
  'Transporteur', 'Lieu chargement', 'Date chargement', 'Lieu livraison', 'Date livraison',
  'Marchandise', 'Poids', 'Immatriculation', 'Prix HT', 'Devise', 'Confiance', 'Remarques',
  'Clé', 'Empreinte SHA-256',
];

function installerSoriya() {
  desinstallerSoriya();
  ScriptApp.newTrigger('soriyaRun')
    .timeBased()
    .everyMinutes(SORIYA_CONFIG.TRIGGER_EVERY_MINUTES)
    .create();
  Logger.log('Soriya est en service : vérification toutes les ' +
    SORIYA_CONFIG.TRIGGER_EVERY_MINUTES + ' minutes.');
  soriyaRun();
}

function desinstallerSoriya() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'soriyaRun'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function apercuSoriya() {
  const threads = GmailApp.search(soriyaQuery_(), 0, 50);
  const journal = soriyaJournal_(soriyaRootFolder_());
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // un passage est déjà en cours
  const started = Date.now();
  const report = { archived: [], duplicates: 0, errors: [] };

  try {
    const root = soriyaRootFolder_();
    const journal = soriyaJournal_(root);
    const doneLabel = GmailApp.getUserLabelByName(SORIYA_CONFIG.PROCESSED_LABEL) ||
      GmailApp.createLabel(SORIYA_CONFIG.PROCESSED_LABEL);
    const aiEnabled = !!PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

    // Du plus ancien au plus récent, pour un journal chronologique.
    const threads = GmailApp.search(soriyaQuery_(), 0, 100).reverse();

    for (let t = 0; t < threads.length; t++) {
      if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) break; // la suite au prochain passage
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
  } catch (e) {
    report.errors.push('Erreur générale : ' + e.message);
  } finally {
    lock.releaseLock();
  }

  Logger.log('Soriya : %s archivé(s), %s doublon(s), %s erreur(s).',
    report.archived.length, report.duplicates, report.errors.length);
  soriyaNotify_(report);
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
    journal.append(base.concat(['', '', 'Doublon (déjà archivé)'], soriyaEmptyFields_(), [key, hash]));
    return { duplicate: true };
  }

  let data = null;
  let status = 'Archivé';
  if (!aiEnabled) {
    status = 'Archivé (sans lecture IA)';
  } else if (blob.getBytes().length > SORIYA_CONFIG.MAX_PDF_MB_FOR_AI * 1024 * 1024) {
    status = 'Archivé (PDF trop lourd pour la lecture IA)';
  } else {
    try {
      data = soriyaReadPdf(blob, msg.getSubject());
    } catch (e) {
      status = 'Archivé — lecture IA impossible : ' + e.message;
    }
  }

  const toReview = data !== null && (!data.est_confirmation_affretement || data.confiance === 'basse');
  if (toReview) status = 'À vérifier — ' + (data.remarques || 'lecture incertaine');

  const refDate = soriyaParseDate_(data && (data.date_chargement || data.date_confirmation)) || msg.getDate();
  const folder = toReview
    ? soriyaSubFolder_(root, [SORIYA_CONFIG.REVIEW_FOLDER])
    : soriyaSubFolder_(root, [
      Utilities.formatDate(refDate, Session.getScriptTimeZone(), 'yyyy'),
      Utilities.formatDate(refDate, Session.getScriptTimeZone(), 'MM'),
    ]);

  const name = soriyaFileName_(refDate, data, att.getName());
  const file = folder.createFile(blob.setName(name));
  file.setDescription([
    'Archivé par Soriya depuis Gmail (' + SORIYA_CONFIG.GMAIL_LABEL + ').',
    'De : ' + msg.getFrom(),
    'Objet : ' + msg.getSubject(),
    'Fichier d\'origine : ' + att.getName(),
    data ? 'Extraction : ' + JSON.stringify(data) : '',
  ].join('\n'));

  const fields = data
    ? SORIYA_FIELDS.filter(function (f) { return f !== 'remarques'; })
      .map(function (f) { return data[f] || ''; })
      .concat([data.confiance, data.remarques || ''])
    : soriyaEmptyFields_();
  journal.append(base.concat([name, file.getUrl(), status], fields, [key, hash]));

  return { name: name, url: file.getUrl(), status: status };
}

// ---------- Gmail ----------

function soriyaQuery_() {
  // Dans la recherche Gmail, espaces et "/" d'un libellé s'écrivent avec des tirets.
  const label = SORIYA_CONFIG.GMAIL_LABEL.toLowerCase().replace(/[\s\/]+/g, '-');
  return 'label:' + label + ' has:attachment filename:pdf newer_than:' +
    SORIYA_CONFIG.SEARCH_WINDOW_DAYS + 'd';
}

function soriyaPdfs_(msg) {
  return msg.getAttachments({ includeInlineImages: false }).filter(function (att) {
    return att.getContentType() === 'application/pdf' || /\.pdf$/i.test(att.getName());
  });
}

// ---------- Drive ----------

function soriyaRootFolder_() {
  const it = DriveApp.getFoldersByName(SORIYA_CONFIG.DRIVE_ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(SORIYA_CONFIG.DRIVE_ROOT_FOLDER);
}

function soriyaSubFolder_(parent, path) {
  return path.reduce(function (folder, name) {
    const it = folder.getFoldersByName(name);
    return it.hasNext() ? it.next() : folder.createFolder(name);
  }, parent);
}

/** Ex. : 2026-09-24_TRANSPORTS-DUPONT_AF-12345.pdf */
function soriyaFileName_(date, data, originalName) {
  const day = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const parts = [day];
  if (data && data.transporteur) parts.push(data.transporteur);
  if (data && data.numero_affretement) parts.push(data.numero_affretement);
  if (parts.length === 1) parts.push(originalName.replace(/\.pdf$/i, ''));
  return parts.join('_')
    .replace(/[\\\/:*?"<>|#%]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) + '.pdf';
}

// ---------- Journal (Google Sheet) ----------

function soriyaJournal_(root) {
  const it = root.getFilesByName(SORIYA_CONFIG.JOURNAL_NAME);
  let ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(SORIYA_CONFIG.JOURNAL_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    const sh = ss.getSheets()[0];
    sh.setName('Journal');
    sh.getRange(1, 1, 1, JOURNAL_HEADERS.length).setValues([JOURNAL_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const sheet = ss.getSheets()[0];
  const keys = new Set();
  const hashes = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const keyCol = JOURNAL_HEADERS.length - 1;
    sheet.getRange(2, keyCol, lastRow - 1, 2).getValues().forEach(function (r) {
      if (r[0]) keys.add(String(r[0]));
      if (r[1]) hashes.add(String(r[1]));
    });
  }
  return {
    keys: keys,
    hashes: hashes,
    append: function (row) {
      sheet.appendRow(row);
      keys.add(String(row[row.length - 2]));
      hashes.add(String(row[row.length - 1]));
    },
  };
}

function soriyaEmptyFields_() {
  // Champs extraits (sans "remarques") + confiance + remarques
  return new Array(SORIYA_FIELDS.length + 1).fill('');
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

function soriyaNotify_(report) {
  if (!SORIYA_CONFIG.SEND_SUMMARY_EMAIL) return;
  if (!report.archived.length && !report.errors.length) return;
  const lines = ['Bonjour,', '', 'Voici le compte rendu de Soriya :', ''];
  if (report.archived.length) {
    lines.push(report.archived.length + ' confirmation(s) archivée(s) :');
    report.archived.forEach(function (a) { lines.push('• ' + a.name + ' — ' + a.status + '\n  ' + a.url); });
    lines.push('');
  }
  if (report.duplicates) lines.push(report.duplicates + ' doublon(s) ignoré(s).', '');
  if (report.errors.length) {
    lines.push('Problèmes (nouvel essai automatique au prochain passage) :');
    report.errors.forEach(function (e) { lines.push('• ' + e); });
  }
  lines.push('', '— Soriya');
  MailApp.sendEmail(
    Session.getEffectiveUser().getEmail(),
    'Soriya — ' + report.archived.length + ' confirmation(s) archivée(s)' +
      (report.errors.length ? ', ' + report.errors.length + ' problème(s)' : ''),
    lines.join('\n'));
}
