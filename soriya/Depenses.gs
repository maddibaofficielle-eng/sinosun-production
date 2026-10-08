/**
 * Soriya — dépenses envoyées sur WhatsApp : tickets de caisse (surtout carburant, aussi péage, parking…).
 *
 * Le passage WhatsApp lit chaque fichier comme une lettre de voiture ; un ticket est reconnu par la lecture IA
 * (« Ticket de caisse … » dans le statut « À vérifier »). Soriya le relit alors comme un ticket, le range dans
 * « Ecotime - Lettres de Voiture / Dépenses / <Catégorie> » (nommé 07-10-2026_Ticket_Carburant_TOTAL.pdf) et
 * l'inscrit dans l'onglet « Dépenses » du Journal Lettres de voiture ; l'interface l'affiche dans « Dépenses ».
 */

const SORIYA_DEPENSES = { FOLDER: 'Dépenses', SHEET: 'Dépenses' };
const SORIYA_DEPENSES_HEADERS = ['Clé', 'Reçu le', 'Expéditeur', 'Chauffeur', 'Catégorie', 'Date', 'Heure', 'Enseigne',
  'Adresse', 'Ville', 'Carburant', 'Litres', 'Prix au litre', 'Montant TTC', 'TVA', 'Montant HT', 'Paiement',
  'Immatriculation', 'Kilométrage', 'N° ticket', 'Nom dans Drive', 'Lien Drive', 'Traité le', 'Remarques', 'Dossier'];
const SORIYA_DEPENSES_CATEGORIES = ['Carburant', 'Péage', 'Parking', 'Lavage', 'Entretien', 'Restauration', 'Autre'];

/** Statut « À vérifier » d'un document WhatsApp qui est un ticket de caisse / reçu de dépense. */
function soriyaIsTicket_(statut) {
  return /^À vérifier/.test(String(statut)) && !/^À vérifier — pas un ticket/.test(String(statut)) &&
    /ticket de caisse|ticket de carburant|re[çc]u de paiement|station[- ]service|carburant|gazole|gasoil|diesel|péage|facturette/i
      .test(String(statut));
}

