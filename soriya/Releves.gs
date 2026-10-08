/**
 * Soriya — relevés mensuels « Statistique sous-traitant détaillée » d'Ecotime (mails « LISTING <MOIS> »).
 *
 * Ces PDF ne sont pas des confirmations : ils récapitulent, pour un mois, tous les ordres payés à
 * chaque sous-traitant (GFD LOGISTIC / CHEICK, GFD-LOGISTICS / VINCENT…). Soriya :
 *   1. les repère dans le journal des confirmations (objet « LISTING … » ou lecture IA qui les reconnaît) ;
 *   2. les range ensemble dans le dossier Drive « Statistiques sous-traitant », nommés 09-2026_Statistique_sous-traitant.pdf ;
 *   3. lit les totaux (onglet « Relevés sous-traitant » du Journal Soriya), puis le détail des ordres
 *      de chaque sous-traitant (onglet « Lignes relevés »), une lecture par passage pour rester sous
 *      la limite de temps d'Apps Script.
 * L'interface web les affiche dans l'onglet « Sous-traitants » et les compare aux confirmations reçues.
 */

const SORIYA_RELEVES = {
  FOLDER: 'Statistiques sous-traitant',
  SHEET: 'Relevés sous-traitant',
  LINES_SHEET: 'Lignes relevés',
  // Temps de passage au-delà duquel on ne lance plus de nouvelle lecture (chacune peut durer ~1 min).
  START_BEFORE_MS: 150 * 1000,
  MAX_ATTEMPTS: 3,
};
const SORIYA_RELEVES_HEADERS = ['Clé', 'Reçu le', 'Objet', 'Mois', 'Période début', 'Période fin', 'Édité le',
  'Société', 'Nb ordres', 'Total HT', 'Par sous-traitant', 'Sous-traitants (détail)', 'Version', 'Nom dans Drive',
  'Lien Drive', 'Traité le', 'Remarques', 'Dossier'];
const SORIYA_RELEVES_LINE_HEADERS = ['Clé relevé', 'Mois', 'N° ordre', 'Sous-traitant', 'Chauffeur', 'Agence',
  'Date', 'Enlèvement', 'Livraison', 'Prestation', 'Qté', 'Montant HT'];

/** Ligne du journal des confirmations qui est en fait un relevé sous-traitant. */
function soriyaIsReleve_(objet, statut) {
  return /(^|[\s:])LISTING\b/i.test(String(objet)) || /statistique sous-traitant/i.test(String(statut));
}

/** « GFD LOGISTIC / CHEICK » → « CHEICK ». */
function soriyaReleveDriver_(nom) {
  const parts = String(nom || '').replace(/\(.*?\)/g, '').split('/');
  return parts[parts.length - 1].trim().toUpperCase();
}

/** Onglets « Relevés sous-traitant » et « Lignes relevés » du Journal Soriya. */
function soriyaRelevesSheets_() {
  const j = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  const get = function (name, headers) {
    let sh = j.ss.getSheetByName(name);
    if (!sh) {
      sh = j.ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  };
  return { journal: j, releves: get(SORIYA_RELEVES.SHEET, SORIYA_RELEVES_HEADERS),
    lines: get(SORIYA_RELEVES.LINES_SHEET, SORIYA_RELEVES_LINE_HEADERS) };
}

/**
 * Une étape de traitement des relevés par lecture IA, tant qu'il reste du temps :
 * d'abord les nouveaux relevés (totaux), puis le détail des sous-traitants pas encore lus.
 * @return {number} nombre de lectures faites
 */
function soriyaTraiterReleves_(started, report) {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CLAUDE_API_KEY')) return 0;
  const s = soriyaRelevesSheets_();
  // v2 : une entrée par agence et par sous-traitant → relecture des relevés déjà lus.
  if (props.getProperty('SORIYA_RELEVES_FORMAT') !== '2') {
    [s.releves, s.lines].forEach(function (sh) { if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1); });
    props.setProperty('SORIYA_RELEVES_FORMAT', '2');
  }
  let done = 0;
  while (Date.now() - started < SORIYA_RELEVES.START_BEFORE_MS) {
    let did;
    try {
      did = soriyaReleveNouveau_(s) || soriyaReleveDetail_(s);
    } catch (e) {
      report.errors.push('Relevés sous-traitant : ' + e.message);
      break;
    }
    if (!did) break;
    done++;
  }
  return done;
}

