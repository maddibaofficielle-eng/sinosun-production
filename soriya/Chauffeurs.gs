/**
 * Soriya — espace chauffeur : page mobile ouverte par un lien personnel (sans compte Google).
 *
 * Chaque chauffeur (RAPPELS_LDV.DRIVERS + le gérant) a un lien secret …/exec?d=<jeton>, listé dans l'onglet
 * « Accès chauffeurs » du Sheet « Soriya - Prospects » (et sur la page Planning du site). Sur sa page, il voit ses
 * courses du jour (planning du site + lettres déjà reçues), envoie la lettre de voiture (photo ou PDF : déposée dans
 * le dossier d'entrée WhatsApp sous son numéro, lue au passage suivant, avancé de quelques minutes) et déclare un
 * incident (attente, refus, casse…) : onglet « Incidents » du même Sheet, e-mail au gérant.
 */

const SORIYA_DRIVER = {
  ACCESS_SHEET: 'Accès chauffeurs',
  ACCESS_HEADERS: ['Chauffeur', 'Téléphone', 'Lien espace chauffeur', 'Créé le'],
  INCIDENT_SHEET: 'Incidents',
  INCIDENT_HEADERS: ['Le', 'Date course', 'N° course', 'Chauffeur', 'Type', 'Durée (min)', 'Commentaire', 'Photo'],
  INCIDENT_TYPES: ['Attente', 'Refus de livraison', 'Casse / avarie', 'Destinataire absent / fermé', 'Retard', 'Autre'],
  INCIDENT_FOLDER: 'Incidents chauffeurs',
};

/** Jetons { jeton: "VINCENT" } (créés une fois) et onglet « Accès chauffeurs » à jour. */
function soriyaDriverTokens_() {
  const props = PropertiesService.getScriptProperties();
  const tokens = soriyaLoadJson_('SORIYA_DRIVER_TOKENS');
  const names = soriyaPlanningDrivers_();
  const has = {}; Object.keys(tokens).forEach(function (t) { has[tokens[t]] = t; });
  let changed = false;
  names.forEach(function (n) {
    if (!has[n]) { const t = Utilities.getUuid().replace(/-/g, ''); tokens[t] = n; has[n] = t; changed = true; }
  });
  const url = ScriptApp.getService().getUrl();
  const key = names.join(',') + '|' + url;
  if (!changed && props.getProperty('SORIYA_DRIVER_ACCESS_WRITTEN') === key) return tokens;
  props.setProperty('SORIYA_DRIVER_TOKENS', JSON.stringify(tokens));
  const cfg = SORIYA_CONFIG.RAPPELS_LDV || {};
  const phoneOf = function (n) { return (cfg.DRIVERS || {})[n] || ((cfg.MANAGER || {}).NAME === n ? cfg.MANAGER.PHONE : '') || ''; };
  const ss = soriyaProspectsSheet_().getParent();
  const sh = ss.getSheetByName(SORIYA_DRIVER.ACCESS_SHEET) || ss.insertSheet(SORIYA_DRIVER.ACCESS_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, SORIYA_DRIVER.ACCESS_HEADERS.length).setValues([SORIYA_DRIVER.ACCESS_HEADERS]).setFontWeight('bold');
  const rows = names.map(function (n) { return [n, "'" + phoneOf(n), url + '?d=' + has[n], new Date()]; });
  if (rows.length) sh.getRange(2, 1, rows.length, SORIYA_DRIVER.ACCESS_HEADERS.length).setValues(rows);
  props.setProperty('SORIYA_DRIVER_ACCESS_WRITTEN', key);
  return tokens;
}

/** Chauffeur du jeton, ou erreur. */
function soriyaDriverOf_(token) {
  const name = soriyaLoadJson_('SORIYA_DRIVER_TOKENS')[String(token || '')];
  if (!name) throw new Error('Lien invalide ou expiré : demandez un nouveau lien à GFD Logistic.');
  return name;
}

/** Page de l'espace chauffeur (appelée par doGet quand le lien porte ?d=). */
function soriyaDriverPage_(token) {
  let name;
  try { name = soriyaDriverOf_(token); } catch (e) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">' + e.message + '</p>').setTitle('GFD Logistic');
  }
  const t = HtmlService.createTemplateFromFile('Chauffeur');
  t.token = token;
  t.driver = name;
  t.types = SORIYA_DRIVER.INCIDENT_TYPES;
  return t.evaluate().setTitle('GFD — ' + name).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Courses du jour du chauffeur : planning, confirmations, lettres reçues, incidents. */
