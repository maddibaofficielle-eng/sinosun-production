/**
 * Soriya — rappel WhatsApp des lettres de voiture manquantes (chaque jour travaillé à 19 h 30).
 *
 * Du lundi au vendredi à 19 h 30, Soriya lit d'abord les lettres de voiture arrivées sur WhatsApp depuis le dernier passage, puis compare
 * les courses confirmées par Ecotime pour le jour même avec les lettres reçues. S'il en manque :
 *   - chaque chauffeur (RAPPELS_LDV.DRIVERS) reçoit sur WhatsApp ses courses du jour sans lettre (planning du site),
 *     plus les courses non affectées ;
 *   - le gérant (RAPPELS_LDV.MANAGER) reçoit le récapitulatif (manquantes, reçues par chauffeur, rappels envoyés),
 *     sur WhatsApp et par e-mail (copie à OWNER_EMAIL).
 * Les confirmations n'indiquent pas le chauffeur : c'est le planning du site (onglet « Planning ») qui le donne.
 * Une course non affectée est signalée à tous les chauffeurs (« si l'une est la vôtre… »).
 * Envoi par le scénario Make « Soriya · WhatsApp — rappels lettres de voiture » (adresse du webhook en propriété
 * de script RAPPEL_WEBHOOK, jamais dans le code publié). Historique : onglet « Rappels WhatsApp » du Journal Soriya.
 */

const SORIYA_RAPPEL_LDV = {
  SHEET: 'Rappels WhatsApp',
  HEADERS: ['Date', 'Heure', 'Destinataire', 'Téléphone', 'Courses sans lettre', 'Envoi WhatsApp', 'Message'],
  CHECK_AFTER_MINUTES: 3, // délai entre la lecture des lettres et le contrôle
  MAX_TRIES: 3,           // lectures supplémentaires si des lettres sont encore en attente de lecture
};

/** Déclencheur de 19 h 30 (RAPPELS_LDV.DAYS). Lancé à la main : contrôle forcé, même déjà fait aujourd'hui. */
function soriyaRappelLdv(e) {
  if (soriyaWrongAccount_()) return;
  const cfg = SORIYA_CONFIG.RAPPELS_LDV || {};
  if (cfg.ENABLED === false || !soriyaRappelLdvDay_(e, cfg)) return;
  const props = PropertiesService.getScriptProperties();
  if (e && e.triggerUid && props.getProperty('SORIYA_RAPPEL_LDV_DAY') === soriyaToday_()) return;
  props.setProperty('SORIYA_RAPPEL_LDV_TRY', '0');
  if (soriyaOffDuty_(e)) {
    // Jour où Soriya est à l'arrêt (vendredi) : lecture des mails d'abord (confirmations Ecotime du jour) ;
    // les lettres de voiture WhatsApp en attente sont lues par la suite, avant le contrôle.
    soriyaRun();
  } else {
    soriyaWhatsAppRun(); // lit les lettres de voiture arrivées depuis le dernier passage
  }
  soriyaRappelLdvLater_();
}

/**
 * Jour de rappel ? Ses propres jours (vendredi compris : les chauffeurs travaillent le vendredi), indépendants de
 * l'arrêt de Soriya le vendredi 0 h. Dates de DEROGATIONS et lancement manuel : toujours.
 */
function soriyaRappelLdvDay_(e, cfg) {
  if (!e || !e.triggerUid) return true;
  const tz = Session.getScriptTimeZone(), now = new Date();
  if ((SORIYA_CONFIG.DEROGATIONS || []).indexOf(Utilities.formatDate(now, tz, 'yyyy-MM-dd')) >= 0) return true;
  return (cfg.DAYS || [1, 2, 3, 4, 5]).indexOf(Number(Utilities.formatDate(now, tz, 'u'))) >= 0;
}

/** Suite programmée quelques minutes après la lecture : contrôle (ou nouvelle lecture s'il reste des lettres). */
function soriyaRappelLdvSuite() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'soriyaRappelLdvSuite') ScriptApp.deleteTrigger(t);
  });
  const props = PropertiesService.getScriptProperties();
  const tries = Number(props.getProperty('SORIYA_RAPPEL_LDV_TRY') || 0);
  const pending = soriyaWhatsAppPdfs_(soriyaWhatsAppInbox_()).length;
  if (pending && tries < SORIYA_RAPPEL_LDV.MAX_TRIES) {
    props.setProperty('SORIYA_RAPPEL_LDV_TRY', String(tries + 1));
    soriyaWhatsAppRun();
    soriyaRappelLdvLater_();
    return;
  }
  props.setProperty('SORIYA_RAPPEL_LDV_DAY', soriyaToday_());
  soriyaRappelLdvEnvoyer_(pending);
}

