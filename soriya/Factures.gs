/**
 * Soriya — factures émises par GFD-LOGISTIC (ex. « Facture-ECOTIME GROUP-GFD-LOGISTIC-F-2026-1032.pdf »,
 * envoyées en réponse aux mails « LISTING <MOIS> » d'Ecotime).
 *
 * Ce ne sont pas des confirmations : Soriya les repère dans le journal des confirmations, les range dans
 * le dossier Drive « Factures » (nommées 09-2026_Facture_F-2026-1032.pdf), lit leur détail (onglets
 * « Factures » et « Lignes factures » du Journal Soriya) ; l'interface les affiche dans l'onglet « Factures ».
 */

const SORIYA_FACTURES = { FOLDER: 'Factures', SHEET: 'Factures', LINES_SHEET: 'Lignes factures' };
const SORIYA_FACTURES_HEADERS = ['Clé', 'Reçu le', 'Objet', 'N° facture', 'Émise le', 'Échéance', 'Émetteur', 'Client',
  'Période début', 'Période fin', 'Mois', 'Total HT avant remise', 'Remise', 'Total HT', 'TVA', 'Total TTC',
  'Nb lignes', 'Nom dans Drive', 'Lien Drive', 'Traité le', 'Remarques', 'Dossier'];
const SORIYA_FACTURES_LINE_HEADERS = ['Clé facture', 'N° facture', 'Mois', 'Produit', 'Qté', 'Unité', 'Prix u. HT',
  'TVA %', 'Total HT'];

/** Ligne du journal des confirmations qui est en fait une facture (fichier « Facture… » ou lecture IA). */
function soriyaIsFacture_(fichier, statut) {
  return /^Facture/i.test(String(fichier)) ||
    (/^À vérifier/.test(String(statut)) && /\b(une|cette) facture\b|facture mensuelle/i.test(String(statut)));
}