function soriyaDriverData(token, day) {
  const name = soriyaDriverOf_(token);
  const tz = Session.getScriptTimeZone();
  day = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? day : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const digits = function (s) { return String(s || '').replace(/\D/g, ''); };
  const iso = function (v) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v || '').slice(0, 10); };
  const hhmm = function (s, re) { const m = re.exec(String(s || '')); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''; };
  const ss = soriyaProspectsSheet_().getParent();
  const tab = function (n) { const sh = ss.getSheetByName(n); return sh ? soriyaSheetRows_(sh) : []; };
  const planned = {};
  tab('Planning').forEach(function (r) { const n = digits(r[0]); if (n && r[1]) planned[n] = String(r[1]).toUpperCase(); });

  // Lettres de voiture archivées : n° → chauffeur.
  const ldv = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const lh = ldv.headers, letters = {};
  soriyaSheetRows_(ldv.main).forEach(function (r) {
    if (!/^Archivé/.test(String(r[lh.indexOf('Statut')]))) return;
    const n = digits(r[lh.indexOf('N° lettre de voiture')]);
    const parts = String(r[lh.indexOf('Transporteur')]).split('/');
    if (n.length >= 5) letters[n] = { driver: parts[parts.length - 1].trim().toUpperCase(),
      day: iso(r[lh.indexOf('Date livraison')]) || iso(r[lh.indexOf('Date prise en charge')]),
      from: String(r[lh.indexOf('Lieu prise en charge')] || ''), to: String(r[lh.indexOf('Lieu livraison')] || '') };
  });
  // Lettres envoyées mais pas encore lues (dossier d'entrée).
  const inbox = soriyaWhatsAppPdfs_(soriyaWhatsAppInbox_()).map(function (f) { return f.getName(); }).join(' ');

  const conf = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  const ch = conf.headers, seen = {}, mine = [], free = [];
  soriyaSheetRows_(conf.main).forEach(function (r) {
    if (!/^Archivé/.test(String(r[ch.indexOf('Statut')]))) return;
    const n = digits(r[ch.indexOf('N° affrètement')]);
    const d = iso(r[ch.indexOf('Date chargement')]) || iso(r[ch.indexOf('Date livraison')]);
    if (n.length < 5 || d !== day || seen[n]) return;
    seen[n] = true;
    const rem = String(r[ch.indexOf('Remarques')] || '');
    const c = { n: n, from: String(r[ch.indexOf('Lieu chargement')] || ''), to: String(r[ch.indexOf('Lieu livraison')] || ''),
      goods: String(r[ch.indexOf('Marchandise')] || ''),
      pickup: hhmm(rem, /enl[eè]vement[^\d]{0,30}(\d{1,2})\s*[:hH]\s*(\d{2})/i),
      delivery: hhmm(rem, /livraison[^\d]{0,30}(\d{1,2})\s*[:hH]\s*(\d{2})/i),
      letter: letters[n] ? 'reçue' : inbox.indexOf(n) >= 0 ? 'en lecture' : '' };
    const who = letters[n] ? letters[n].driver : planned[n] || '';
    if (who === name) mine.push(c); else if (!who) free.push(c);
  });
  // Lettres reçues de lui ce jour-là sans confirmation correspondante.
  Object.keys(letters).forEach(function (n) {
    const l = letters[n];
    if (!seen[n] && l.driver === name && l.day === day) mine.push({ n: n, from: l.from, to: l.to, goods: '', pickup: '', delivery: '', letter: 'reçue' });
  });
  const incidents = tab(SORIYA_DRIVER.INCIDENT_SHEET).filter(function (r) { return String(r[3]) === name && iso(r[1]) === day; })
    .map(function (r) { return { n: digits(r[2]), type: String(r[4]), minutes: r[5], comment: String(r[6]) }; });
  const sort = function (a, b) { return (a.pickup || '99').localeCompare(b.pickup || '99') || a.n.localeCompare(b.n); };
  return { day: day, driver: name, mine: mine.sort(sort), free: free.sort(sort), incidents: incidents };
}

/** Le chauffeur prend une course non affectée du jour. */
function soriyaDriverClaim(token, number) {
  const name = soriyaDriverOf_(token);
  const n = String(number || '').replace(/\D/g, '');
  if (!n) throw new Error('N° de course manquant');
  const ss = soriyaProspectsSheet_().getParent();
  const sh = ss.getSheetByName('Planning') || ss.insertSheet('Planning');
  if (!sh.getLastRow()) sh.appendRow(['N° course', 'Chauffeur', 'Par', 'Le']);
  const at = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).replace(/\D/g, '') !== n) continue;
    if (vals[i][1] && String(vals[i][1]).toUpperCase() !== name) throw new Error('Course déjà affectée à ' + vals[i][1]);
    sh.getRange(i + 1, 1, 1, 4).setValues([["'" + n, name, 'espace chauffeur', at]]);
    return true;
  }
  sh.appendRow(["'" + n, name, 'espace chauffeur', at]);
  return true;
}

