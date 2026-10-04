/**
 * Soriya · WhatsApp — lettres de voiture reçues sur WhatsApp → Google Drive + Journal.
 *
 * Make récupère les PDF et les photos arrivés sur le numéro WhatsApp de Soriya (API WhatsApp Business)
 * et les dépose dans le dossier « Soriya - Entrée WhatsApp » (racine de Mon Drive), nommés :
 *   WA_<numéro expéditeur>_<horodatage Unix>_<nom d'origine>.pdf   (ex. WA_33769391541_1759480000_confirmation.pdf)
 * Soriya les lit comme des lettres de voiture, les renomme et les range dans « Ecotime - Lettres de Voiture »,
 * avec leur propre journal (« Journal Lettres de voiture »).
 *
 * Fonctions à lancer depuis l'éditeur :
 *   installerSoriyaWhatsApp()    → déclencheur automatique + premier passage
 *   soriyaWhatsAppRun()          → un passage manuel
 *   apercuSoriyaWhatsApp()       → prépare les dossiers et liste ce qui attend, sans rien traiter
 *   desinstallerSoriyaWhatsApp() → arrête le déclencheur
 *   reprendreMisDeCoteWhatsApp() → reprend les PDF mis de côté (après ajout de numéros autorisés)
 */

function installerSoriyaWhatsApp() {
  soriyaEnsureTriggers_(true);
  Logger.log('Soriya · WhatsApp est en service : passages toutes les ' +
    SORIYA_CONFIG.TRIGGER_EVERY_MINUTES + ' minutes.');
  soriyaWhatsAppRun();
}

function desinstallerSoriyaWhatsApp() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'soriyaWhatsAppRun'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function apercuSoriyaWhatsApp() {
  const root = soriyaRootFolder_('lettre_voiture');
  soriyaEnsureStructure_(root);
  soriyaJournal_(root, 'lettre_voiture');
  const inbox = soriyaWhatsAppInbox_();
  const allowed = soriyaAllowedSenders_();
  let count = 0;
  soriyaWhatsAppPdfs_(inbox).forEach(function (file) {
    const info = soriyaWhatsAppParseName_(file.getName());
    const ok = !allowed.size || (info && allowed.has(info.sender));
    if (ok) count++;
    Logger.log('[%s] %s — expéditeur %s', ok ? 'À TRAITER' : 'IGNORÉ', file.getName(),
      info ? '+' + info.sender : 'inconnu (nom de fichier non reconnu)');
  });
  Logger.log('%s PDF WhatsApp en attente dans « %s ».', count, SORIYA_CONFIG.WHATSAPP_INBOX_FOLDER);
}

/**
 * Remet dans le dossier de dépôt les PDF mis de côté (« Expéditeur non autorisé »), puis relance un passage.
 * À utiliser après avoir ajouté des numéros à WHATSAPP_ALLOWED_SENDERS dans Config.gs.
 * Les PDF dont l'expéditeur n'est toujours pas autorisé retournent simplement dans « Expéditeur non autorisé ».
 */
function reprendreMisDeCoteWhatsApp() {
  const inbox = soriyaWhatsAppInbox_();
  const it = inbox.getFoldersByName('Expéditeur non autorisé');
  if (!it.hasNext()) {
    Logger.log('Aucun PDF mis de côté.');
    return;
  }
  const setAside = it.next();
  const senders = {};
  const files = setAside.getFiles();
  let count = 0;
  while (files.hasNext()) {
    const f = files.next();
    const info = soriyaWhatsAppParseName_(f.getName());
    const who = info ? '+' + info.sender : 'nom de fichier non reconnu';
    senders[who] = (senders[who] || 0) + 1;
    f.moveTo(inbox);
    count++;
  }
  Logger.log('%s PDF remis en traitement. Expéditeurs : %s', count, JSON.stringify(senders));
  Logger.log('Numéros autorisés : %s', JSON.stringify(Array.from(soriyaAllowedSenders_())));
  soriyaWhatsAppRun();
}

