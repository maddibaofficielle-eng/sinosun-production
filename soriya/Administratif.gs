/**
 * Soriya — documents administratifs (dossier sous-traitant) : extraits Kbis, attestations URSSAF / de paiement /
 * d'assurance, licence de transport, demandes de mise à jour envoyées par Ecotime…
 *
 * Soriya les repère dans le journal des confirmations (lecture IA « À vérifier » qui les décrit), les range dans
 * le dossier Drive « Documents administratifs » (nommés 19-04-2026_Extrait_Kbis.pdf), lit leur détail
 * (onglet « Documents administratifs » du Journal Soriya) ; l'interface suit leur validité dans l'onglet
 * « Administratif ».
 */

const SORIYA_ADMIN = { FOLDER: 'Documents administratifs', SHEET: 'Documents administratifs' };
const SORIYA_ADMIN_HEADERS = ['Clé', 'Reçu le', 'Expéditeur', 'Objet', 'Type', 'Émetteur', 'Destinataire',
  'Date du document', 'Valable jusqu\'au', 'Société concernée', 'Référence', 'Résumé', 'Pièces demandées',
  'Date limite', 'Nom dans Drive', 'Lien Drive', 'Traité le', 'Remarques', 'Dossier'];
const SORIYA_ADMIN_TYPES = ['Extrait Kbis', 'Attestation de vigilance URSSAF', 'Attestation de paiement',
  'Attestation d\'assurance', 'Licence de transport', 'Demande de documents', 'RIB', 'Contrat', 'Autre'];

/** Ligne « À vérifier » du journal des confirmations qui décrit un document administratif. */
function soriyaIsAdmin_(fichier, statut) {
  const s = String(statut), f = String(fichier);
  if (!/^À vérifier/.test(s) || /^Facture/i.test(f) || /statistique sous-traitant/i.test(s)) return false;
  return /kbis|attestation|administratif|urssaf|vigilance|assurance|licence de transport|dossier sous-traitant|\bRIB\b/i.test(s) ||
    /kbis|attestation|relance|urssaf|assurance|licence/i.test(f);
}

function soriyaAdminSheet_(j) {
  let sh = j.ss.getSheetByName(SORIYA_ADMIN.SHEET);
  if (!sh) {
    sh = j.ss.insertSheet(SORIYA_ADMIN.SHEET);
    sh.getRange(1, 1, 1, SORIYA_ADMIN_HEADERS.length).setValues([SORIYA_ADMIN_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Premier document administratif du journal pas encore lu : lecture IA, rangement, onglet. @return {boolean} */
function soriyaAdminNouveau_(j) {
  const n = j.main.getLastRow() - 1;
  if (n < 1) return false;
  const col = function (title) { return j.headers.indexOf(title); };
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  let sh = null, keys = null;
  for (let r = rows.length - 1; r >= 0; r--) { // les plus récents d'abord
    const key = String(rows[r][col('Clé')]);
    if (!key || !soriyaIsAdmin_(rows[r][col('Fichier reçu')], rows[r][col('Statut')])) continue;
    sh = sh || soriyaAdminSheet_(j);
    keys = keys || new Set(soriyaSheetRows_(sh).map(function (x) { return String(x[0]); }));
    if (keys.has(key)) continue;
    const base = [key, rows[r][col('Reçu le')], rows[r][col('Expéditeur')], rows[r][col('Objet')]];
    const id = (/\/d\/([\w-]+)/.exec(String(rows[r][col('Lien Drive')])) || [])[1];
    let file = null;
    try { file = id ? DriveApp.getFileById(id) : null; } catch (e) { /* fichier supprimé */ }
    if (!file) {
      sh.appendRow(base.concat(['', '', '', '', '', '', '', '', '', '', '', '', new Date(), 'Fichier introuvable']));
      return true;
    }
    const d = soriyaClaudeJson_(file.getBlob(), soriyaAdminPrompt_(), soriyaAdminSchema_(),
      'Objet du mail : ' + rows[r][col('Objet')] + ' — expéditeur : ' + rows[r][col('Expéditeur')] +
      '\nIdentifie ce document et extrais ses informations.', null, 4000);
    if (!d.est_document_administratif) {
      sh.appendRow(base.concat(['', '', '', '', '', '', '', '', '', '', '', '', new Date(),
        'Pas un document administratif : ' + d.remarques]));
      return true;
    }
    const folder = soriyaSubFolder_(soriyaRootFolder_('confirmation'), [SORIYA_ADMIN.FOLDER]);
    let name = file.getName();
    if (!/^\d{2}-\d{2}-\d{4}_/.test(name) || /_Confirmation_affretement_/.test(name)) {
      const date = soriyaParseDate_(d.date_document) ||
        (rows[r][col('Reçu le')] instanceof Date ? rows[r][col('Reçu le')] : new Date());
      name = soriyaUniqueName_(folder, Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy') + '_' +
        String(d.type_document).replace(/[^A-Za-zÀ-ÿ0-9]+/g, '_').replace(/^_|_$/g, '') + '.pdf');
      file.setName(name);
      file.moveTo(folder);
    }
    sh.appendRow(base.concat([d.type_document, d.emetteur, d.destinataire, "'" + d.date_document,
      "'" + d.valable_jusqu_au, d.societe_concernee, "'" + d.reference, d.resume, (d.pieces_demandees || []).join(' ; '),
      "'" + d.date_limite, name, file.getUrl(), new Date(), d.remarques, folder.getUrl()]));
    j.main.getRange(r + 2, col('Nom dans Drive') + 1, 1, 3).setValues([[name, file.getUrl(),
      'Document administratif — ' + d.type_document + ' — voir l\'onglet « ' + SORIYA_ADMIN.SHEET + ' »']]);
    return true;
  }
  return false;
}

function soriyaAdminPrompt_() {
  return [
    'Tu es Soriya, assistante administrative de GFD-LOGISTIC, transporteur sous-traitant d\'Ecotime.',
    'Tu lis les documents administratifs du dossier sous-traitant : extraits Kbis, attestations de vigilance URSSAF,',
    'attestations de paiement, attestations d\'assurance, licences de transport, RIB, contrats, et les courriers',
    'd\'Ecotime qui demandent de mettre à jour ces pièces.',
    '',
    'Règles :',
    "- Recopie les valeurs telles qu'elles figurent sur le document ; n'invente rien ; chaîne vide si absent.",
    '- Dates au format AAAA-MM-JJ. date_document = date de délivrance / « à jour au » / date du courrier.',
    '- valable_jusqu_au = date de fin de validité ou d\'expiration imprimée sur le document, sinon "".',
    '- Pour une demande de documents : pieces_demandees = chaque pièce réclamée (avec le motif, ex. « Extrait Kbis',
    '  (expiré depuis le 17/03/2026) ») et date_limite = la date limite de réponse si indiquée.',
    '- resume = une phrase qui dit ce que contient le document.',
    '- Si ce n\'est pas un document administratif, mets est_document_administratif à false.',
  ].join('\n');
}

function soriyaAdminSchema_() {
  const str = { type: 'string' };
  const props = {
    est_document_administratif: { type: 'boolean' },
    type_document: { type: 'string', enum: SORIYA_ADMIN_TYPES },
    emetteur: str, destinataire: str, date_document: str, valable_jusqu_au: str, societe_concernee: str,
    reference: { type: 'string', description: 'n° SIREN / RCS, n° d\'attestation, n° de licence…' },
    resume: str, pieces_demandees: { type: 'array', items: str }, date_limite: str, remarques: str,
  };
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}
