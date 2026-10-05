/**
 * Soriya — suivi de la prospection (diversification des donneurs d'ordre).
 *
 * La liste vit dans le Google Sheet « Soriya - Prospects » (dossier des confirmations) : vous y mettez à jour
 * le statut et la prochaine action de chaque société ; l'interface web l'affiche en direct.
 * Pré-remplie avec des sociétés d'affrètement / transport express d'Île-de-France qui travaillent avec
 * des transporteurs sous-traitants (même modèle qu'Ecotime : potentiel fort).
 */

const SORIYA_PROSPECTS_NAME = 'Soriya - Prospects';
const SORIYA_PROSPECTS_HEADERS = ['Société', 'Type', 'Potentiel', 'Pourquoi', 'Site / contact', 'Statut',
  'Prochaine action', 'Date dernière action', 'Notes'];
const SORIYA_PROSPECTS_STATUSES = ['À contacter', 'Contacté', 'Rendez-vous', 'Test en cours', 'Client', 'Pas intéressé'];

// Liste de départ (sources publiques, octobre 2026). Vérifiez les coordonnées avant le premier contact.
const SORIYA_PROSPECTS_SEED = [
  ['Réseau Express', 'Réseau d\'affrètement express', 'Fort',
    'Plus de 500 partenaires, recrute des transporteurs express et artisans louageurs via un formulaire de partenariat.',
    'https://www.reseau-express.fr/reseau-transport.htm'],
  ['Perceval-Express', 'Plateforme d\'affrètement express', 'Fort',
    'Met en relation affréteurs et transporteurs partenaires basés en Île-de-France ; page « Devenir partenaire ».',
    'https://www.perceval-express.com/partenaire/'],
  ['Transport Express Paris', 'Transport express / affrètement', 'Fort',
    'Plateformes à Gonesse, Aulnay-sous-Bois et Évry près de Roissy : même zone que vos courses actuelles.',
    'https://transportexpressparis.fr/'],
  ['ASN Transport', 'Transport express / courses urgentes', 'Fort',
    'Livraison urgente Paris / Île-de-France, ouverte aux nouvelles collaborations (contact par e-mail ou téléphone).',
    'https://asntransport-paris.com/'],
  ['Cergy Courses Express', 'Courses urgentes / affrètement', 'Fort',
    'Depuis 1994 à Saint-Ouen-l\'Aumône (95), 40 personnes : courses urgentes, distribution, affrètement.',
    'https://www.cergy-courses-express.fr/'],
  ['ART&FACT Transport', 'Express / groupage / affrètement', 'Moyen',
    'Basé près de Roissy-en-France, affrète des véhicules légers 20 m³ : intéressant pour vos grands volumes.',
    'https://www.artefact-transport.fr/'],
  ['B2PWeb', 'Bourse de fret', 'Fort',
    'Les commissionnaires y publient des courses chaque jour : source de courses immédiate, sans démarchage.',
    'https://www.b2pweb.com/'],
  ['Teleroute', 'Bourse de fret', 'Fort',
    'Bourse de fret européenne très utilisée en France : complète B2PWeb pour remplir les jours calmes.',
    'https://www.teleroute.com/'],
  ['Annuaire PagesJaunes « affréteurs Île-de-France »', 'Liste à exploiter', 'Moyen',
    'Liste d\'affréteurs franciliens à appeler par lots de 10 avec votre fiche de présentation.',
    'https://www.pagesjaunes.fr/annuaire/region/ile-de-france/affreteur'],
];

/** Ouvre (ou crée et pré-remplit) le Sheet des prospects. */
function soriyaProspectsSheet_() {
  const root = soriyaRootFolder_('confirmation');
  const it = root.getFilesByName(SORIYA_PROSPECTS_NAME);
  if (it.hasNext()) return SpreadsheetApp.open(it.next()).getSheets()[0];
  const ss = SpreadsheetApp.create(SORIYA_PROSPECTS_NAME);
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(root);
  // Vous mettez à jour les statuts vous-même : accès en modification pour les adresses de SHARE_WITH.
  (SORIYA_CONFIG.SHARE_WITH || []).forEach(function (email) {
    try { file.addEditor(email); } catch (e) { Logger.log('Partage prospects %s : %s', email, e.message); }
  });
  const sh = ss.getSheets()[0];
  sh.setName('Prospects');
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  const rows = SORIYA_PROSPECTS_SEED.map(function (p) {
    return [p[0], p[1], p[2], p[3], p[4], 'À contacter', 'Envoyer la fiche de présentation', today, ''];
  });
  sh.getRange(1, 1, 1, SORIYA_PROSPECTS_HEADERS.length).setValues([SORIYA_PROSPECTS_HEADERS]).setFontWeight('bold');
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  sh.setFrozenRows(1);
  // Listes déroulantes pour le statut et le potentiel.
  sh.getRange(2, 6, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(SORIYA_PROSPECTS_STATUSES, true).build());
  sh.getRange(2, 3, 500, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Fort', 'Moyen', 'Faible'], true).build());
  sh.autoResizeColumns(1, SORIYA_PROSPECTS_HEADERS.length);
  return sh;
}

/** Prospects pour l'interface web. */
function soriyaWebProspects_() {
  const sh = soriyaProspectsSheet_();
  const n = sh.getLastRow() - 1;
  const url = sh.getParent().getUrl();
  if (n < 1) return { url: url, list: [] };
  const fmt = function (x) {
    return x instanceof Date ? Utilities.formatDate(x, Session.getScriptTimeZone(), 'dd/MM/yyyy') : String(x || '');
  };
  return {
    url: url,
    list: sh.getRange(2, 1, n, SORIYA_PROSPECTS_HEADERS.length).getValues()
      .filter(function (r) { return r[0]; })
      .map(function (r) {
        return { name: fmt(r[0]), type: fmt(r[1]), potential: fmt(r[2]), why: fmt(r[3]), link: fmt(r[4]),
          status: fmt(r[5]) || 'À contacter', next: fmt(r[6]), date: fmt(r[7]) };
      }),
  };
}