function soriyaWhatsAppRun() {
  if (!soriyaTryLock_('WhatsApp')) return; // un passage WhatsApp est déjà en cours
  const started = Date.now();
  let pending;
  const report = { archived: [], duplicates: 0, errors: [] };

  try {
    soriyaEnsureTriggers_();
    soriyaMarkStart_('WhatsApp');
    soriyaWhatsAppMigrations_();
    const root = soriyaRootFolder_('lettre_voiture');
    soriyaEnsureStructure_(root);
    const inbox = soriyaWhatsAppInbox_();
    const journal = soriyaJournal_(root, 'lettre_voiture');
    const allowed = soriyaAllowedSenders_();
    const aiEnabled = !!PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

    const files = soriyaWhatsAppPdfs_(inbox);
    for (let i = 0; i < files.length; i++) {
      if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) break; // la suite au prochain passage
      const file = files[i];
      try {
        const info = soriyaWhatsAppParseName_(file.getName());
        if (allowed.size && (!info || !allowed.has(info.sender))) {
          // Ni lu ni archivé : mis de côté pour que vous décidiez.
          file.moveTo(soriyaSubFolder_(inbox, ['Expéditeur non autorisé']));
          journal.append([
            new Date(), info ? info.date : file.getDateCreated(), info ? '+' + info.sender + ' (WhatsApp)' : 'inconnu',
            'WhatsApp', file.getName(), file.getName(), file.getUrl(),
            'Mis de côté — expéditeur non autorisé (Soriya - Entrée WhatsApp / Expéditeur non autorisé)',
          ].concat(soriyaEmptyFields_('lettre_voiture'), ['wa:' + file.getId(), '']));
          report.errors.push(file.getName() + ' : expéditeur non autorisé, mis de côté');
          continue;
        }
        const outcome = soriyaWhatsAppArchive_(
          file, info || { sender: 'inconnu', date: null, originalName: file.getName() },
          inbox, root, journal, aiEnabled);
        if (outcome.duplicate) report.duplicates++;
        else report.archived.push(outcome);
      } catch (e) {
        // Le fichier reste dans le dossier de dépôt → nouvel essai au prochain passage.
        report.errors.push(file.getName() + ' : ' + e.message);
      }
    }
    pending = soriyaWhatsAppPdfs_(inbox).length;
    // Documents rangés sans lecture (panne de crédit Claude…) : relus, renommés et reclassés.
    try {
      soriyaRelireNonLus_(started);
      soriyaConvertirCapturesArchivees_(started);
    } catch (e) {
      Logger.log('Reprise des documents non lus : %s', e.message);
    }
    // Confirmations : transporteur de la lettre de voiture portant le même numéro.
    try {
      soriyaRapprocherTransporteurs_();
    } catch (e) {
      Logger.log('Rapprochement confirmations / lettres de voiture : %s', e.message);
    }
    // Temps restant : on complète les anciens documents (nouvelles colonnes), par petits lots.
    if (!pending) {
      try {
        const n = soriyaBackfill_(started);
        if (n) Logger.log('Complément des anciens documents : %s ligne(s).', n);
      } catch (e) {
        Logger.log('Complément des anciens documents : %s', e.message);
        report.errors.push('Complément des anciens documents : ' + e.message);
      }
    }
  } catch (e) {
    report.errors.push('Erreur générale : ' + e.message);
  } finally {
    soriyaUnlock_('WhatsApp');
  }

  Logger.log('Soriya · WhatsApp : %s archivé(s), %s doublon(s), %s erreur(s), %s en attente.',
    report.archived.length, report.duplicates, report.errors.length, pending === undefined ? '?' : pending);
  soriyaFinish_('WhatsApp', report, { pending: pending });
}

