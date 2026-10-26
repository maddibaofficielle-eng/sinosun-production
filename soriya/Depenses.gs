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
  'Immatriculation', 'Kilométrage', 'N° ticket', 'Nom dans Drive', 'Lien Drive', 'Traité le', 'Remarques', 'Dossier',
  'Type de pièce'];
const SORIYA_DEPENSES_CATEGORIES = ['Carburant', 'Péage', 'Parking', 'Lavage', 'Entretien', 'Réparation', 'Pièces',
  'Restauration', 'Téléphone', 'Fournitures', 'Assurance', 'Comptabilité', 'Logiciels / IA', 'Autre'];
const SORIYA_DEPENSES_TYPES = ['Ticket de caisse', 'Facture', 'Devis', 'Autre'];

/** Statut « À vérifier » d'un document WhatsApp qui est un ticket de caisse / reçu de dépense. */
function soriyaIsTicket_(statut) {
  return /^À vérifier/.test(String(statut)) && !/^À vérifier — pas un ticket/.test(String(statut)) &&
    /ticket de caisse|ticket de carburant|re[çc]u de paiement|station[- ]service|carburant|gazole|gasoil|diesel|péage|facturette|^À vérifier — (Facture|Devis)|\b(une|cette) facture\b|\b(un|ce) devis\b/i
      .test(String(statut));
}

/** Propriétaire d'une pièce d'après le numéro WhatsApp qui l'a envoyée (SORIYA_CONFIG.WHATSAPP_OWNERS). */
function soriyaOwnerOf_(sender) {
  const digits = String(sender || '').replace(/\D/g, '').replace(/^33/, '0');
  const owners = SORIYA_CONFIG.WHATSAPP_OWNERS || {};
  for (const k in owners) if (k.replace(/\D/g, '').replace(/^33/, '0') === digits) return owners[k];
  return '';
}