function soriyaDepensesSheet_(j) {
  let sh = j.ss.getSheetByName(SORIYA_DEPENSES.SHEET);
  if (!sh) {
    sh = j.ss.insertSheet(SORIYA_DEPENSES.SHEET);
    sh.getRange(1, 1, 1, SORIYA_DEPENSES_HEADERS.length).setValues([SORIYA_DEPENSES_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Tickets reçus sur WhatsApp et pas encore lus : lecture IA, rangement, onglet « Dépenses ».
 * À lancer avant soriyaSupprimerLdvSansNumero_ (un ticket n'a pas de n° de lettre de voiture).
 * @return {number} tickets traités
 */
function soriyaDepensesNouvelles_(started, report) {
  if (!PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY')) return 0;
  const root = soriyaRootFolder_('lettre_voiture');
  const j = soriyaJournalSpreadsheet_(root, 'lettre_voiture');
  const n = j.main.getLastRow() - 1;
  if (n < 1) return 0;
  const col = function (title) { return j.headers.indexOf(title); };
  const rows = j.main.getRange(2, 1, n, j.headers.length).getValues();
  const todo = [];
  rows.forEach(function (r, i) { if (soriyaIsTicket_(r[col('Statut')])) todo.push(i); });
  if (!todo.length) return 0;
  const sh = soriyaDepensesSheet_(j);
  const known = new Set(soriyaSheetRows_(sh).map(function (x) { return String(x[0]); }));
  const drivers = soriyaDriversByPlateAndSender_(rows, col);
  let done = 0;
  for (let t = 0; t < todo.length; t++) {
    if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) break;
    const r = todo[t];
    const key = String(rows[r][col('Clé')]);
    if (!key || known.has(key)) continue;
    const sender = String(rows[r][col('Expéditeur')]);
    const id = (/\/d\/([\w-]+)/.exec(String(rows[r][col('Lien Drive')])) || [])[1];
    let file = null;
    try { file = id ? DriveApp.getFileById(id) : null; } catch (e) { /* fichier supprimé */ }
    if (!file) continue;
    let d;
    try {
      d = soriyaClaudeJson_(file.getBlob(), soriyaTicketPrompt_(), soriyaTicketSchema_(),
        'Reçu par WhatsApp de ' + sender + '. Extrais les informations de ce ticket.', null, 3000);
    } catch (e) {
      report.errors.push('Ticket ' + file.getName() + ' : ' + e.message);
      if (soriyaIsApiOutage_(e)) break;
      continue;
    }
    if (!d.est_ticket_de_caisse) {
      // Pas un ticket : la ligne reste « À vérifier » (statut précisé pour ne pas la relire).
      j.main.getRange(r + 2, col('Statut') + 1).setValue('À vérifier — pas un ticket : ' + d.remarques);
      continue;
    }
    const cat = d.categorie || 'Autre';
    const folder = soriyaSubFolder_(root, [SORIYA_DEPENSES.FOLDER, cat]);
    const date = soriyaParseDate_(d.date) || (rows[r][col('Reçu le')] instanceof Date ? rows[r][col('Reçu le')] : new Date());
    const name = soriyaUniqueName_(folder, Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy') +
      '_Ticket_' + cat + (d.enseigne ? '_' + String(d.enseigne).toUpperCase().replace(/[^A-Z0-9À-Ý]+/g, '-').replace(/^-|-$/g, '') : '') + '.pdf');
    file.setName(name);
    file.moveTo(folder);
    const plate = String(d.immatriculation || '').replace(/[\s-]/g, '').toUpperCase();
    const driver = drivers.byPlate[plate] || drivers.bySender[sender] || '';
    sh.appendRow([key, rows[r][col('Reçu le')], sender, driver, cat, "'" + d.date, "'" + d.heure, d.enseigne, d.adresse,
      d.ville, d.carburant, d.litres, d.prix_litre, d.montant_ttc, d.tva, d.montant_ht, d.moyen_paiement,
      d.immatriculation, d.kilometrage, "'" + d.numero_ticket, name, file.getUrl(), new Date(), d.remarques,
      soriyaSubFolder_(root, [SORIYA_DEPENSES.FOLDER]).getUrl()]);
    j.main.getRange(r + 2, col('Nom dans Drive') + 1, 1, 3).setValues([[name, file.getUrl(),
      'Dépense — ' + cat + ' — voir l\'onglet « ' + SORIYA_DEPENSES.SHEET + ' »']]);
    known.add(key);
    done++;
  }
  return done;
}

/** Chauffeur d'après les lettres de voiture : par immatriculation, ou par expéditeur s'il n'envoie que pour un chauffeur. */
function soriyaDriversByPlateAndSender_(rows, col) {
  const byPlate = {}, senders = {};
  rows.forEach(function (r) {
    const c = String(r[col('Transporteur')] || '');
    if (!c) return;
    const parts = c.split('/');
    const driver = parts[parts.length - 1].trim().toUpperCase();
    const plate = String(r[col('Immatriculation')] || '').replace(/[\s-]/g, '').toUpperCase();
    if (plate) byPlate[plate] = driver;
    const s = String(r[col('Expéditeur')]);
    (senders[s] = senders[s] || {})[driver] = true;
  });
  const bySender = {};
  Object.keys(senders).forEach(function (s) {
    const ds = Object.keys(senders[s]);
    if (ds.length === 1) bySender[s] = ds[0];
  });
  return { byPlate: byPlate, bySender: bySender };
}

function soriyaTicketPrompt_() {
  return [
    'Tu es Soriya, assistante de GFD-LOGISTIC (transport). Tu lis les tickets de caisse envoyés par les chauffeurs',
    'sur WhatsApp (photo ou capture d\'écran) : surtout des tickets de carburant de station-service, parfois péage,',
    'parking, lavage, entretien ou repas.',
    '',
    'Règles :',
    "- Recopie les valeurs telles qu'elles figurent sur le ticket ; n'invente rien.",
    '- Texte absent : "" ; nombre absent : 0. Dates au format AAAA-MM-JJ, heure HH:MM.',
    '- Montants : nombres (point décimal). montant_ttc = total payé ; tva et montant_ht si imprimés, sinon 0.',
    '- Carburant : carburant = type (Gazole, SP95, SP98, E85, AdBlue…), litres = volume, prix_litre = prix au litre TTC.',
    '- enseigne = la marque de la station ou du commerce (TotalEnergies, Esso, Leclerc…), ville avec code postal si visible.',
    '- Ignore l\'interface autour du ticket sur une capture d\'écran.',
    '- Si le document n\'est pas un ticket de caisse ou un reçu de dépense, mets est_ticket_de_caisse à false.',
  ].join('\n');
}

function soriyaTicketSchema_() {
  const str = { type: 'string' }, num = { type: 'number' };
  const props = {
    est_ticket_de_caisse: { type: 'boolean' }, categorie: { type: 'string', enum: SORIYA_DEPENSES_CATEGORIES },
    date: str, heure: str, enseigne: str, adresse: str, ville: str, carburant: str, litres: num, prix_litre: num,
    montant_ttc: num, tva: num, montant_ht: num, moyen_paiement: str, immatriculation: str, kilometrage: str,
    numero_ticket: str, remarques: str,
  };
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

/**
 * Reprise du 8 octobre 2026 : des tickets reçus avant la mise en service des « Dépenses » ont été lus comme des
 * lettres de voiture sans numéro, retirés du journal et mis à la corbeille. On les sort de la corbeille et on
 * les remet dans le dossier d'entrée WhatsApp sous leur nom d'origine : le passage suivant les relit comme tickets.
 * Seuls les documents reçus depuis le 8 octobre sont concernés (les lettres sans numéro plus anciennes restent
 * supprimées, comme demandé).
 * @return {number} fichiers remis dans le dossier d'entrée
 */
function soriyaRestaurerTicketsSupprimes_(since) {
  const inbox = soriyaWhatsAppInbox_();
  const it = DriveApp.searchFiles('trashed = true and title contains "Lettres_de_voiture"');
  let n = 0;
  while (it.hasNext()) {
    const f = it.next();
    const desc = String(f.getDescription() || '');
    if (desc.indexOf('Archivé par Soriya depuis WhatsApp') !== 0) continue;
    const wa = (/Nom WhatsApp : (\S.*)/.exec(desc) || [])[1];
    const info = wa ? soriyaWhatsAppParseName_(wa) : null;
    if (!info || !info.date || info.date < since) continue;
    const name = /\.pdf$/i.test(wa) || f.getMimeType() !== 'application/pdf' ? wa : wa.replace(/\.[a-z0-9]{2,4}$/i, '') + '.pdf';
    f.setTrashed(false);
    f.setName(name);
    f.moveTo(inbox);
    Logger.log('Remis dans le dossier d\'entrée : %s (%s)', name, f.getName());
    n++;
  }
  return n;
}
