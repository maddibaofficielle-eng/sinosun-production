/**
 * Soriya — pilotage : tableau de bord, rapport quotidien, déclencheurs et verrous.
 *
 * Tout est automatique : à chaque passage, Soriya vérifie ses déclencheurs, travaille,
 * puis met à jour le Google Sheet « Soriya - Tableau de bord » (racine de Mon Drive).
 *
 *   ouvrirTableauDeBord() → affiche le lien du tableau de bord dans le journal d'exécution
 *   soriyaRapportQuotidien() → envoie tout de suite le rapport du jour (sinon envoyé à 18 h)
 */

// Change cette valeur pour forcer la recréation des déclencheurs au prochain passage.
const SORIYA_TRIGGERS_VERSION = '2026-10-03 · 5 min + rapport 18 h';
const SORIYA_HANDLERS = ['soriyaRun', 'soriyaWhatsAppRun', 'soriyaRapportQuotidien'];

/** Recrée les déclencheurs si la configuration a changé (ou s'ils ont disparu). */
function soriyaEnsureTriggers_(force) {
  const props = PropertiesService.getScriptProperties();
  const existing = ScriptApp.getProjectTriggers()
    .filter(function (t) { return SORIYA_HANDLERS.indexOf(t.getHandlerFunction()) >= 0; });
  const periodic = existing.filter(function (t) { return t.getHandlerFunction() !== 'soriyaRapportQuotidien'; });
  if (!force && props.getProperty('SORIYA_TRIGGERS_VERSION') === SORIYA_TRIGGERS_VERSION &&
    periodic.length >= 2) return;

  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ['soriyaRun', 'soriyaWhatsAppRun'].forEach(function (handler) {
    ScriptApp.newTrigger(handler).timeBased().everyMinutes(SORIYA_CONFIG.TRIGGER_EVERY_MINUTES).create();
  });
  ScriptApp.newTrigger('soriyaRapportQuotidien').timeBased()
    .atHour(SORIYA_CONFIG.DAILY_REPORT_HOUR).everyDays(1).create();
  props.setProperty('SORIYA_TRIGGERS_VERSION', SORIYA_TRIGGERS_VERSION);
}

// ---------- Verrous : un passage à la fois PAR activité (Mailing et WhatsApp ne se bloquent plus) ----------

function soriyaTryLock_(activity) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return false;
  try {
    const cache = CacheService.getScriptCache();
    const key = 'soriya-running-' + activity;
    if (cache.get(key)) return false;
    cache.put(key, String(Date.now()), 6 * 60); // libéré automatiquement après 6 min
    return true;
  } finally {
    lock.releaseLock();
  }
}

function soriyaUnlock_(activity) {
  CacheService.getScriptCache().remove('soriya-running-' + activity);
}

/** Note l'heure de démarrage : un passage démarré mais jamais terminé se voit au tableau de bord. */
function soriyaMarkStart_(activity) {
  try {
    const props = PropertiesService.getScriptProperties();
    const state = JSON.parse(props.getProperty('SORIYA_DASHBOARD_STATE') || '{}');
    state[activity] = state[activity] || {};
    state[activity].lastStart = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
    props.setProperty('SORIYA_DASHBOARD_STATE', JSON.stringify(state).slice(0, 8500));
  } catch (e) { /* sans gravité */ }
}

// ---------- Fin de passage : rapport + tableau de bord ----------

/** Appelé à la fin de chaque passage. Ne lève jamais d'erreur (le travail est déjà fait). */
function soriyaFinish_(activity, report, extra) {
  try {
    soriyaRecordForDailyReport_(activity, report);
  } catch (e) {
    Logger.log('Rapport quotidien : %s', e.message);
  }
  try {
    soriyaEnsureWebLink_();
  } catch (e) {
    Logger.log('Lien interface : %s', e.message);
  }
  try {
    soriyaUpdateDashboard_(activity, report, extra || {});
  } catch (e) {
    Logger.log('Tableau de bord : %s', e.message);
  }
}

function soriyaRecordForDailyReport_(activity, report) {
  if (!report.archived.length && !report.duplicates && !report.errors.length) return;
  const props = PropertiesService.getScriptProperties();
  const day = JSON.parse(props.getProperty('SORIYA_DAILY') || '{}');
  const a = day[activity] || { archived: [], duplicates: 0, errors: [] };
  a.archived = a.archived.concat(report.archived.map(function (x) {
    return { name: x.name, status: x.status, url: x.url };
  })).slice(-200);
  a.duplicates += report.duplicates;
  a.errors = a.errors.concat(report.errors).slice(-50);
  day[activity] = a;
  props.setProperty('SORIYA_DAILY', JSON.stringify(day).slice(0, 8500));
}