/** Premier relevé du journal pas encore traité : lecture des totaux, rangement du PDF. */
function soriyaReleveNouveau_(s) {
  const j = s.journal;
  const n = j.main.getLastRow() - 1;
  if (n < 1) return false;
  const col = function (title) { return j.headers.indexOf(title); };
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  const known = new Set(soriyaSheetRows_(s.releves).map(function (r) { return String(r[0]); }));
  for (let r = rows.length - 1; r >= 0; r--) { // les plus récents d'abord
    const key = String(rows[r][col('Clé')]);
    if (!key || known.has(key) || !soriyaIsReleve_(rows[r][col('Objet')], rows[r][col('Statut')])) continue;
    const id = (/\/d\/([\w-]+)/.exec(String(rows[r][col('Lien Drive')])) || [])[1];
    let file = null;
    try { file = id ? DriveApp.getFileById(id) : null; } catch (e) { /* fichier supprimé */ }
    if (!file) {
      s.releves.appendRow([key, rows[r][col('Reçu le')], rows[r][col('Objet')], '', '', '', '', '', '', '', '', '[]',
        'Fichier introuvable', '', '', new Date(), '']);
      return true;
    }

    const d = soriyaClaudeJson_(file.getBlob(), soriyaRelevePrompt_(), soriyaReleveSchema_(),
      'Objet du mail : ' + rows[r][col('Objet')] + '\nDonne la période et les totaux de ce relevé.', null, 4000);
    if (!d.est_releve_sous_traitant) {
      s.releves.appendRow([key, rows[r][col('Reçu le')], rows[r][col('Objet')], '', '', '', '', '', '', '', '', '[]',
        'Pas un relevé', '', '', new Date(), d.remarques]);
      return true;
    }
    const month = String(d.periode_debut || '').slice(0, 7);
    const folder = soriyaSubFolder_(soriyaRootFolder_('confirmation'), [SORIYA_RELEVES.FOLDER]);
    // Déjà rangé lors d'une lecture précédente : on garde son nom.
    let name = file.getName();
    if (!/_Statistique_sous-traitant(_\d+)?\.pdf$/.test(name)) {
      name = soriyaUniqueName_(folder,
        (month ? month.slice(5, 7) + '-' + month.slice(0, 4) : 'sans-periode') + '_Statistique_sous-traitant.pdf');
      file.setName(name);
      file.moveTo(folder);
    }
    const sts = (d.sous_traitants || []).map(function (x) {
      return { agence: x.agence, code: x.code, nom: x.nom, ordres: x.nb_ordres, total: x.total_ht,
        lu: x.nb_ordres > 0 ? 0 : 'aucun ordre' };
    });
    s.releves.appendRow([key, rows[r][col('Reçu le')], rows[r][col('Objet')], "'" + month, "'" + d.periode_debut,
      "'" + d.periode_fin, "'" + d.date_edition, d.societe, d.nb_ordres, d.total_ht,
      sts.map(function (x) { return soriyaReleveDriver_(x.nom) + ' (' + x.agence + ') : ' + x.ordres + ' ordres, ' + x.total + ' HT'; }).join(' ; '),
      JSON.stringify(sts), '', name, file.getUrl(), new Date(), d.remarques, folder.getUrl()]);
    soriyaReleveVersions_(s.releves);
    // Le journal des confirmations garde la ligne (évite une nouvelle lecture du mail) avec son nouveau rangement.
    j.main.getRange(r + 2, col('Nom dans Drive') + 1, 1, 3).setValues([[name, file.getUrl(),
      'Relevé sous-traitant ' + month + ' — voir l\'onglet « ' + SORIYA_RELEVES.SHEET + ' »']]);
    return true;
  }
  return false;
}