/** Lettre de voiture envoyée depuis l'espace chauffeur : déposée dans le dossier d'entrée WhatsApp sous son numéro. */
function soriyaDriverUpload(token, number, fileName, mime, b64) {
  const name = soriyaDriverOf_(token);
  if (!/^(image\/|application\/pdf)/.test(String(mime))) throw new Error('Envoyez une photo ou un PDF.');
  const cfg = SORIYA_CONFIG.RAPPELS_LDV || {};
  const phone = soriyaNormalizePhone_((cfg.DRIVERS || {})[name] || ((cfg.MANAGER || {}).NAME === name ? cfg.MANAGER.PHONE : '') || '0');
  const n = String(number || '').replace(/\D/g, '');
  const ext = /pdf/.test(mime) ? 'pdf' : 'jpg';
  const label = n ? 'LettreDeVoiture_' + n : 'LettreDeVoiture';
  const file = soriyaWhatsAppInbox_().createFile(
    Utilities.newBlob(Utilities.base64Decode(b64), mime, 'WA_' + phone + '_' + new Date().toISOString() + '_' + label + '.' + ext));
  file.setDescription('Envoyée par ' + name + ' depuis l\'espace chauffeur' + (fileName ? ' (' + fileName + ')' : '') + '.');
  soriyaDriverSoon_();
  return { ok: true };
}

/** Lecture des lettres avancée : passage WhatsApp dans 2 minutes (une seule suite programmée à la fois). */
function soriyaDriverSoon_() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'soriyaWhatsAppRunSuite'; });
  if (!exists) ScriptApp.newTrigger('soriyaWhatsAppRunSuite').timeBased().after(2 * 60000).create();
}

/** Incident déclaré par le chauffeur : onglet « Incidents », photo dans Drive, e-mail (et WhatsApp) au gérant. */
function soriyaDriverIncident(token, number, day, type, minutes, comment, photoMime, photoB64) {
  const name = soriyaDriverOf_(token);
  if (SORIYA_DRIVER.INCIDENT_TYPES.indexOf(type) < 0) throw new Error('Type d\'incident inconnu');
  const n = String(number || '').replace(/\D/g, '');
  const tz = Session.getScriptTimeZone();
  let photo = '';
  if (photoB64 && /^image\//.test(String(photoMime))) {
    const folder = soriyaSubFolder_(soriyaRootFolder_('lettre_voiture'), [SORIYA_DRIVER.INCIDENT_FOLDER]);
    photo = folder.createFile(Utilities.newBlob(Utilities.base64Decode(photoB64), photoMime,
      Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd_HHmm') + '_' + name + '_' + (n || 'course') + '.jpg')).getUrl();
  }
  const min = Math.max(0, Math.round(Number(minutes) || 0));
  comment = String(comment || '').slice(0, 500);
  const ss = soriyaProspectsSheet_().getParent();
  let sh = ss.getSheetByName(SORIYA_DRIVER.INCIDENT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SORIYA_DRIVER.INCIDENT_SHEET);
    sh.getRange(1, 1, 1, SORIYA_DRIVER.INCIDENT_HEADERS.length).setValues([SORIYA_DRIVER.INCIDENT_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.appendRow([new Date(), String(day || '').slice(0, 10), "'" + n, name, type, min || '', comment, photo]);
  const num = n.length === 6 ? n.slice(0, 3) + ' ' + n.slice(3) : n;
  const text = 'Soriya — incident déclaré par ' + name + '\n\nCourse n° ' + (num || '—') + ' (' + String(day || '').slice(0, 10) + ')\n' +
    'Type : ' + type + (min ? ' — ' + min + ' min' : '') + '\n' + (comment ? 'Commentaire : ' + comment + '\n' : '') + (photo ? 'Photo : ' + photo + '\n' : '') +
    '\nDétail : https://tinyurl.com/soriya-gfd';
  try { MailApp.sendEmail(SORIYA_CONFIG.OWNER_EMAIL, 'Soriya — incident ' + type + ' (' + name + ', n° ' + (num || '—') + ')', text, { name: 'Soriya' }); }
  catch (e) { Logger.log('E-mail incident : %s', e.message); }
  const mgr = (SORIYA_CONFIG.RAPPELS_LDV || {}).MANAGER || {};
  if (mgr.PHONE) soriyaWhatsAppSend_(mgr.PHONE, text);
  return { ok: true };
}
