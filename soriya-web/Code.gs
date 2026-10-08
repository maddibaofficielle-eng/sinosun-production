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
        '« <b>Voir, modifier, créer et supprimer toutes vos feuilles de calcul Google Sheets</b> » ' +
        '(Soriya enregistre vos réponses « course réalisée » dans le Sheet des prospects).</p><ol>' +
        '<li>Ouvrez <a href="https://myaccount.google.com/connections" target="_blank">myaccount.google.com/connections</a>, ' +
        'choisissez <b>Soriya - Interface</b> et cliquez sur <b>Supprimer tout accès</b>.</li>' +
        '<li>Revenez sur <b>tinyurl.com/soriya-gfd</b> : à l\'écran d\'autorisation, <b>cochez la case</b> ' +
        '« Voir, modifier, créer et supprimer toutes vos feuilles de calcul » puis <b>Continuer</b>.</li></ol></div>')
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
    factures: soriyaWebFacturesFrom_(soriyaWebTab_('Factures'), soriyaWebTab_('Lignes factures')),
    admin: soriyaWebAdminFrom_(soriyaWebTab_('Documents administratifs')),
    checks: soriyaWebChecksFrom_((function () {
      try { return soriyaRead_(SORIYA_WEB.PROSPECTS_ID, 'FORMATTED_VALUE', "'Courses vérifiées'!A1:D5000"); } catch (e) { return []; }
    })()),
    depenses: soriyaWebDepensesFrom_((function () {
      try { return soriyaRead_(SORIYA_WEB.LDV_JOURNAL_ID, 'UNFORMATTED_VALUE', "'Dépenses'!A1:Z5000"); } catch (e) { return []; }
    })()),
  };
}

/** Onglet du Journal Soriya ([] s'il n'existe pas encore). */
function soriyaWebTab_(tab) {
  try { return soriyaRead_(SORIYA_WEB.CONF_JOURNAL_ID, 'UNFORMATTED_VALUE', "'" + tab + "'!A1:Z5000"); } catch (e) { return []; }
}