/** Détail des ordres d'un sous-traitant pas encore lu (une lecture IA). */
function soriyaReleveDetail_(s) {
  const rows = soriyaSheetRows_(s.releves);
  const h = SORIYA_RELEVES_HEADERS;
  const c = function (t) { return h.indexOf(t); };
  // Le plus récent d'abord ; une version remplacée par un relevé corrigé n'est pas détaillée.
  const order = rows.map(function (row, i) { return i; })
    .sort(function (a, b) { return String(rows[b][c('Mois')]).localeCompare(String(rows[a][c('Mois')])); });
  for (let o = 0; o < order.length; o++) {
    const r = order[o];
    const url = String(rows[r][c('Lien Drive')]);
    if (!url || /^Remplacé/.test(String(rows[r][c('Version')]))) continue;
    let sts;
    try { sts = JSON.parse(String(rows[r][c('Sous-traitants (détail)')]) || '[]'); } catch (e) { continue; }
    const k = sts.findIndex(function (x) { return typeof x.lu === 'number' && x.lu < SORIYA_RELEVES.MAX_ATTEMPTS; });
    if (k < 0) continue;
    const st = sts[k];
    const month = String(rows[r][c('Mois')]);
    const id = (/\/d\/([\w-]+)/.exec(url) || [])[1];
    let lines;
    try {
      const d = soriyaClaudeJson_(DriveApp.getFileById(id).getBlob(), soriyaRelevePrompt_(), soriyaReleveLinesSchema_(),
        'Période du relevé : ' + rows[r][c('Période début')] + ' au ' + rows[r][c('Période fin')] + '.\n' +
        'Recopie TOUTES les lignes d\'ordre du sous-traitant « ' + st.code + ' - ' + st.nom + ' » dans l\'agence « ' +
        st.agence + ' » (et seulement cette agence), sur toutes les pages, ' +
        'dans l\'ordre du document (environ ' + st.ordres + ' ordres). N\'inclus ni les autres sous-traitants, ' +
        'ni les lignes de sous-total ou de total.', null, 16000);
      lines = d.lignes || [];
    } catch (e) {
      if (soriyaIsApiOutage_(e)) throw e; // crédit épuisé / API indisponible : on réessaiera plus tard
      st.lu++;
      st.erreur = String(e.message).slice(0, 200);
      s.releves.getRange(r + 2, c('Sous-traitants (détail)') + 1).setValue(JSON.stringify(sts));
      return true;
    }
    const key = String(rows[r][c('Clé')]);
    const driver = soriyaReleveDriver_(st.nom);
    if (lines.length) {
      s.lines.getRange(s.lines.getLastRow() + 1, 1, lines.length, SORIYA_RELEVES_LINE_HEADERS.length).setValues(
        lines.map(function (l) {
          return [key, "'" + month, "'" + String(l.numero_ordre).replace(/\s+/g, ''), st.nom, driver, l.agence,
            "'" + l.date, l.enlevement, l.livraison, l.prestation, l.quantite, l.montant_ht];
        }));
    }
    st.lu = 'oui';
    st.lignes = lines.length;
    delete st.erreur;
    s.releves.getRange(r + 2, c('Sous-traitants (détail)') + 1).setValue(JSON.stringify(sts));
    return true;
  }
  return false;
}

/** Plusieurs relevés pour le même mois (version corrigée) : le plus récemment édité fait foi. */
function soriyaReleveVersions_(sh) {
  const rows = soriyaSheetRows_(sh);
  const h = SORIYA_RELEVES_HEADERS;
  const c = function (t) { return h.indexOf(t); };
  const edited = function (row) {
    const m = /(\d{2})\/(\d{2})\/(\d{4})(?:\D+(\d{2}):(\d{2}))?/.exec(String(row[c('Édité le')]));
    const t = m ? Date.UTC(+m[3], m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) : 0;
    return t || (row[c('Reçu le')] instanceof Date ? row[c('Reçu le')].getTime() : 0);
  };
  const latest = {};
  rows.forEach(function (row, i) {
    const m = String(row[c('Mois')]);
    if (!m || !row[c('Lien Drive')]) return;
    if (latest[m] === undefined || edited(row) >= edited(rows[latest[m]])) latest[m] = i;
  });
  rows.forEach(function (row, i) {
    const m = String(row[c('Mois')]);
    if (!m || !row[c('Lien Drive')]) return;
    const v = latest[m] === i ? 'En vigueur' : 'Remplacé par une version plus récente';
    if (row[c('Version')] !== v) sh.getRange(i + 2, c('Version') + 1).setValue(v);
  });
}

