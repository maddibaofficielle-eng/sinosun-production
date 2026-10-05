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
  try {
    Sheets.Spreadsheets.get(SORIYA_WEB.CONF_JOURNAL_ID, { fields: 'spreadsheetId' }); // accès aux journaux ?
  } catch (e) {
    Logger.log('Accès refusé : %s', e.message);
    const who = Session.getActiveUser().getEmail() || 'ce compte';
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
function soriyaRead_(id, render) {
  const res = Sheets.Spreadsheets.Values.get(id, 'A1:AZ5000', {
    valueRenderOption: render, dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const rows = res.values || [];
  const width = rows.length ? rows[0].length : 0;
  return rows.map(function (r) { while (r.length < width) r.push(''); return r; });
}
