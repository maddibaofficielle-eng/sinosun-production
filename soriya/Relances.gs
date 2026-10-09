/**
 * Soriya — relances Ecotime : lettres de voiture sans confirmation d'affrètement.
 *
 * Une fois par jour (premier passage Mailing à partir de 8 h), Soriya regroupe en UN mail les courses dont la lettre
 * de voiture a plus de 48 h et toujours pas de confirmation, lettres de voiture signées en pièces jointes.
 * Pas de relance si la course est annulée ou déjà payée au relevé Ecotime, ou cochée « Non réalisée » sur le site.
 * Rappel 7 jours après la 1re relance ; au-delà, la course passe « À traiter par téléphone ».
 * Mode « brouillon » : les mails sont préparés dans Gmail (Brouillons), vous les relisez et les envoyez vous-même.
 * Suivi : onglet « Relances » du Journal Soriya, et page « Rapprochement » de l'interface.
 */

const SORIYA_RELANCES = {
  SHEET: 'Relances',
  HEADERS: ['N° course', 'Date livraison', 'Trajet', 'Chauffeur', '1re relance', 'Rappel', 'Statut', 'Mis à jour le'],
  DELAY_HOURS: 48,       // délai après la livraison avant de relancer
  REMINDER_DAYS: 7,      // délai entre la 1re relance et le rappel
  MAX_AGE_DAYS: 45,      // au-delà, plus de relance automatique
  MAX_ATTACHMENTS: 20,
};