function soriyaRappelLdvLater_() {
  ScriptApp.newTrigger('soriyaRappelLdvSuite').timeBased().after(SORIYA_RAPPEL_LDV.CHECK_AFTER_MINUTES * 60000).create();
}

function soriyaToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Courses confirmées pour aujourd'hui sans lettre de voiture, et lettres reçues aujourd'hui par chauffeur. */
function soriyaRappelLdvData_(day) {
  const data = soriyaRelancesData_(Date.now());
  const digits = data.digits, iso = data.iso;
  const cap = function (s) { return String(s).toLowerCase().replace(/(^|[\s'(-])(\S)/g, function (m, a, b) { return a + b.toUpperCase(); }); };
  const city = function (s) { const m = /(\d{5})\s+([^,(]+)/.exec(String(s || '')); return m ? cap(m[2].trim()) + ' (' + m[1].slice(0, 2) + ')' : cap(String(s || '').split(',')[0]); };

  // Toutes les lettres de voiture archivées (quelle que soit leur date) et celles du jour par chauffeur.
  const ldv = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const lh = ldv.headers;
  const ldvNums = new Set(), byDriver = {}, routes = {};
  soriyaSheetRows_(ldv.main).forEach(function (r) {
    if (!/^Archivé/.test(String(r[lh.indexOf('Statut')]))) return;
    const n = digits(r[lh.indexOf('N° lettre de voiture')]);
    if (n.length >= 5) ldvNums.add(n);
    if ((iso(r[lh.indexOf('Date livraison')]) || iso(r[lh.indexOf('Date prise en charge')])) !== day) return;
    // Même jour, même trajet (codes postaux d'enlèvement et de livraison) : la lettre couvre la course même si
    // le numéro diffère (lettre établie sous un autre n° d'ordre, numéro mal lu sur une photo…).
    const rk = soriyaRouteKey_(r[lh.indexOf('Lieu prise en charge')], r[lh.indexOf('Lieu livraison')]);
    if (rk) routes[rk] = (routes[rk] || 0) + 1;
    const parts = String(r[lh.indexOf('Transporteur')]).split('/');
    const d = parts[parts.length - 1].trim().toUpperCase() || 'NON IDENTIFIÉ';
    byDriver[d] = (byDriver[d] || 0) + 1;
  });

  // Planning du site : chauffeur affecté à chaque course (onglet « Planning » du Sheet « Soriya - Prospects »).
  const planned = {};
  try {
    const sh = soriyaProspectsSheet_().getParent().getSheetByName('Planning');
    if (sh) soriyaSheetRows_(sh).forEach(function (r) { const n = digits(r[0]); if (n && r[1]) planned[n] = String(r[1]).toUpperCase(); });
  } catch (e) { /* onglet absent : courses non affectées */ }

  // Confirmations Ecotime pour aujourd'hui (une par numéro), hors courses déclarées non réalisées sur le site.
  const ch = data.conf.headers, seen = {}, missing = [];
  let confirmed = 0;
  soriyaSheetRows_(data.conf.main).forEach(function (r) {
    if (!/^Archivé/.test(String(r[ch.indexOf('Statut')]))) return;
    const n = digits(r[ch.indexOf('N° affrètement')]);
    if (n.length < 5 || seen[n] || iso(r[ch.indexOf('Date livraison')]) !== day || data.notDone.has(n)) return;
    seen[n] = true;
    confirmed++;
    if (ldvNums.has(n)) return;
    const rk = soriyaRouteKey_(r[ch.indexOf('Lieu chargement')], r[ch.indexOf('Lieu livraison')]);
    if (rk && routes[rk] > 0) { routes[rk]--; return; }
    missing.push({ n: n, driver: planned[n] || '', route: city(r[ch.indexOf('Lieu chargement')]) + ' → ' + city(r[ch.indexOf('Lieu livraison')]) });
  });
  return { confirmed: confirmed, missing: missing, byDriver: byDriver };
}

/** « 93150>93400 » : codes postaux d'enlèvement et de livraison ('' si l'un manque). */
function soriyaRouteKey_(from, to) {
  const cp = function (x) { const m = /\b(\d{5})\b/.exec(String(x || '')); return m ? m[1] : ''; };
  const a = cp(from), b = cp(to);
  return a && b ? a + '>' + b : '';
}

/** Documents WhatsApp encore dans le dossier d'entrée, par numéro d'expéditeur (33783794351 → 2). */
function soriyaRappelPendingBySender_() {
  const out = {};
  soriyaWhatsAppPdfs_(soriyaWhatsAppInbox_()).forEach(function (f) {
    const info = soriyaWhatsAppParseName_(f.getName());
    if (info && info.sender) out[info.sender] = (out[info.sender] || 0) + 1;
  });
  return out;
}

/** Construit et envoie les rappels du jour. @param {number} pending lettres encore en attente de lecture */
function soriyaRappelLdvEnvoyer_(pending) {
  const cfg = SORIYA_CONFIG.RAPPELS_LDV || {};
  const day = soriyaToday_();
  const fr = day.slice(8, 10) + '/' + day.slice(5, 7);
  const num = function (n) { return n.length === 6 ? n.slice(0, 3) + ' ' + n.slice(3) : n; };
  const d = soriyaRappelLdvData_(day);
  if (!d.missing.length) { Logger.log('Rappel 19 h 30 : toutes les lettres de voiture du %s sont reçues (%s course(s)).', fr, d.confirmed); return 0; }

  const line = function (m) { return '• n° ' + num(m.n) + ' — ' + m.route; };
  const free = d.missing.filter(function (m) { return !m.driver; });
  // Récapitulatif : chaque course avec son chauffeur prévu (planning du site) ou « non affectée ».
  const list = d.missing.map(function (m) { return line(m) + ' (' + (m.driver || 'non affectée') + ')'; }).join('\n');
  const sent = [], log = [];
  // Un chauffeur n'est relancé que pour SES courses (planning du site) ; les courses non affectées vont au gérant.
  // Pas de relance si des documents de ce chauffeur sont encore en cours de lecture (envoyés juste avant 19 h 30).
  let pendingBy = {};
  try { pendingBy = soriyaRappelPendingBySender_(); } catch (e) { /* dossier d'entrée illisible */ }
  const skipped = [];
  Object.keys(cfg.DRIVERS || {}).forEach(function (name) {
    const phone = cfg.DRIVERS[name];
    const mine = d.missing.filter(function (m) { return m.driver === name; });
    if (!mine.length) return; // ses courses du jour ont toutes leur lettre
    if (pendingBy[soriyaNormalizePhone_(phone)]) { skipped.push(name + ' (' + pendingBy[soriyaNormalizePhone_(phone)] + ' document(s) en cours de lecture)'); return; }
    const got = d.byDriver[name] || 0;
    const text = 'Bonjour ' + name + ',\n\n' +
      'Il est 19 h 30 et Soriya n\'a pas encore reçu la lettre de voiture de ' + (mine.length > 1 ? 'ces courses' : 'cette course') + ' d\'aujourd\'hui (' + fr + ') :\n' +
      mine.map(line).join('\n') + '\n' +
      (got ? '\n(' + got + ' lettre(s) déjà reçue(s) de votre part aujourd\'hui, merci !)\n' : '') +
      '\nSi vous l\'avez déjà envoyée, ignorez ce message. Sinon, merci d\'envoyer la lettre de voiture signée (PDF ou photo) sur ce WhatsApp.\n\nSoriya — GFD LOGISTIC';
    const ok = soriyaWhatsAppSend_(phone, text);
    if (ok) sent.push(name);
    log.push([day, new Date(), name, phone, mine.length, ok ? 'Envoyé' : 'Échec', text]);
  });

  const recap = 'Soriya — lettres de voiture du ' + fr + ' (19 h 30)\n\n' +
    'Courses confirmées aujourd\'hui : ' + d.confirmed + '\n' +
    'Lettres de voiture manquantes : ' + d.missing.length + '\n' + list + '\n\n' +
    'Lettres reçues aujourd\'hui : ' + (Object.keys(d.byDriver).map(function (k) { return k + ' ' + d.byDriver[k]; }).join(', ') || 'aucune') + '\n' +
    (pending ? pending + ' document(s) WhatsApp encore en cours de lecture.\n' : '') +
    (free.length ? free.length + ' course(s) non affectée(s) : aucun chauffeur relancé pour elles (affectez-les dans le Planning).\n' : '') +
    (skipped.length ? 'Pas de relance pour : ' + skipped.join(', ') + '.\n' : '') +
    'Rappel envoyé à : ' + (sent.join(', ') || 'personne') + '.\n\n' +
    'Détail : https://tinyurl.com/soriya-gfd';
  const mgr = cfg.MANAGER || {};
  if (mgr.PHONE) {
    const ok = soriyaWhatsAppSend_(mgr.PHONE, recap);
    log.push([day, new Date(), (mgr.NAME || 'Gérant') + ' (gérant)', mgr.PHONE, d.missing.length, ok ? 'Envoyé' : 'Échec', recap]);
  }
  // Copie e-mail au gérant : WhatsApp n'accepte un message libre que dans les 24 h suivant son dernier message.
  if (cfg.EMAIL_COPY !== false && SORIYA_CONFIG.OWNER_EMAIL) {
    try {
      MailApp.sendEmail(SORIYA_CONFIG.OWNER_EMAIL, 'Soriya — ' + d.missing.length + ' lettre(s) de voiture manquante(s) le ' + fr, recap,
        { name: 'Soriya' });
    } catch (e) { Logger.log('Copie e-mail du rappel impossible : %s', e.message); }
  }

  const conf = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  let sh = conf.ss.getSheetByName(SORIYA_RAPPEL_LDV.SHEET);
  if (!sh) {
    sh = conf.ss.insertSheet(SORIYA_RAPPEL_LDV.SHEET);
    sh.getRange(1, 1, 1, SORIYA_RAPPEL_LDV.HEADERS.length).setValues([SORIYA_RAPPEL_LDV.HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (log.length) sh.getRange(sh.getLastRow() + 1, 1, log.length, SORIYA_RAPPEL_LDV.HEADERS.length)
    .setValues(log.map(function (r) { return [r[0], r[1], r[2], "'" + r[3], r[4], r[5], r[6]]; }));
  return d.missing.length;
}

/** Envoie un message WhatsApp texte via le webhook Make. @return {boolean} accepté par Make */
function soriyaWhatsAppSend_(phone, text) {
  const hook = soriyaSecret_('RAPPEL_WEBHOOK');
  if (!hook) { Logger.log('RAPPEL_WEBHOOK absent : message WhatsApp non envoyé à %s.', phone); return false; }
  try {
    const res = UrlFetchApp.fetch(hook, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ to: phone, text: text }), muteHttpExceptions: true });
    return res.getResponseCode() < 300;
  } catch (e) {
    Logger.log('Envoi WhatsApp à %s impossible : %s', phone, e.message);
    return false;
  }
}

/**
 * Valeur secrète (propriété de script). Si elle manque, elle est reprise une fois de SORIYA_SECRETS
 * (fichier Secrets.gs envoyé à Apps Script mais jamais publié dans le dépôt) puis gardée en propriété.
 */
function soriyaSecret_(name) {
  const props = PropertiesService.getScriptProperties();
  let v = props.getProperty(name);
  if (!v && typeof SORIYA_SECRETS !== 'undefined' && SORIYA_SECRETS[name]) {
    v = SORIYA_SECRETS[name];
    props.setProperty(name, v);
  }
  return v || '';
}

/** Message de test au gérant seul (aucun chauffeur), tracé dans l'onglet « Rappels WhatsApp ». */
function soriyaTestRappelWhatsApp_() {
  const mgr = (SORIYA_CONFIG.RAPPELS_LDV || {}).MANAGER || {};
  if (!mgr.PHONE) return false;
  const text = '[TEST Soriya] Bonjour ' + (mgr.NAME || '') + ',\n\nCeci est un message de test du rappel des lettres de voiture ' +
    '(19 h 30). Si vous le lisez, l\'envoi WhatsApp fonctionne. Aucune action n\'est nécessaire.\n\nSoriya — GFD LOGISTIC';
  const ok = soriyaWhatsAppSend_(mgr.PHONE, text);
  const conf = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  let sh = conf.ss.getSheetByName(SORIYA_RAPPEL_LDV.SHEET);
  if (!sh) {
    sh = conf.ss.insertSheet(SORIYA_RAPPEL_LDV.SHEET);
    sh.getRange(1, 1, 1, SORIYA_RAPPEL_LDV.HEADERS.length).setValues([SORIYA_RAPPEL_LDV.HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.appendRow([soriyaToday_(), new Date(), (mgr.NAME || 'Gérant') + ' (test)', "'" + mgr.PHONE, 0, ok ? 'Envoyé' : 'Échec', text]);
  return ok;
}