function soriyaDepensesSheet_(j) {
  let sh = j.ss.getSheetByName(SORIYA_DEPENSES.SHEET);
  if (!sh) {
    sh = j.ss.insertSheet(SORIYA_DEPENSES.SHEET);
    sh.getRange(1, 1, 1, SORIYA_DEPENSES_HEADERS.length).setValues([SORIYA_DEPENSES_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < SORIYA_DEPENSES_HEADERS.length) {
    sh.getRange(1, 1, 1, SORIYA_DEPENSES_HEADERS.length).setValues([SORIYA_DEPENSES_HEADERS]).setFontWeight('bold');
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
  // « +33… » écrit sans apostrophe : Sheets l'a pris pour une formule (#ERROR!) → on remet l'expéditeur du journal.
  const dep = j.ss.getSheetByName(SORIYA_DEPENSES.SHEET);
  if (dep && dep.getLastRow() > 1) {
    const senderOf = {};
    rows.forEach(function (r) { senderOf[String(r[col('Clé')])] = String(r[col('Expéditeur')]); });
    const range = dep.getRange(2, 1, dep.getLastRow() - 1, 3);
    const vals = range.getValues(), forms = range.getFormulas();
    vals.forEach(function (v, i) {
      if ((forms[i][2] || /^#/.test(String(v[2]))) && senderOf[String(v[0])]) {
        dep.getRange(i + 2, 3).setValue("'" + senderOf[String(v[0])].replace(/^'/, ''));
      }
    });
    // Propriétaire d'après le numéro (tableau WHATSAPP_OWNERS) : appliqué aussi aux pièces déjà rangées.
    const who = dep.getRange(2, 3, dep.getLastRow() - 1, 2).getValues();
    who.forEach(function (w, i) {
      const owner = soriyaOwnerOf_(senderOf[String(vals[i][0])] || w[0]);
      if (owner && owner !== w[1]) dep.getRange(i + 2, 4).setValue(owner);
    });
  }
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
        'Reçu par WhatsApp de ' + sender + '. Extrais les informations de cette pièce (ticket, facture ou devis).', null, 3000);
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
    const kind = { 'Facture': 'Facture', 'Devis': 'Devis' }[d.type_piece] || 'Ticket';
    const name = soriyaUniqueName_(folder, Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy') +
      '_' + kind + '_' + cat + (d.enseigne ? '_' + String(d.enseigne).toUpperCase().replace(/[^A-Z0-9À-Ý]+/g, '-').replace(/^-|-$/g, '') : '') + '.pdf');
    file.setName(name);
    file.moveTo(folder);
    const plate = String(d.immatriculation || '').replace(/[\s-]/g, '').toUpperCase();
    const driver = soriyaOwnerOf_(sender) || drivers.byPlate[plate] || drivers.bySender[sender] || '';
    sh.appendRow([key, rows[r][col('Reçu le')], "'" + sender.replace(/^'/, ''), driver, cat, "'" + d.date, "'" + d.heure, d.enseigne, d.adresse,
      d.ville, d.carburant, d.litres, d.prix_litre, d.montant_ttc, d.tva, d.montant_ht, d.moyen_paiement,
      d.immatriculation, d.kilometrage, "'" + d.numero_ticket, name, file.getUrl(), new Date(), d.remarques,
      soriyaSubFolder_(root, [SORIYA_DEPENSES.FOLDER]).getUrl(), d.type_piece || 'Ticket de caisse']);
    j.main.getRange(r + 2, col('Nom dans Drive') + 1, 1, 3).setValues([[name, file.getUrl(),
      'Dépense — ' + (d.type_piece || 'Ticket') + ' — ' + cat + ' — voir l\'onglet « ' + SORIYA_DEPENSES.SHEET + ' »']]);
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
    'Tu es Soriya, assistante de GFD-LOGISTIC (transport). Tu lis les pièces de dépense envoyées sur WhatsApp',
    '(photo, capture d\'écran ou PDF) : surtout des tickets de carburant de station-service, mais aussi des factures',
    'et des devis (garage, pièces, entretien, téléphone…), des tickets de péage, parking, lavage ou repas.',
    'type_piece = Ticket de caisse, Facture ou Devis selon le document.',
    '',
    'Règles :',
    "- Recopie les valeurs telles qu'elles figurent sur le ticket ; n'invente rien.",
    '- Texte absent : "" ; nombre absent : 0. Dates au format AAAA-MM-JJ, heure HH:MM.',
    '- Montants : nombres (point décimal). montant_ttc = total payé ; tva et montant_ht si imprimés, sinon 0.',
    '- Carburant : carburant = type (Gazole, SP95, SP98, E85, AdBlue…), litres = volume, prix_litre = prix au litre TTC.',
    '- enseigne = la marque de la station ou du commerce (TotalEnergies, Esso, Leclerc…), ville avec code postal si visible.',
    '- Ignore l\'interface autour du ticket sur une capture d\'écran.',
    '- est_ticket_de_caisse = true pour toute pièce de dépense (ticket, facture ou devis d\'un fournisseur) ; false sinon',
    '  (lettre de voiture, bon de livraison, facture émise par GFD-LOGISTIC à un client…).',
  ].join('\n');
}

function soriyaTicketSchema_() {
  const str = { type: 'string' }, num = { type: 'number' };
  const props = {
    est_ticket_de_caisse: { type: 'boolean' }, type_piece: { type: 'string', enum: SORIYA_DEPENSES_TYPES },
    categorie: { type: 'string', enum: SORIYA_DEPENSES_CATEGORIES },
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
  // « title contains » ne cherche qu'en début de mot : on cherche par date en tête de nom (08-10-2026_…)
  // et par la description posée par Soriya.
  const queries = ['trashed = true and fullText contains "Archivé par Soriya depuis WhatsApp"'];
  for (let d = new Date(since.getTime()); d <= new Date(); d = new Date(d.getTime() + 86400000)) {
    queries.push('trashed = true and title contains "' + Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd-MM-yyyy') + '"');
  }
  const seen = {};
  let n = 0;
  for (let q = 0; q < queries.length; q++) {
   const it = DriveApp.searchFiles(queries[q]);
   while (it.hasNext()) {
    const f = it.next();
    if (seen[f.getId()]) continue;
    seen[f.getId()] = true;
    const desc = String(f.getDescription() || '');
    if (desc.indexOf('Archivé par Soriya depuis WhatsApp') !== 0) continue;
    const wa = (/Nom WhatsApp : (\S.*)/.exec(desc) || [])[1];
    const info = wa ? soriyaWhatsAppParseName_(wa) : null;
    if (!info || !info.date || info.date < since) continue;
    const name = /\.pdf$/i.test(wa) || f.getMimeType() !== 'application/pdf' ? wa : wa.replace(/\.[a-z0-9]{2,4}$/i, '') + '.pdf';
    f.setTrashed(false);
    f.setName(name);
    f.moveTo(inbox);
    Logger.log('Remis dans le dossier d\'entrée : %s', name);
    n++;
   }
  }
  return n;
}

// ---------- Frais généraux : factures fournisseurs reçues par e-mail (Keobiz, Anthropic…) ----------

/** Fournisseurs suivis : recherche Gmail, catégorie, pièce jointe à retenir (les reçus / rappels en double sont ignorés). */
const SORIYA_FRAIS_GENERAUX = [
  { query: 'from:keobiz', fournisseur: 'Keobiz', categorie: 'Comptabilité', piece: /^invoice_FAC/i }, // pas la TVA, la paie ni les tableaux de charges
  { query: 'from:anthropic.com', fournisseur: 'Anthropic (Claude)', categorie: 'Logiciels / IA', piece: /^Invoice/i },
];

/**
 * Factures des fournisseurs suivis : lecture IA (n°, date, HT, TVA, TTC), PDF rangé dans « Dépenses / Frais généraux »,
 * ligne dans l'onglet « Dépenses » (chauffeur « GFD (frais généraux) ») ; l'interface les montre dans Dépenses ›
 * Frais généraux. Une même facture reçue deux fois (facture + rappel d'encaissement) n'est comptée qu'une fois.
 * @return {number} factures ajoutées
 */
function soriyaFraisGeneraux_(started) {
  if (!PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY')) return 0;
  const root = soriyaRootFolder_('lettre_voiture');
  const j = soriyaJournalSpreadsheet_(root, 'lettre_voiture');
  const sh = soriyaDepensesSheet_(j);
  soriyaFraisGenerauxNettoyer_(sh);
  const keys = new Set(soriyaSheetRows_(sh).map(function (r) { return String(r[0]); }));
  const tz = Session.getScriptTimeZone();
  let added = 0;
  for (let f = 0; f < SORIYA_FRAIS_GENERAUX.length; f++) {
    const fr = SORIYA_FRAIS_GENERAUX[f];
    let count = 0; // 6 par fournisseur et par passage, pour que chacun avance
    const threads = GmailApp.search('(' + fr.query + ') has:attachment filename:pdf after:' +
      Utilities.formatDate(soriyaHistoryStart_(), tz, 'yyyy/MM/dd'), 0, 50);
    for (let t = 0; t < threads.length; t++) {
      const msgs = threads[t].getMessages();
      for (let m = 0; m < msgs.length; m++) {
        const atts = soriyaPdfs_(msgs[m]).filter(function (a) { return fr.piece.test(a.getName()); });
        for (let a = 0; a < atts.length; a++) {
          if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) return added;
          if (count >= 6) break;
          const key = 'fg:' + fr.fournisseur + ':' + atts[a].getName();
          if (keys.has(key)) continue;
          keys.add(key);
          const d = soriyaClaudeJson_(atts[a].copyBlob(), [
            'Tu lis une facture fournisseur reçue par GFD-LOGISTIC (transporteur). Recopie les valeurs telles qu\'imprimées ;',
            'dates au format AAAA-MM-JJ ; montants en nombres (point décimal) ; chaîne vide ou 0 si absent.'].join('\n'), {
            type: 'object', additionalProperties: false,
            required: ['numero', 'date', 'montant_ht', 'tva', 'montant_ttc', 'objet'],
            properties: { numero: { type: 'string' }, date: { type: 'string' }, montant_ht: { type: 'number' }, tva: { type: 'number' },
              montant_ttc: { type: 'number' }, objet: { type: 'string' } },
          }, 'Facture de ' + fr.fournisseur + ' — objet du mail : ' + msgs[m].getSubject(), null, 1500);
          const date = soriyaParseDate_(d.date) || msgs[m].getDate();
          const folder = soriyaSubFolder_(root, [SORIYA_DEPENSES.FOLDER, 'Frais généraux']);
          const name = soriyaUniqueName_(folder, Utilities.formatDate(date, tz, 'dd-MM-yyyy') + '_Facture_' +
            fr.fournisseur.replace(/[^A-Za-zÀ-ÿ0-9]+/g, '_').replace(/_$/, '') + (d.numero ? '_' + String(d.numero).replace(/[^\w-]+/g, '') : '') + '.pdf');
          const file = folder.createFile(atts[a].copyBlob().setName(name));
          sh.appendRow([key, msgs[m].getDate(), "'" + msgs[m].getFrom(), 'GFD (frais généraux)', fr.categorie,
            "'" + Utilities.formatDate(date, tz, 'yyyy-MM-dd'), '', fr.fournisseur, '', '', '', '', '',
            d.montant_ttc || '', d.tva || '', d.montant_ht || '', '', '', '', "'" + (d.numero || ''), name, file.getUrl(), new Date(),
            d.objet || '', folder.getUrl(), 'Facture']);
          added++; count++;
        }
      }
    }
  }
  return added;
}

/** Retire les lignes de frais généraux dont la pièce n'est pas retenue par le filtre, avec la copie PDF faite par Soriya. */
function soriyaFraisGenerauxNettoyer_(sh) {
  const rows = soriyaSheetRows_(sh);
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = String(rows[i][0]).match(/^fg:([^:]+):(.*)$/);
    if (!m) continue;
    const fr = SORIYA_FRAIS_GENERAUX.filter(function (x) { return x.fournisseur === m[1]; })[0];
    if (fr && fr.piece.test(m[2])) continue;
    const id = (String(rows[i][21]).match(/[-\w]{25,}/) || [])[0];
    if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* déjà supprimé */ } }
    sh.deleteRow(i + 2);
  }
}