/** Factures émises pour l'interface (onglets « Factures » et « Lignes factures » du Journal Soriya). */
function soriyaWebFacturesFrom_(fac, lines) {
  const idx = function (rows) { const h = (rows[0] || []).map(String); return function (t) { return h.indexOf(t); }; };
  const c = idx(fac), l = idx(lines);
  const str = function (x) { return x === null || x === undefined ? '' : String(x); };
  const num = function (x) { return Number(x) || 0; };
  const list = fac.slice(1).filter(function (r) { return r[c('Lien Drive')] && r[c('N° facture')]; }).map(function (r) {
    return { key: str(r[c('Clé')]), number: str(r[c('N° facture')]), subject: str(r[c('Objet')]),
      issued: str(r[c('Émise le')]), due: str(r[c('Échéance')]), client: str(r[c('Client')]),
      from: str(r[c('Période début')]), to: str(r[c('Période fin')]), month: str(r[c('Mois')]),
      gross: num(r[c('Total HT avant remise')]), discount: num(r[c('Remise')]), ht: num(r[c('Total HT')]),
      vat: num(r[c('TVA')]), ttc: num(r[c('Total TTC')]), name: str(r[c('Nom dans Drive')]), url: str(r[c('Lien Drive')]),
      remarks: str(r[c('Remarques')]) };
  });
  return {
    folderUrl: fac.slice(1).map(function (r) { return str(r[c('Dossier')]); }).filter(String).pop() || '',
    list: list,
    lines: lines.slice(1).map(function (r) {
      return { key: str(r[l('Clé facture')]), number: str(r[l('N° facture')]), product: str(r[l('Produit')]),
        qty: num(r[l('Qté')]), unit: str(r[l('Unité')]), price: num(r[l('Prix u. HT')]), vat: num(r[l('TVA %')]),
        total: num(r[l('Total HT')]) };
    }),
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
        const parts = str(x.nom).replace(/\(.*?\)/g, '').split('/');
        return { code: str(x.code), name: str(x.nom), agency: str(x.agence || ''), driver: parts[parts.length - 1].trim().toUpperCase(),
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
    if (d.type === 'conf') return !/^(Relevé sous-traitant|Facture |Document administratif)/.test(d.status);
    if (/^Dépense/.test(d.status) || soriyaWebIsTicket_(d.status)) return false; // ticket de caisse : onglet « Dépenses »
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

/** Documents administratifs pour l'interface (onglet « Documents administratifs » du Journal Soriya). */
function soriyaWebAdminFrom_(rows) {
  const h = (rows[0] || []).map(String), c = function (t) { return h.indexOf(t); };
  const str = function (x) { return x === null || x === undefined ? '' : String(x); };
  return {
    folderUrl: rows.slice(1).map(function (r) { return str(r[c('Dossier')]); }).filter(String).pop() || '',
    list: rows.slice(1).filter(function (r) { return r[c('Lien Drive')] && r[c('Type')]; }).map(function (r) {
      const rc = r[c('Reçu le')]; // Date (SpreadsheetApp) ou numéro de série (API Sheets)
      const received = rc instanceof Date ? Utilities.formatDate(rc, 'Europe/Paris', 'yyyy-MM-dd') :
        typeof rc === 'number' ? Utilities.formatDate(new Date(Math.round((rc - 25569) * 86400000)), 'UTC', 'yyyy-MM-dd') : str(rc).slice(0, 10);
      return { key: str(r[c('Clé')]), received: received, from: str(r[c('Expéditeur')]), subject: str(r[c('Objet')]), type: str(r[c('Type')]),
        issuer: str(r[c('Émetteur')]), to: str(r[c('Destinataire')]), date: str(r[c('Date du document')]),
        validUntil: str(r[c('Valable jusqu\'au')]), company: str(r[c('Société concernée')]), ref: str(r[c('Référence')]),
        summary: str(r[c('Résumé')]), requested: str(r[c('Pièces demandées')]), deadline: str(r[c('Date limite')]),
        name: str(r[c('Nom dans Drive')]), url: str(r[c('Lien Drive')]), remarks: str(r[c('Remarques')]) };
    }),
  };
}

/** Tickets de caisse pour l'interface (onglet « Dépenses » du Journal Lettres de voiture). */
function soriyaWebDepensesFrom_(rows) {
  const h = (rows[0] || []).map(String), c = function (t) { return h.indexOf(t); };
  const str = function (x) { return x === null || x === undefined ? '' : String(x); };
  const num = function (x) { return Number(x) || 0; };
  return {
    folderUrl: rows.slice(1).map(function (r) { return str(r[c('Dossier')]); }).filter(String).pop() || '',
    list: rows.slice(1).filter(function (r) { return r[c('Lien Drive')]; }).map(function (r) {
      return { key: str(r[c('Clé')]), sender: str(r[c('Expéditeur')]).replace(/^'/, ''), driver: str(r[c('Chauffeur')]),
        category: str(r[c('Catégorie')]), date: str(r[c('Date')]), time: str(r[c('Heure')]), brand: str(r[c('Enseigne')]),
        address: str(r[c('Adresse')]), city: str(r[c('Ville')]), fuel: str(r[c('Carburant')]), liters: num(r[c('Litres')]),
        pricePerL: num(r[c('Prix au litre')]), ttc: num(r[c('Montant TTC')]), vat: num(r[c('TVA')]), ht: num(r[c('Montant HT')]),
        payment: str(r[c('Paiement')]), plate: str(r[c('Immatriculation')]), km: str(r[c('Kilométrage')]),
        kind: str(r[c('Type de pièce')]) || 'Ticket de caisse',
        name: str(r[c('Nom dans Drive')]), url: str(r[c('Lien Drive')]), remarks: str(r[c('Remarques')]) };
    }),
  };
}

/** Ticket de caisse pas encore rangé (même règle que soriyaIsTicket_ côté Soriya). */
function soriyaWebIsTicket_(statut) {
  return /^À vérifier/.test(statut) && !/^À vérifier — pas un ticket/.test(statut) &&
    /ticket de caisse|ticket de carburant|re[çc]u de paiement|station[- ]service|carburant|gazole|gasoil|diesel|péage|facturette/i.test(statut);
}

/** Réponses « le chauffeur a-t-il réalisé la course ? » : { "659079": { v: "OUI", by: "…", at: "…" } }. */
function soriyaWebChecksFrom_(rows) {
  const out = {};
  rows.slice(1).forEach(function (r) {
    const n = String(r[0] || '').replace(/\D/g, '');
    if (n) out[n] = { v: String(r[1] || ''), by: String(r[2] || ''), at: String(r[3] || '') };
  });
  return out;
}

/**
 * Enregistre « course réalisée : OUI / NON » (case cochée dans « Rapprochement »). Écrit dans l'onglet
 * « Courses vérifiées » du Sheet « Soriya - Prospects » (vous y avez l'accès en modification).
 */
function soriyaWebSetRealisee(number, value) {
  const id = SORIYA_WEB.PROSPECTS_ID, tab = 'Courses vérifiées';
  const n = String(number || '').replace(/\D/g, '');
  if (!n || ['OUI', 'NON', ''].indexOf(value) < 0) throw new Error('Valeur invalide');
  let rows;
  try {
    rows = Sheets.Spreadsheets.Values.get(id, "'" + tab + "'!A1:D5000").values || [];
  } catch (e) {
    Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: tab } } }] }, id);
    rows = [];
  }
  if (!rows.length) {
    rows = [['N° course', 'Réalisée', 'Par', 'Le']];
    Sheets.Spreadsheets.Values.update({ values: rows }, id, "'" + tab + "'!A1:D1", { valueInputOption: 'RAW' });
  }
  const who = Session.getActiveUser().getEmail() || '';
  const at = Utilities.formatDate(new Date(), SORIYA_WEB.TZ, 'dd/MM/yyyy HH:mm');
  let line = -1;
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]).replace(/\D/g, '') === n) { line = i + 1; break; }
  const values = [["'" + n, value, who, at]];
  if (line > 0) Sheets.Spreadsheets.Values.update({ values: values }, id, "'" + tab + "'!A" + line + ':D' + line, { valueInputOption: 'USER_ENTERED' });
  else Sheets.Spreadsheets.Values.append({ values: values }, id, "'" + tab + "'!A1:D1", { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
  return { v: value, by: who, at: at };
}
