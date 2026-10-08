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