/** Rapport du jour, envoyé une fois par jour (au lieu d'un e-mail par passage). */
function soriyaRapportQuotidien() {
  const props = PropertiesService.getScriptProperties();
  const day = JSON.parse(props.getProperty('SORIYA_DAILY') || '{}');
  props.deleteProperty('SORIYA_DAILY');
  if (!SORIYA_CONFIG.SEND_SUMMARY_EMAIL) return;

  const lines = ['Bonjour,', '', 'Voici le rapport du jour de Soriya.', ''];
  let total = 0;
  let problems = 0;
  ['Mailing', 'WhatsApp'].forEach(function (activity) {
    const a = day[activity];
    lines.push('■ ' + activity + (activity === 'Mailing' ? ' (confirmations d\'affrètement)' : ' (lettres de voiture)'));
    if (!a) {
      lines.push('  Rien de nouveau.', '');
      return;
    }
    total += a.archived.length;
    problems += a.errors.length;
    lines.push('  ' + a.archived.length + ' document(s) archivé(s), ' + a.duplicates + ' doublon(s) ignoré(s).');
    a.archived.forEach(function (x) {
      lines.push('  • ' + x.name + (x.status === 'Archivé' ? '' : ' — ' + x.status));
    });
    if (a.errors.length) {
      lines.push('  Problèmes (nouvel essai automatique) :');
      a.errors.forEach(function (e) { lines.push('  • ' + e); });
    }
    lines.push('');
  });
  const dash = soriyaDashboardFile_();
  lines.push('Tableau de bord : ' + dash.getUrl(), '', '— Soriya');
  MailApp.sendEmail(
    SORIYA_CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(),
    'Soriya — rapport du jour : ' + total + ' document(s)' + (problems ? ', ' + problems + ' problème(s)' : ''),
    lines.join('\n'));
}

// ---------- Tableau de bord ----------

function ouvrirTableauDeBord() {
  Logger.log('Tableau de bord : %s', soriyaDashboardFile_().getUrl());
}

function soriyaDashboardFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SORIYA_DASHBOARD_ID');
  if (id) {
    try {
      const f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* supprimé : on le recrée */ }
  }
  const ss = SpreadsheetApp.create('Soriya - Tableau de bord');
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(DriveApp.getRootFolder());
  props.setProperty('SORIYA_DASHBOARD_ID', file.getId());
  soriyaShare_(file);
  return file;
}

/** Partage en lecture seule avec les adresses de SHARE_WITH (journaux et tableau de bord). */
function soriyaShare_(file) {
  (SORIYA_CONFIG.SHARE_WITH || []).forEach(function (email) {
    try {
      const already = file.getViewers().concat(file.getEditors())
        .some(function (u) { return u.getEmail() === email; });
      if (!already) file.addViewer(email);
    } catch (e) {
      Logger.log('Partage avec %s impossible : %s', email, e.message);
    }
  });
}