/** Lecture IA, renommage, déplacement hors de l'entrée, ligne de journal. */
function soriyaWhatsAppArchive_(file, info, inbox, root, journal, aiEnabled) {
  const key = 'wa:' + file.getId();
  const blob = file.getBlob().setName(info.originalName);
  const hash = soriyaSha256_(blob.getBytes());
  const sender = (info.sender === 'inconnu' ? 'inconnu' : '+' + info.sender) + ' (WhatsApp)';
  const received = info.date || file.getDateCreated();
  const base = [new Date(), received, sender, 'WhatsApp', info.originalName];

  // Même PDF déjà archivé : on ne le garde pas deux fois.
  if (journal.hashes.has(hash)) {
    file.moveTo(soriyaSubFolder_(inbox, ['Doublons']));
    journal.appendDuplicate(base.concat(['', '', 'Doublon (déjà archivé)'], soriyaEmptyFields_('lettre_voiture'), [key, hash]));
    return { duplicate: true };
  }

  const photo = soriyaIsPhoto_(file);
  if (photo && !/^image\//.test(blob.getContentType())) {
    const ext = (/\.(\w+)$/.exec(info.originalName) || /\.(\w+)$/.exec(file.getName()) || [, 'jpeg'])[1].toLowerCase();
    blob.setContentType('image/' + (ext === 'jpg' ? 'jpeg' : ext));
  }
  const c = soriyaClassify_(blob, (photo ? 'Capture d\'écran / photo' : 'Document') + ' reçu(e) par WhatsApp de ' + sender,
    received, root, aiEnabled, 'lettre_voiture');
  const whatsappName = file.getName();
  c.name = soriyaUniqueName_(c.folder, c.name);
  let pdf = null;
  if (photo) {
    // Une photo est rangée comme les PDF : convertie en PDF, la photo d'origine part à la corbeille.
    pdf = soriyaPhotoToPdf_(blob, c.folder, c.name);
  }
  if (pdf) {
    file.setTrashed(true);
    file = pdf;
  } else {
    if (photo) c.name = c.name.replace(/\.pdf$/i, '.' + blob.getContentType().split('/')[1].replace('jpeg', 'jpg'));
    file.setName(c.name);
    file.moveTo(c.folder);
  }
  file.setDescription([
    'Archivé par Soriya depuis WhatsApp.',
    'De : ' + sender,
    'Reçu le : ' + received,
    'Fichier d\'origine : ' + info.originalName + (photo ? (pdf ? ' (photo convertie en PDF)' : ' (photo)') : ''),
    'Nom WhatsApp : ' + whatsappName,
    c.data ? 'Extraction : ' + JSON.stringify(c.data) : '',
  ].join('\n'));

  journal.append(base.concat([c.name, file.getUrl(), c.status], soriyaFieldsRow_(c.data, 'lettre_voiture'), [key, hash]));
  return { name: c.name, url: file.getUrl(), status: c.status };
}

// ---------- Outils WhatsApp ----------

/** Dossier de dépôt de Make, à la racine de Mon Drive (déplacé et renommé si besoin). */
function soriyaWhatsAppInbox_() {
  const driveRoot = DriveApp.getRootFolder();
  const name = SORIYA_CONFIG.WHATSAPP_INBOX_FOLDER;
  if (SORIYA_CONFIG.WHATSAPP_INBOX_FOLDER_ID) {
    const inbox = DriveApp.getFolderById(SORIYA_CONFIG.WHATSAPP_INBOX_FOLDER_ID);
    if (inbox.getName() !== name) inbox.setName(name);
    const parents = inbox.getParents();
    if (!parents.hasNext() || parents.next().getId() !== driveRoot.getId()) inbox.moveTo(driveRoot);
    return inbox;
  }
  return soriyaSubFolder_(driveRoot, [name]);
}

function soriyaWhatsAppPdfs_(inbox) {
  const out = [];
  const it = inbox.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getMimeType() === 'application/pdf' || /\.pdf$/i.test(f.getName()) || soriyaIsPhoto_(f)) out.push(f);
  }
  // Du plus ancien au plus récent, pour un journal chronologique.
  return out.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
}

/**
 * Convertit une capture d'écran / photo en PDF (une page, image pleine largeur) dans le dossier donné.
 * Renvoie le fichier PDF créé, ou null si la conversion échoue (la photo est alors gardée telle quelle).
 */