function soriyaFacturesSheets_(j) {
  const get = function (name, headers) {
    let sh = j.ss.getSheetByName(name);
    if (!sh) {
      sh = j.ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  };
  return { factures: get(SORIYA_FACTURES.SHEET, SORIYA_FACTURES_HEADERS),
    lines: get(SORIYA_FACTURES.LINES_SHEET, SORIYA_FACTURES_LINE_HEADERS) };
}

/** Première facture du journal pas encore lue : lecture IA, rangement, onglets. @return {boolean} */
function soriyaFactureNouvelle_(j) {
  const n = j.main.getLastRow() - 1;
  if (n < 1) return false;
  const col = function (title) { return j.headers.indexOf(title); };
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  let f = null;
  const known = function () {
    f = f || soriyaFacturesSheets_(j);
    return new Set(soriyaSheetRows_(f.factures).map(function (r) { return String(r[0]); }));
  };
  let keys = null;
  for (let r = rows.length - 1; r >= 0; r--) { // les plus récentes d'abord
    const key = String(rows[r][col('Clé')]);
    if (!key || !soriyaIsFacture_(rows[r][col('Fichier reçu')], rows[r][col('Statut')])) continue;
    if (/^Archivé/.test(String(rows[r][col('Statut')]))) continue; // vraie confirmation : on n'y touche pas
    keys = keys || known();
    if (keys.has(key)) continue;
    const base = [key, rows[r][col('Reçu le')], rows[r][col('Objet')]];
    const id = (/\/d\/([\w-]+)/.exec(String(rows[r][col('Lien Drive')])) || [])[1];
    let file = null;
    try { file = id ? DriveApp.getFileById(id) : null; } catch (e) { /* fichier supprimé */ }
    if (!file) {
      f.factures.appendRow(base.concat(['', '', '', '', '', '', '', '', '', '', '', '', '', 0, '', '', new Date(), 'Fichier introuvable']));
      return true;
    }
    const d = soriyaClaudeJson_(file.getBlob(), soriyaFacturePrompt_(), soriyaFactureSchema_(),
      'Objet du mail : ' + rows[r][col('Objet')] + '\nExtrais le détail de cette facture.', null, 8000);
    if (!d.est_facture) {
      f.factures.appendRow(base.concat(['', '', '', '', '', '', '', '', '', '', '', '', '', 0, '', '', new Date(),
        'Pas une facture : ' + d.remarques]));
      return true;
    }
    const month = String(d.periode_debut || d.date_emission || '').slice(0, 7);
    const folder = soriyaSubFolder_(soriyaRootFolder_('confirmation'), [SORIYA_FACTURES.FOLDER]);
    let name = file.getName();
    if (!/_Facture_/.test(name)) {
      name = soriyaUniqueName_(folder, (month ? month.slice(5, 7) + '-' + month.slice(0, 4) : 'sans-periode') +
        '_Facture_' + String(d.numero || 'sans-numero').replace(/[^A-Za-z0-9-]+/g, '') + '.pdf');
      file.setName(name);
      file.moveTo(folder);
    }
    const lines = d.lignes || [];
    f.factures.appendRow(base.concat([d.numero, "'" + d.date_emission, "'" + d.date_echeance, d.emetteur, d.client,
      "'" + d.periode_debut, "'" + d.periode_fin, "'" + month, d.total_ht_avant_remise, d.remise, d.total_ht, d.tva,
      d.total_ttc, lines.length, name, file.getUrl(), new Date(), d.remarques, folder.getUrl()]));
    if (lines.length) {
      f.lines.getRange(f.lines.getLastRow() + 1, 1, lines.length, SORIYA_FACTURES_LINE_HEADERS.length).setValues(
        lines.map(function (l) {
          return [key, d.numero, "'" + month, l.produit, l.quantite, l.unite, l.prix_unitaire_ht, l.tva_pct, l.total_ht];
        }));
    }
    j.main.getRange(r + 2, col('Nom dans Drive') + 1, 1, 3).setValues([[name, file.getUrl(),
      'Facture ' + d.numero + ' — voir l\'onglet « ' + SORIYA_FACTURES.SHEET + ' »']]);
    return true;
  }
  return false;
}

function soriyaFacturePrompt_() {
  return [
    'Tu es Soriya, assistante administrative de GFD-LOGISTIC (transport et manutention).',
    'Tu lis des factures (émises par GFD-LOGISTIC à ses clients, ex. ECOTIME GROUP) et tu en extrais le détail.',
    '',
    'Règles :',
    "- Recopie les valeurs telles qu'elles figurent sur la facture ; n'invente rien.",
    '- Dates au format AAAA-MM-JJ ; periode_debut / periode_fin = la période facturée (ex. « du 01/09/2026 au 30/09/2026 »).',
    '- Montants : nombres (point décimal). remise = montant de la remise HT (positif), 0 si aucune.',
    '- lignes = chaque produit facturé, dans l\'ordre (ex. « Courses GV zone 1 », 101 unités, 60,00 €, 20 %, 6 060,00 €).',
    '- Si le document n\'est pas une facture, mets est_facture à false et explique dans remarques.',
  ].join('\n');
}

function soriyaFactureSchema_() {
  const str = { type: 'string' }, num = { type: 'number' };
  const props = {
    est_facture: { type: 'boolean' }, numero: str, date_emission: str, date_echeance: str, emetteur: str, client: str,
    periode_debut: str, periode_fin: str,
    lignes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { produit: str, quantite: num, unite: str, prix_unitaire_ht: num, tva_pct: num, total_ht: num },
        required: ['produit', 'quantite', 'unite', 'prix_unitaire_ht', 'tva_pct', 'total_ht'],
        additionalProperties: false,
      },
    },
    total_ht_avant_remise: num, remise: num, total_ht: num, tva: num, total_ttc: num, remarques: str,
  };
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}
