/**
 * Soriya — interface web à accès par compte Google (sans clé dans l'adresse).
 *
 * Projet séparé et minimal : il s'exécute avec le compte Google du visiteur et ne demande que
 * la lecture des feuilles de calcul (API Sheets en lecture seule ; SpreadsheetApp.openById exigerait
 * l'accès complet en modification). Le visiteur ne voit donc que si les journaux Soriya sont
 * partagés avec lui (gfd.logistic en est propriétaire, diabymohamed85 y a accès en lecture).
 * Les données sont lues en direct dans les journaux, le tableau de bord et la liste des prospects.
 */

const SORIYA_WEB = {
  CONF_JOURNAL_ID: '19-_3FUIVZ8BYUTdMQHn9UFBQ9J6VF-rXvYVI8wuXiqI',
  LDV_JOURNAL_ID: '160IpWj4OlxeIAuwVSh50ZNnhzrWzAzNeDF7dL_-c424',
  DASHBOARD_ID: '1iSH4Yr7jHm5lSEYYVzXfhTsyF196du71VwmqwsF21Yk',
  PROSPECTS_ID: '1ulPVaowTXYg7uhmxECZXyooeJt1KcYwt6Z-OGzPQVuo',
  MAX_SHARE_TOP_CLIENT: 0.8,
  TZ: 'Europe/Paris',
};