function soriyaUpdateDashboard_(activity, report, extra) {
  const props = PropertiesService.getScriptProperties();
  const state = JSON.parse(props.getProperty('SORIYA_DASHBOARD_STATE') || '{}');
  const typeKey = activity === 'WhatsApp' ? 'lettre_voiture' : 'confirmation';
  const root = soriyaRootFolder_(typeKey);
  const journal = soriyaJournalSpreadsheet_(root, typeKey);
  soriyaShare_(DriveApp.getFileById(journal.ss.getId()));

  // Comptes à partir du journal (colonne « Statut »).
  const statusCol = JOURNAL_BASE_HEADERS.indexOf('Statut') + 1;
  const n = journal.main.getLastRow() - 1;
  const statuses = n > 0 ? journal.main.getRange(2, statusCol, n, 1).getValues() : [];
  const count = function (prefix) {
    return statuses.filter(function (r) { return String(r[0]).indexOf(prefix) === 0; }).length;
  };
  // Documents par mois (fichiers réellement présents dans les dossiers année/mois).
  const perMonth = {};
  const years = root.getFolders();
  while (years.hasNext()) {
    const y = years.next();
    if (!/^\d{4}$/.test(y.getName())) continue;
    const months = y.getFolders();
    while (months.hasNext()) {
      const m = months.next();
      let c = 0;
      const files = m.getFiles();
      while (files.hasNext()) { files.next(); c++; }
      perMonth[y.getName() + '-' + m.getName()] = c;
    }
  }

  state[activity] = {
    lastStart: (state[activity] || {}).lastStart || '',
    lastRun: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'),
    lastArchived: report.archived.length,
    lastDuplicates: report.duplicates,
    lastErrors: report.errors.length,
    lastError: report.errors.length ? String(report.errors[report.errors.length - 1]).slice(0, 300) : '',
    pending: extra.pending === undefined ? '—' : extra.pending,
    archived: count('Archivé'),
    toCheck: count('À vérifier'),
    setAside: count('Mis de côté'),
    duplicates: Math.max(journal.dup.getLastRow() - 1, 0),
    perMonth: perMonth,
    journalUrl: journal.ss.getUrl(),
    folderUrl: root.getUrl(),
  };
  props.setProperty('SORIYA_DASHBOARD_STATE', JSON.stringify(state).slice(0, 8500));
  soriyaWriteDashboard_(state);
}

function soriyaWriteDashboard_(state) {
  const ss = SpreadsheetApp.open(soriyaDashboardFile_());
  const sh = ss.getSheets()[0];
  sh.setName('Tableau de bord');
  sh.clear();

  const acts = [['Mailing', 'Confirmations d\'affrètement (e-mail)'], ['WhatsApp', 'Lettres de voiture (WhatsApp)']];
  const rows = [
    ['Soriya — tableau de bord', '', soriyaWebLinkForSheet_()],
    ['Mis à jour le ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy à HH:mm'), '', ''],
    ['', '', ''],
    ['', acts[0][1], acts[1][1]],
  ];
  const line = function (label, key) {
    return [label].concat(acts.map(function (a) {
      const s = state[a[0]];
      return s && s[key] !== undefined && s[key] !== null ? s[key] : '—';
    }));
  };
  rows.push(
    line('Dernier passage terminé', 'lastRun'),
    line('Dernier démarrage', 'lastStart'),
    line('Archivés au dernier passage', 'lastArchived'),
    line('Erreurs au dernier passage', 'lastErrors'),
    line('Dernière erreur', 'lastError'),
    line('En attente de traitement', 'pending'),
    ['', '', ''],
    line('Total archivés', 'archived'),
    line('À vérifier', 'toCheck'),
    line('Mis de côté', 'setAside'),
    line('Doublons écartés', 'duplicates'),
    ['', '', ''],
    line('Journal', 'journalUrl'),
    line('Dossier', 'folderUrl'),
    ['', '', ''],
    ['Documents par mois', '', '']
  );
  const months = {};
  acts.forEach(function (a) {
    const s = state[a[0]];
    if (s) Object.keys(s.perMonth || {}).forEach(function (k) { months[k] = true; });
  });
  Object.keys(months).sort().reverse().forEach(function (k) {
    rows.push([k].concat(acts.map(function (a) {
      const s = state[a[0]];
      return s && s.perMonth[k] !== undefined ? s.perMonth[k] : 0;
    })));
  });

  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange('A1').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setFontColor('#666666');
  sh.getRange(4, 1, 1, 3).setFontWeight('bold').setBackground('#e8f0fe');
  sh.getRange(5, 1, rows.length - 4, 1).setFontWeight('bold');
  sh.getRange(20, 1, 1, 3).setFontWeight('bold').setBackground('#e8f0fe');
  sh.setColumnWidth(1, 230);
  sh.setColumnWidths(2, 2, 320);
  sh.getRange(1, 1, rows.length, 3).setWrap(true).setVerticalAlignment('top');
  // Erreurs en rouge, éléments à vérifier en orange.
  [8, 9].forEach(function (r) { sh.getRange(r, 2, 1, 2).setFontColor('#c5221f'); });
  sh.getRange(13, 2, 1, 2).setFontColor('#b06000');
}

function soriyaWebLinkForSheet_() {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('SORIYA_WEB_KEY');
    const base = ScriptApp.getService().getUrl();
    return key && base ? 'Interface web : ' + base + '?k=' + key : '';
  } catch (e) {
    return '';
  }
}
