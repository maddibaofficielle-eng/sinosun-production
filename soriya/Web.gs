/**
 * Soriya — interface web (lecture seule) : tableau de bord + liste des documents.
 *
 * L'adresse est privée : elle contient une clé secrète (?k=…) générée dans les propriétés
 * du script (jamais dans le code). Soriya l'envoie par e-mail au premier passage et
 * l'affiche dans « Soriya - Tableau de bord ». Pour révoquer l'accès : nouvelleCleInterface().
 */

function doGet(e) {
  const key = PropertiesService.getScriptProperties().getProperty('SORIYA_WEB_KEY');
  if (!key || !e || !e.parameter || e.parameter.k !== key) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:24px">Lien Soriya invalide ou expiré.</p>')
      .setTitle('Soriya');
  }
  const t = HtmlService.createTemplateFromFile('Index');
  t.key = key;
  return t.evaluate()
    .setTitle('Soriya — documents de transport')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Appelé par la page : toutes les données affichées, lues en direct dans les journaux. */
function soriyaWebData(k) {
  if (k !== PropertiesService.getScriptProperties().getProperty('SORIYA_WEB_KEY')) {
    throw new Error('Accès refusé');
  }
  const state = JSON.parse(PropertiesService.getScriptProperties().getProperty('SORIYA_DASHBOARD_STATE') || '{}');
  const docs = soriyaWebDocs_('confirmation').concat(soriyaWebDocs_('lettre_voiture'));
  return {
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'),
    activities: ['Mailing', 'WhatsApp'].map(function (a) {
      const s = state[a] || {};
      return {
        id: a,
        label: a === 'Mailing' ? "Confirmations d'affrètement" : 'Lettres de voiture',
        source: a === 'Mailing' ? 'E-mail (libellé ecotime)' : 'WhatsApp 06 52 13 53 08',
        lastRun: s.lastRun || '', lastStart: s.lastStart || '',
        lastErrors: s.lastErrors || 0, lastError: s.lastError || '',
        pending: s.pending === undefined ? null : s.pending,
        folderUrl: s.folderUrl || '', journalUrl: s.journalUrl || '',
      };
    }),
    docs: docs,
    prospects: (function () {
      try { return soriyaWebProspects_(); } catch (e) { return { url: '', list: [], error: e.message }; }
    })(),
    maxShareTopClient: SORIYA_CONFIG.MAX_SHARE_TOP_CLIENT || 0.8,
    releves: (function () {
      try {
        const s = soriyaRelevesSheets_();
        const all = function (sh) { return sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues() : []; };
        return soriyaWebRelevesFrom_(all(s.releves), all(s.lines));
      } catch (e) { return { folderUrl: '', list: [], lines: [], error: e.message }; }
    })(),
    factures: (function () {
      try {
        const f = soriyaFacturesSheets_(soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation'));
        const all = function (sh) { return sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues() : []; };
        return soriyaWebFacturesFrom_(all(f.factures), all(f.lines));
      } catch (e) { return { folderUrl: '', list: [], lines: [], error: e.message }; }
    })(),
    relances: (function () {
      try {
        const sh = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation').ss.getSheetByName('Relances');
        return soriyaWebRelancesFrom_(sh ? sh.getDataRange().getDisplayValues() : []);
      } catch (e) { return {}; }
    })(),
    checks: (function () {
      try {
        const sh = soriyaProspectsSheet_().getParent().getSheetByName('Courses vérifiées');
        return soriyaWebChecksFrom_(sh ? sh.getDataRange().getDisplayValues() : []);
      } catch (e) { return {}; }
    })(),
    depenses: (function () {
      try {
        const sh = soriyaDepensesSheet_(soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture'));
        return soriyaWebDepensesFrom_(sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues() : []);
      } catch (e) { return { folderUrl: '', list: [], error: e.message }; }
    })(),
    admin: (function () {
      try {
        const sh = soriyaAdminSheet_(soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation'));
        return soriyaWebAdminFrom_(sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues() : []);
      } catch (e) { return { folderUrl: '', list: [], error: e.message }; }
    })(),
  };
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


function soriyaWebDocs_(typeKey) {
  const root = soriyaRootFolder_(typeKey);
  const j = soriyaJournalSpreadsheet_(root, typeKey);
  const n = j.main.getLastRow() - 1;
  if (n < 1) return [];
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  const idx = function (title) { return j.headers.indexOf(title); };
  const v = function (r, title) {
    const i = idx(title);
    if (i < 0) return '';
    const x = r[i];
    if (x instanceof Date) return Utilities.formatDate(x, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    return x === null || x === undefined ? '' : String(x);
  };
  const ldv = typeKey === 'lettre_voiture';
  return rows.slice(-1000).map(function (r) {
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
      // Montant HT en nombre (chiffre d'affaires) et chauffeur (lettre de voiture rapprochée : « GFD LOGISTIC / CHEICK »).
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
    if (d.type === 'conf') return !/^(Relevé sous-traitant|Facture |Document administratif|Lettre de voiture —)/.test(d.status);
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

// ---------- Lien privé ----------

/** Crée la clé si besoin et envoie le lien une fois. Appelé à chaque passage (très rapide). */
function soriyaEnsureWebLink_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SORIYA_WEB_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('SORIYA_WEB_KEY', key);
    props.deleteProperty('SORIYA_WEB_LINK_SENT');
  }
  const base = SORIYA_CONFIG.WEB_APP_URL;
  if (!base) return ''; // l'interface n'est pas encore publiée
  const url = base + '?k=' + key;
  if (props.getProperty('SORIYA_WEB_LINK_SENT') !== url) {
    MailApp.sendEmail(
      SORIYA_CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(),
      'Soriya — votre lien vers l\'interface',
      ['Bonjour,', '', 'Voici le lien privé vers l\'interface de Soriya (à garder pour vous) :', '', url, '',
        'Il fonctionne sur ordinateur et sur téléphone. Ajoutez-le à vos favoris.', '', '— Soriya'].join('\n'));
    props.setProperty('SORIYA_WEB_LINK_SENT', url);
  }
  return url;
}

/** Révoque l'ancien lien et en envoie un nouveau par e-mail. */
function nouvelleCleInterface() {
  PropertiesService.getScriptProperties().deleteProperty('SORIYA_WEB_KEY');
  Logger.log('Nouveau lien : %s', soriyaEnsureWebLink_());
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

/** « Course réalisée : OUI / NON » depuis l'interface (même onglet que l'interface à compte Google). */
function soriyaWebSetRealisee(number, value, k) {
  if (k !== PropertiesService.getScriptProperties().getProperty('SORIYA_WEB_KEY')) throw new Error('Accès refusé');
  const n = String(number || '').replace(/\D/g, '');
  if (!n || ['OUI', 'NON', ''].indexOf(value) < 0) throw new Error('Valeur invalide');
  const ss = soriyaProspectsSheet_().getParent();
  const sh = ss.getSheetByName('Courses vérifiées') || ss.insertSheet('Courses vérifiées');
  if (!sh.getLastRow()) sh.appendRow(['N° course', 'Réalisée', 'Par', 'Le']);
  const at = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  const vals = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).replace(/\D/g, '') === n) { sh.getRange(i + 1, 1, 1, 4).setValues([["'" + n, value, 'interface (lien)', at]]); return { v: value, at: at }; }
  }
  sh.appendRow(["'" + n, value, 'interface (lien)', at]);
  return { v: value, at: at };
}

/** Suivi des relances Ecotime : { "659079": { r1: "2026-10-10", r2: "", status: "1re relance — …" } }. */
function soriyaWebRelancesFrom_(rows) {
  const out = {};
  rows.slice(1).forEach(function (r) {
    const n = String(r[0] || '').replace(/\D/g, '');
    const d = function (x) { return x instanceof Date ? Utilities.formatDate(x, 'Europe/Paris', 'yyyy-MM-dd') : String(x || '').slice(0, 10); };
    if (n) out[n] = { r1: d(r[4]), r2: d(r[5]), status: String(r[6] || '') };
  });
  return out;
}
