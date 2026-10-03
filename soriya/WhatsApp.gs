/**
 * Soriya · WhatsApp — lettres de voiture reçues sur WhatsApp → Google Drive + Journal.
 *
 * Make récupère les PDF arrivés sur le numéro WhatsApp de Soriya (API WhatsApp Business)
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
  desinstallerSoriyaWhatsApp();
  ScriptApp.newTrigger('soriyaWhatsAppRun')
    .timeBased()
    .everyMinutes(SORIYA_CONFIG.TRIGGER_EVERY_MINUTES)
    .create();
  Logger.log('Soriya · WhatsApp est en service : vérification toutes les ' +
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // un passage (Mailing ou WhatsApp) est déjà en cours
  const started = Date.now();
  const report = { archived: [], duplicates: 0, errors: [] };

  try {
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
  } catch (e) {
    report.errors.push('Erreur générale : ' + e.message);
  } finally {
    lock.releaseLock();
  }

  Logger.log('Soriya · WhatsApp : %s archivé(s), %s doublon(s), %s erreur(s).',
    report.archived.length, report.duplicates, report.errors.length);
  soriyaNotify_(report, 'WhatsApp');
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
    journal.append(base.concat(['', '', 'Doublon (déjà archivé)'], soriyaEmptyFields_('lettre_voiture'), [key, hash]));
    return { duplicate: true };
  }

  const c = soriyaClassify_(blob, 'Document reçu par WhatsApp de ' + sender, received, root, aiEnabled, 'lettre_voiture');
  c.name = soriyaUniqueName_(c.folder, c.name);
  file.setName(c.name);
  file.moveTo(c.folder);
  file.setDescription([
    'Archivé par Soriya depuis WhatsApp.',
    'De : ' + sender,
    'Reçu le : ' + received,
    'Fichier d\'origine : ' + info.originalName,
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
    if (f.getMimeType() === 'application/pdf' || /\.pdf$/i.test(f.getName())) out.push(f);
  }
  // Du plus ancien au plus récent, pour un journal chronologique.
  return out.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
}

/** WA_33769391541_1759480000_confirmation.pdf → { sender, date, originalName } */
function soriyaWhatsAppParseName_(name) {
  const m = /^WA_\+?(\d{8,15})_(\d{9,13})_(.+)$/.exec(name);
  if (!m) return null;
  const ts = Number(m[2]);
  return {
    sender: soriyaNormalizePhone_(m[1]),
    date: new Date(ts < 1e12 ? ts * 1000 : ts),
    originalName: m[3],
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