function soriyaPhotoToPdf_(blob, folder, name) {
  const attempts = [
    function () { return blob.getAs('application/pdf'); },
    function () {
      const html = '<html><body style="margin:0"><img style="width:100%" src="data:' + blob.getContentType() +
        ';base64,' + Utilities.base64Encode(blob.getBytes()) + '"></body></html>';
      return Utilities.newBlob(html, 'text/html', 'capture.html').getAs('application/pdf');
    },
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const pdf = attempts[i]();
      if (pdf && pdf.getBytes().length > 1000) return folder.createFile(pdf.setName(name));
    } catch (e) {
      Logger.log('Conversion en PDF, méthode %s : %s', i + 1, e.message);
    }
  }
  return null;
}

/**
 * Convertit en PDF les captures déjà archivées en image (.jpg, .png…) et met le journal à jour.
 * Renvoie le nombre de fichiers convertis.
 */
function soriyaConvertirCapturesArchivees_(started) {
  const j = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const n = j.main.getLastRow() - 1;
  if (n < 1) return 0;
  const iName = j.headers.indexOf('Nom dans Drive');
  const iUrl = j.headers.indexOf('Lien Drive');
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  let done = 0;
  for (let r = 0; r < rows.length; r++) {
    if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) break;
    const name = String(rows[r][iName]);
    const id = (/\/d\/([\w-]+)/.exec(String(rows[r][iUrl])) || [])[1];
    if (!id || !/\.(jpe?g|png|webp)$/i.test(name)) continue;
    try {
      const file = DriveApp.getFileById(id);
      const folder = file.getParents().next();
      const pdfName = soriyaUniqueName_(folder, name.replace(/\.\w+$/, '.pdf'));
      const pdf = soriyaPhotoToPdf_(file.getBlob(), folder, pdfName);
      if (!pdf) return done; // conversion impossible : inutile d'insister pour les autres
      pdf.setDescription(String(file.getDescription() || '').replace(' (photo)', ' (photo convertie en PDF)'));
      file.setTrashed(true);
      j.main.getRange(r + 2, iName + 1).setValue(pdfName);
      j.main.getRange(r + 2, iUrl + 1).setValue(pdf.getUrl());
      done++;
    } catch (e) {
      Logger.log('Conversion de %s : %s', name, e.message);
    }
  }
  return done;
}

/** Capture d'écran ou photo d'une lettre de voiture (JPEG, PNG, WebP) : lue comme un PDF puis archivée en PDF. */
function soriyaIsPhoto_(f) {
  return /^image\/(jpeg|png|webp)$/.test(f.getMimeType()) || /\.(jpe?g|png|webp)$/i.test(f.getName());
}

/** WA_33769391541_1759480000_confirmation.pdf → { sender, date, originalName } */
function soriyaWhatsAppParseName_(name) {
  // Le dernier « WA_<numéro>_<horodatage>_ » du nom fait foi (un nom peut avoir été préfixé deux fois).
  // Horodatage : secondes Unix (1759480000) ou date ISO (2026-10-03T16:16:20.000Z).
  const re = /WA_\+?(\d{8,15})_(\d{9,13}|\d{4}-\d{2}-\d{2}T[\d:.]+Z?)_/g;
  let m;
  let last = null;
  while ((m = re.exec(name)) !== null) last = { m: m, end: re.lastIndex };
  if (!last) return null;
  const raw = last.m[2];
  const date = /^\d+$/.test(raw) ? new Date(Number(raw) < 1e12 ? Number(raw) * 1000 : Number(raw)) : new Date(raw);
  return {
    sender: soriyaNormalizePhone_(last.m[1]),
    date: isNaN(date.getTime()) ? null : date,
    originalName: name.slice(last.end) || name,
  };
}

function soriyaAllowedSenders_() {
  return new Set(SORIYA_CONFIG.WHATSAPP_ALLOWED_SENDERS.map(soriyaNormalizePhone_));
}

/** 0769391541, +33 7 69 39 15 41, 0033769391541 → 33769391541 (format utilisé par WhatsApp). */
function soriyaNormalizePhone_(phone) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.indexOf('00') === 0) digits = digits.slice(2);
  if (digits.length === 10 && digits.charAt(0) === '0') digits = '33' + digits.slice(1);
  return digits;
}