function doGet() {
  // Consentement « granulaire » de Google : si la case « Voir vos feuilles de calcul » n'a pas été cochée,
  // on redemande l'autorisation au lieu d'échouer.
  if (typeof ScriptApp.requireAllScopes === 'function') ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  try {
    Sheets.Spreadsheets.get(SORIYA_WEB.CONF_JOURNAL_ID, { fields: 'spreadsheetId' }); // accès aux journaux ?
  } catch (e) {
    Logger.log('Accès refusé : %s', e.message);
    const who = Session.getActiveUser().getEmail() || 'ce compte';
    if (/autoris|authoriz|scope|spreadsheets\.readonly/i.test(e.message)) {
      return HtmlService.createHtmlOutput(
        '<div style="font-family:sans-serif;padding:24px;max-width:560px">' +
        '<h2>Autorisation incomplète</h2><p>Le compte <b>' + who + '</b> a ouvert Soriya sans cocher la case ' +
        '« <b>Voir toutes vos feuilles de calcul Google Sheets</b> ».</p><ol>' +
        '<li>Ouvrez <a href="https://myaccount.google.com/connections" target="_blank">myaccount.google.com/connections</a>, ' +
        'choisissez <b>Soriya - Interface</b> et cliquez sur <b>Supprimer tout accès</b>.</li>' +
        '<li>Revenez sur <b>tinyurl.com/soriya-gfd</b> : à l\'écran d\'autorisation, <b>cochez la case</b> ' +
        '« Voir toutes vos feuilles de calcul » puis <b>Continuer</b>.</li></ol></div>')
        .setTitle('Soriya');
    }
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:24px;max-width:520px">' +
      '<h2>Accès réservé</h2><p>Le compte <b>' + who + '</b> n\'a pas accès aux journaux Soriya.</p>' +
      '<p>Connectez-vous avec gfd.logistic@gmail.com ou diabymohamed85@gmail.com, ' +
      'ou demandez à gfd.logistic de partager les journaux avec ce compte.</p>' +
      '<p style="color:#777;font-size:12px">Détail : ' + String(e.message).replace(/</g, '&lt;') + '</p></div>')
      .setTitle('Soriya');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.key = '';
  return t.evaluate()
    .setTitle('Soriya — documents de transport')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Appelé par la page (la clé éventuelle est ignorée : l'accès dépend du compte Google). */
function soriyaWebData() {
  return {
    generatedAt: Utilities.formatDate(new Date(), SORIYA_WEB.TZ, 'dd/MM/yyyy HH:mm'),
    activities: soriyaWebActivities_(),
    docs: soriyaWebDocs_('confirmation').concat(soriyaWebDocs_('lettre_voiture')),
    prospects: soriyaWebProspects_(),
    maxShareTopClient: SORIYA_WEB.MAX_SHARE_TOP_CLIENT,
    releves: soriyaWebReleves_(),
  };
}

/** Onglets « Relevés sous-traitant » et « Lignes relevés » du Journal Soriya (créés au premier relevé lu). */
function soriyaWebReleves_() {
  try {
    const get = function (tab) {
      try { return soriyaRead_(SORIYA_WEB.CONF_JOURNAL_ID, 'UNFORMATTED_VALUE', "'" + tab + "'!A1:Z5000"); } catch (e) { return []; }
    };
    return soriyaWebRelevesFrom_(get('Relevés sous-traitant'), get('Lignes relevés'));
  } catch (e) {
    return { folderUrl: '', list: [], lines: [], error: e.message };
  }
}

/**
 * Relevés « Statistique sous-traitant détaillée » pour l'interface (onglets du Journal Soriya).
 * rel / lines : lignes des onglets, en-tête compris (valeurs brutes).
 */
function soriyaWebRelevesFrom_(rel, lines) {
  const idx = function (rows) { const h = (rows[0] || []).map(String); return function (t) { return h.indexOf(t); }; };
  const c = idx(rel), l = idx(lines);
  const str = function (x) { return x === null || x === undefined ? '' : String(x); };
  const list = rel.slice(1).filter(function (r) { return r[c('Lien Drive')]; }).map(function (r) {
    let sts = [];
    try { sts = JSON.parse(str(r[c('Sous-traitants (détail)')]) || '[]'); } catch (e) { /* illisible */ }
    return {
      key: str(r[c('Clé')]), subject: str(r[c('Objet')]), month: str(r[c('Mois')]),
      from: str(r[c('Période début')]), to: str(r[c('Période fin')]), edited: str(r[c('Édité le')]),
      orders: Number(r[c('Nb ordres')]) || 0, total: Number(r[c('Total HT')]) || 0,
      current: /^En vigueur/.test(str(r[c('Version')])), name: str(r[c('Nom dans Drive')]), url: str(r[c('Lien Drive')]),
      remarks: str(r[c('Remarques')]),
      sts: sts.map(function (x) {
        const parts = str(x.nom).split('/');
        return { code: str(x.code), name: str(x.nom), driver: parts[parts.length - 1].trim().toUpperCase(),
          orders: Number(x.ordres) || 0, total: Number(x.total) || 0, read: x.lu === 'oui' || x.lu === 'aucun ordre', lines: x.lignes || 0 };
      }),
    };
  });
  const folder = rel.slice(1).map(function (r) { return str(r[c('Dossier')]); }).filter(String).pop() || '';
  return {
    folderUrl: folder, list: list,
    lines: lines.slice(1).map(function (r) {
      return { key: str(r[l('Clé relevé')]), month: str(r[l('Mois')]), number: str(r[l('N° ordre')]),
        driver: str(r[l('Chauffeur')]), agency: str(r[l('Agence')]), date: str(r[l('Date')]),
        from: str(r[l('Enlèvement')]), to: str(r[l('Livraison')]), service: str(r[l('Prestation')]),
        qty: Number(r[l('Qté')]) || 0, amount: Number(r[l('Montant HT')]) || 0 };
    }),
  };
}


/** État des activités, lu dans « Soriya - Tableau de bord » (colonne B = Mailing, C = WhatsApp). */
function soriyaWebActivities_() {
  let rows = [];
  try {
    rows = soriyaRead_(SORIYA_WEB.DASHBOARD_ID, 'FORMATTED_VALUE');
  } catch (e) { /* tableau de bord non partagé : on affiche les activités sans leur état */ }
  const get = function (label, col) {
    for (let i = 0; i < rows.length; i++) if (rows[i][0] === label) return rows[i][col] || '';
    return '';
  };
  return [['Mailing', 1], ['WhatsApp', 2]].map(function (a) {
    const pending = get('En attente de traitement', a[1]);
    return {
      id: a[0],
      label: a[0] === 'Mailing' ? "Confirmations d'affrètement" : 'Lettres de voiture',
      source: a[0] === 'Mailing' ? 'E-mail (libellés ecotime et clients)' : 'WhatsApp 06 52 13 53 08',
      lastRun: get('Dernier passage terminé', a[1]),
      lastStart: get('Dernier démarrage', a[1]),
      lastErrors: Number(get('Erreurs au dernier passage', a[1])) || 0,
      lastError: get('Dernière erreur', a[1]),
      pending: /^\d+$/.test(pending) ? Number(pending) : null,
      folderUrl: get('Dossier', a[1]),
      journalUrl: get('Journal', a[1]),
    };
  });
}

function soriyaWebDocs_(typeKey) {
  const ldv = typeKey === 'lettre_voiture';
  const all = soriyaRead_(ldv ? SORIYA_WEB.LDV_JOURNAL_ID : SORIYA_WEB.CONF_JOURNAL_ID, 'UNFORMATTED_VALUE');
  if (all.length < 2) return [];
  const headers = all[0].map(String);
  // Colonnes de dates : l'API renvoie un numéro de série (jours depuis le 30/12/1899) → « AAAA-MM-JJ HH:mm ».
  const isDate = function (h) { return /^(Date|Reçu le|Traité le)/.test(h); };
  const v = function (r, title) {
    const i = headers.indexOf(title);
    if (i < 0) return '';
    const x = r[i];
    if (x === null || x === undefined) return '';
    if (typeof x === 'number' && isDate(title)) {
      return Utilities.formatDate(new Date(Math.round((x - 25569) * 86400000)), 'UTC', 'yyyy-MM-dd HH:mm');
    }
    return String(x);
  };
  return all.slice(1).slice(-1000).map(function (r) {
    const date = ldv
      ? (v(r, 'Date livraison') || v(r, 'Date prise en charge') || v(r, 'Date établissement'))
      : (v(r, 'Date chargement') || v(r, 'Date confirmation'));
    return {
      type: ldv ? 'ldv' : 'conf',
      date: date || v(r, 'Reçu le').slice(0, 10),
      received: v(r, 'Reçu le'),
      number: ldv ? v(r, 'N° lettre de voiture') : v(r, 'N° affrètement'),
      from: ldv ? v(r, 'Lieu prise en charge') : v(r, 'Lieu chargement'),
      to: v(r, 'Lieu livraison'),
      party: ldv ? v(r, 'Expéditeur marchandise') : v(r, "Donneur d'ordre"),
      consignee: ldv ? v(r, 'Destinataire') : '',
      carrier: v(r, 'Transporteur'),
      goods: v(r, 'Marchandise'),
      price: ldv ? '' : [v(r, 'Montant HT') || v(r, 'Prix HT'), v(r, 'Devise')].join(' ').trim(),
      amount: ldv ? 0 : (parseFloat(String(v(r, 'Montant HT') || v(r, 'Prix HT')).replace(/\s/g, '').replace(',', '.')) || 0),
      driver: soriyaDriverName_(v(r, 'Transporteur')),
      waiting: ldv ? '' : v(r, 'Attente'),
      services: v(r, 'Prestations réalisées'),
      reserves: ldv ? v(r, 'Réserves à la livraison') : '',
      status: v(r, 'Statut'),
      confidence: v(r, 'Confiance'),
      name: v(r, 'Nom dans Drive'),
      url: v(r, 'Lien Drive'),
      remarks: v(r, 'Remarques'),
    };
  }).filter(function (d) {
    // Lettre de voiture lue sans numéro : ne compte pas (retirée du journal au prochain passage WhatsApp).
    // Relevé « Statistique sous-traitant » rangé dans le journal des confirmations : affiché dans « Sous-traitants ».
    if (d.type === 'conf') return !/^Relevé sous-traitant/.test(d.status);
    return String(d.number).trim() || /lecture IA impossible|sans lecture IA|Mis de côté/.test(d.status);
  });
}

/** « GFD LOGISTIC / CHEICK » → « CHEICK » ; vide ou « Aucune lettre de voiture » → ''. */
function soriyaDriverName_(carrier) {
  const c = String(carrier || '').trim();
  if (!c || /^aucune lettre/i.test(c) || /^lettre de voiture trouvée/i.test(c)) return '';
  const parts = c.split('/');
  return (parts.length > 1 ? parts[parts.length - 1] : c).trim().toUpperCase();
}

function soriyaWebProspects_() {
  try {
    const rows = soriyaRead_(SORIYA_WEB.PROSPECTS_ID, 'FORMATTED_VALUE').slice(1).filter(function (r) { return r[0]; });
    return {
      url: 'https://docs.google.com/spreadsheets/d/' + SORIYA_WEB.PROSPECTS_ID + '/edit',
      list: rows.map(function (r) {
        return { name: r[0], type: r[1], potential: r[2], why: r[3], link: r[4],
          status: r[5] || 'À contacter', next: r[6], date: r[7] };
      }),
    };
  } catch (e) {
    return { url: '', list: [], error: 'Liste des prospects non partagée avec ce compte.' };
  }
}

/** Lit le premier onglet d'une feuille (API Sheets, lecture seule). */
function soriyaRead_(id, render, range) {
  const res = Sheets.Spreadsheets.Values.get(id, range || 'A1:AZ5000', {
    valueRenderOption: render, dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const rows = res.values || [];
  const width = rows.length ? rows[0].length : 0;
  return rows.map(function (r) { while (r.length < width) r.push(''); return r; });
}