function soriyaSheetRows_(sh) {
  const n = sh.getLastRow() - 1;
  return n < 1 ? [] : sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
}

function soriyaRelevePrompt_() {
  return [
    "Tu es Soriya, assistante transport de GFD Logistic, sous-traitant d'Ecotime.",
    'Tu lis les relevés mensuels « Statistique sous-traitant détaillée » édités par Ecotime : pour une période,',
    'ils listent les ordres de transport sous-traités, regroupés par agence puis par sous-traitant',
    '(ex. « 401 - GFD LOGISTIC / CHEICK »), avec pour chaque ordre : n° d\'ordre (ex. « 656 880(1)-F »),',
    'enlèvement (date ; lieu), livraison (date ; lieu), références, code de prestation (GV, FOURGON, BREAK…),',
    'quantité et montant HT d\'achat. Des sous-totaux par sous-traitant et un total général figurent en fin de liste.',
    '',
    'Règles :',
    "- Recopie les valeurs telles qu'elles figurent sur le document ; n'invente rien.",
    '- Dates au format AAAA-MM-JJ (l\'année est celle de la période du relevé).',
    '- Montants : nombres (point décimal), négatifs si le document les montre négatifs (ex. licence -24,00).',
    '- N° d\'ordre : seulement les chiffres du numéro principal (« 656 880(1)-F » → « 656880 »).',
    '- Lieux : ville avec code postal (ex. « 95470 FOSSES »).',
    '- sous_traitants : une entrée par couple agence + sous-traitant, avec le sous-total imprimé pour ce couple.',
  ].join('\n');
}

function soriyaReleveSchema_() {
  const str = { type: 'string' }, num = { type: 'number' };
  return {
    type: 'object',
    properties: {
      est_releve_sous_traitant: { type: 'boolean' },
      periode_debut: str, periode_fin: str,
      date_edition: { type: 'string', description: 'JJ/MM/AAAA HH:mm, en bas de page' },
      societe: str,
      nb_ordres: { type: 'integer' },
      total_ht: num,
      sous_traitants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            agence: { type: 'string', description: 'agence telle qu\'imprimée (ex. « 01 - Ecotime 95 »)' },
            code: str, nom: { type: 'string', description: 'nom du sous-traitant sans l\'agence (ex. « GFD LOGISTIC / CHEICK »)' },
            nb_ordres: { type: 'integer' }, total_ht: num,
          },
          required: ['agence', 'code', 'nom', 'nb_ordres', 'total_ht'],
          additionalProperties: false,
        },
      },
      remarques: str,
    },
    required: ['est_releve_sous_traitant', 'periode_debut', 'periode_fin', 'date_edition', 'societe', 'nb_ordres',
      'total_ht', 'sous_traitants', 'remarques'],
    additionalProperties: false,
  };
}

function soriyaReleveLinesSchema_() {
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      lignes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            numero_ordre: str, agence: str, date: { type: 'string', description: "date d'enlèvement AAAA-MM-JJ" },
            enlevement: str, livraison: str, prestation: { type: 'string', description: 'code ss-prest (GV, FOURGON…)' },
            quantite: { type: 'number' }, montant_ht: { type: 'number' },
          },
          required: ['numero_ordre', 'agence', 'date', 'enlevement', 'livraison', 'prestation', 'quantite', 'montant_ht'],
          additionalProperties: false,
        },
      },
    },
    required: ['lignes'],
    additionalProperties: false,
  };
}