function soriyaRelancesSheet_(j) {
  let sh = j.ss.getSheetByName(SORIYA_RELANCES.SHEET);
  if (!sh) {
    sh = j.ss.insertSheet(SORIYA_RELANCES.SHEET);
    sh.getRange(1, 1, 1, SORIYA_RELANCES.HEADERS.length).setValues([SORIYA_RELANCES.HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Une fois par jour, à partir de 8 h. @return {number} courses relancées (1re relance + rappels) */
function soriyaRelances_() {
  const cfg = SORIYA_CONFIG.RELANCES || {};
  if (!cfg.ENABLED || !cfg.TO) return 0;
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  if (Number(Utilities.formatDate(now, tz, 'H')) < (cfg.HOUR || 8) || props.getProperty('SORIYA_RELANCES_DAY') === today) return 0;

  const digits = function (s) { return String(s || '').replace(/\D/g, ''); };
  const iso = function (v) { return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v || '').slice(0, 10); };
  const cap = function (s) { return String(s).toLowerCase().replace(/(^|[\s'(-])(\S)/g, function (m, a, b) { return a + b.toUpperCase(); }); };
  const city = function (s) { const m = /(\d{5})\s+([^,(]+)/.exec(String(s || '')); return m ? cap(m[2].trim()) + ' (' + m[1].slice(0, 2) + ')' : cap(String(s || '').split(',')[0]); };

  // Confirmations reçues.
  const conf = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  const ch = conf.headers;
  const confNums = new Set(soriyaSheetRows_(conf.main).map(function (r) { return digits(r[ch.indexOf('N° affrètement')]); }).filter(String));
  // Courses payées (ou annulées) au relevé Ecotime : rien à réclamer.
  const paid = new Set();
  const rel = conf.ss.getSheetByName('Relevés sous-traitant'), lines = conf.ss.getSheetByName('Lignes relevés');
  if (rel && lines) {
    const cur = new Set(soriyaSheetRows_(rel).filter(function (r) { return /^En vigueur/.test(String(r[12])); }).map(function (r) { return String(r[0]); }));
    soriyaSheetRows_(lines).forEach(function (l) { if (cur.has(String(l[0]))) paid.add(digits(l[2])); });
  }
  // Courses cochées « Non réalisée » sur le site.
  const notDone = new Set();
  try {
    const v = soriyaProspectsSheet_().getParent().getSheetByName('Courses vérifiées');
    if (v) soriyaSheetRows_(v).forEach(function (r) { if (String(r[1]) === 'NON') notDone.add(digits(r[0])); });
  } catch (e) { /* onglet absent */ }

  // Lettres de voiture candidates.
  const ldv = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const lh = ldv.headers;
  const cand = {};
  soriyaSheetRows_(ldv.main).forEach(function (r) {
    const n = digits(r[lh.indexOf('N° lettre de voiture')]);
    if (n.length < 5 || cand[n] || !/^Archivé/.test(String(r[lh.indexOf('Statut')]))) return;
    const d = iso(r[lh.indexOf('Date livraison')]) || iso(r[lh.indexOf('Date prise en charge')]);
    const t = new Date(d + 'T18:00:00').getTime();
    if (!d || isNaN(t) || now - t < SORIYA_RELANCES.DELAY_HOURS * 3600000 || now - t > SORIYA_RELANCES.MAX_AGE_DAYS * 86400000) return;
    const parts = String(r[lh.indexOf('Transporteur')]).split('/');
    cand[n] = { n: n, date: d, route: city(r[lh.indexOf('Lieu prise en charge')]) + ' → ' + city(r[lh.indexOf('Lieu livraison')]),
      driver: parts[parts.length - 1].trim().toUpperCase(), url: String(r[lh.indexOf('Lien Drive')]) };
  });

  // Suivi existant.
  const sh = soriyaRelancesSheet_(conf);
  const track = {};
  soriyaSheetRows_(sh).forEach(function (r, i) { track[digits(r[0])] = { row: i + 2, r1: iso(r[4]), r2: iso(r[5]), status: String(r[6]) }; });
  const stamp = Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm');
  // Clôtures : confirmation arrivée, course payée/annulée ou non réalisée.
  Object.keys(track).forEach(function (n) {
    const t = track[n];
    if (/^(Confirmation reçue|Payée|Non réalisée)/.test(t.status)) return;
    const s = confNums.has(n) ? 'Confirmation reçue' : paid.has(n) ? 'Payée au relevé Ecotime (plus besoin)' : notDone.has(n) ? 'Non réalisée (cochée sur le site)' : '';
    if (s) sh.getRange(t.row, 7, 1, 2).setValues([[s + ' — ' + stamp.slice(0, 10), stamp]]);
    else if (t.r2 && (now - new Date(t.r2 + 'T08:00:00')) > SORIYA_RELANCES.REMINDER_DAYS * 86400000 && !/téléphone/.test(t.status)) {
      sh.getRange(t.row, 7, 1, 2).setValues([['À traiter par téléphone', stamp]]);
    }
  });

  const open = Object.keys(cand).filter(function (n) { return !confNums.has(n) && !paid.has(n) && !notDone.has(n); }).sort();
  const first = open.filter(function (n) { return !track[n]; }).map(function (n) { return cand[n]; });
  const reminder = open.filter(function (n) {
    const t = track[n];
    // Une demi-journée de marge : le passage de 8 h peut tomber quelques minutes avant les 7 jours pile.
    return t && t.r1 && !t.r2 && (now - new Date(t.r1 + 'T08:00:00')) >= (SORIYA_RELANCES.REMINDER_DAYS - 0.5) * 86400000;
  }).map(function (n) { return cand[n]; });

  const mode = cfg.MODE === 'envoi' ? 'Envoyée' : 'Brouillon à envoyer';
  if (first.length) {
    soriyaRelanceMail_(first, false, cfg);
    first.forEach(function (c) { sh.appendRow(["'" + c.n, "'" + c.date, c.route, c.driver, "'" + today, '', '1re relance — ' + mode, stamp]); });
  }
  if (reminder.length) {
    soriyaRelanceMail_(reminder, true, cfg);
    reminder.forEach(function (c) { sh.getRange(track[c.n].row, 6, 1, 3).setValues([["'" + today, 'Rappel — ' + mode, stamp]]); });
  }
  props.setProperty('SORIYA_RELANCES_DAY', today);
  return first.length + reminder.length;
}

/** Prépare (brouillon) ou envoie le mail de relance groupé, lettres de voiture en pièces jointes. */
function soriyaRelanceMail_(list, isReminder, cfg) {
  const fr = function (d) { return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4); };
  const esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const num = function (n) { return n.length === 6 ? n.slice(0, 3) + ' ' + n.slice(3) : n; };
  const subject = (isReminder ? 'Rappel – ' : '') + 'GFD LOGISTIC – Demande de confirmations d\'affrètement (' +
    list.length + ' course' + (list.length > 1 ? 's' : '') + ')';
  const td = 'style="padding:6px 10px;border:1px solid #d9d9d9"';
  const table = '<table style="border-collapse:collapse;font-size:14px"><tr style="background:#f2f2f2">' +
    ['N°', 'Date', 'Trajet', 'Chauffeur'].map(function (h) { return '<th ' + td + ' align="left">' + h + '</th>'; }).join('') + '</tr>' +
    list.map(function (c) { return '<tr><td ' + td + '>' + num(c.n) + '</td><td ' + td + '>' + fr(c.date) + '</td><td ' + td + '>' + esc(c.route) + '</td><td ' + td + '>' + esc(c.driver) + '</td></tr>'; }).join('') + '</table>';
  const text = list.map(function (c) { return '- N° ' + num(c.n) + ' du ' + fr(c.date) + ' : ' + c.route + ' (' + c.driver + ')'; }).join('\n');
  const sign = (cfg.SIGNATURE || []);
  const intro = isReminder
    ? 'Nous revenons vers vous au sujet de notre précédent message : nous restons en attente des confirmations d\'affrètement des courses ci-dessous (lettres de voiture à nouveau jointes).'
    : 'Sauf erreur de notre part, nous n\'avons pas reçu la confirmation d\'affrètement des courses suivantes, réalisées par nos chauffeurs :';
  const ask = isReminder
    ? 'Notre facturation de fin de mois en dépend : pourriez-vous nous les adresser dès que possible ?'
    : 'Vous trouverez en pièces jointes les lettres de voiture signées correspondantes.<br><br>Pourriez-vous nous transmettre les confirmations à l\'adresse gfd.logistic@gmail.com ? Elles nous sont nécessaires pour établir notre facturation mensuelle. Si l\'une de ces courses a été annulée ou modifiée, merci de nous le signaler.';
  const thanks = isReminder ? 'Merci pour votre aide.' : 'Nous vous remercions par avance et restons à votre disposition.';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">Bonjour,<br><br>' + intro + '<br><br>' + table + '<br>' + ask +
    '<br><br>' + thanks + '<br><br>Bien cordialement,<br><br>' + sign.map(function (l, i) { return i === 0 ? '<b>' + esc(l) + '</b>' : esc(l); }).join('<br>') + '</div>';
  const plain = 'Bonjour,\n\n' + intro + '\n\n' + text + '\n\n' + ask.replace(/<br>/g, '\n') + '\n\n' + thanks + '\n\nBien cordialement,\n\n' + sign.join('\n');
  const attachments = [];
  list.slice(0, SORIYA_RELANCES.MAX_ATTACHMENTS).forEach(function (c) {
    const id = (/\/d\/([\w-]+)/.exec(c.url) || [])[1];
    try { if (id) attachments.push(DriveApp.getFileById(id).getBlob()); } catch (e) { /* fichier introuvable */ }
  });
  const options = { htmlBody: html, attachments: attachments, name: 'GFD LOGISTIC' };
  if (cfg.MODE === 'envoi') GmailApp.sendEmail(cfg.TO, subject, plain, options);
  else GmailApp.createDraft(cfg.TO, subject, plain, options);
}
