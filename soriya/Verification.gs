/**
 * Soriya — vérification Gmail des confirmations manquantes.
 *
 * Pour chaque lettre de voiture (depuis août 2026) sans confirmation au journal, Soriya cherche son numéro dans
 * toute la boîte Gmail (« 659079 » ou « 659 079 »). Résultat dans l'onglet « Vérification Gmail » du Journal Soriya,
 * mis à jour une fois par jour. Si un mail trouvé porte un PDF que Soriya n'a pas lu (libellé manquant…), il reçoit
 * le libellé « ecotime » et une relecture est lancée : la confirmation entre au journal au passage suivant.
 */

const SORIYA_VERIF = {
  SHEET: 'Vérification Gmail',
  SINCE: '2026-08-01', // les lettres de voiture arrivent par WhatsApp depuis août 2026
  HEADERS: ['N° course', 'Date livraison', 'Chauffeur', 'Mails trouvés', 'Objet', 'De', 'Date du mail', 'PDF joint',
    'Déjà lu par Soriya', 'Résultat', 'Vérifié le'],
};

/** Une fois par jour (premier passage Mailing après minuit). @return {number} numéros vérifiés */
function soriyaVerifierConfirmationsManquantes_(started) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (props.getProperty('SORIYA_VERIF_GMAIL_DAY_V2') === today) return 0;
  // Noté dès le début : même interrompue, la vérification ne se relance pas avant demain (quota Gmail).
  props.setProperty('SORIYA_VERIF_GMAIL_DAY_V2', today);
  const since = Utilities.formatDate(new Date(Date.now() - 20 * 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const digits = function (s) { return String(s || '').replace(/\D/g, ''); };
  const conf = soriyaJournalSpreadsheet_(soriyaRootFolder_('confirmation'), 'confirmation');
  const cRows = soriyaSheetRows_(conf.main);
  const ch = conf.headers;
  const confNums = new Set(cRows.map(function (r) { return digits(r[ch.indexOf('N° affrètement')]); }).filter(String));
  const keys = new Set(cRows.map(function (r) { return String(r[ch.indexOf('Clé')]).split(':')[0]; }));

  const ldv = soriyaJournalSpreadsheet_(soriyaRootFolder_('lettre_voiture'), 'lettre_voiture');
  const lh = ldv.headers;
  const missing = {};
  soriyaSheetRows_(ldv.main).forEach(function (r) {
    const n = digits(r[lh.indexOf('N° lettre de voiture')]);
    const d = String(r[lh.indexOf('Date livraison')] instanceof Date
      ? Utilities.formatDate(r[lh.indexOf('Date livraison')], Session.getScriptTimeZone(), 'yyyy-MM-dd') : r[lh.indexOf('Date livraison')]);
    if (n.length < 5 || confNums.has(n) || d < SORIYA_VERIF.SINCE || d < since || !/^Archivé/.test(String(r[lh.indexOf('Statut')]))) return;
    const parts = String(r[lh.indexOf('Transporteur')]).split('/');
    missing[n] = { date: d.slice(0, 10), driver: parts[parts.length - 1].trim().toUpperCase() };
  });

  const out = [];
  let relabeled = 0;
  const extra = [];
  const label = GmailApp.getUserLabelByName(SORIYA_CONFIG.GMAIL_LABEL) || GmailApp.createLabel(SORIYA_CONFIG.GMAIL_LABEL);
  const nums = Object.keys(missing).sort().slice(-25); // 25 recherches au plus par jour
  for (let i = 0; i < nums.length; i++) {
    if (Date.now() - started > SORIYA_CONFIG.MAX_RUNTIME_MS) break;
    const n = nums[i], m = missing[n];
    const spaced = n.length === 6 ? n.slice(0, 3) + ' ' + n.slice(3) : n;
    const words = '("' + n + '" OR "' + spaced + '") after:2026/07/01';
    // Les relevés « LISTING » et les factures citent tous les numéros : on les écarte de la recherche.
    const threads = GmailApp.search(words + ' -subject:listing -filename:facture', 0, 5);
    if (!threads.length) {
      const inListing = GmailApp.search(words + ' subject:listing', 0, 1).length > 0;
      out.push([n, m.date, m.driver, 0, '', '', '', '', '', inListing
        ? 'Payée au relevé Ecotime, mais confirmation jamais reçue par e-mail'
        : 'Aucun mail ni relevé : confirmation jamais reçue (relevé du mois pas encore arrivé ?)', new Date()]);
      continue;
    }
    const msg = threads[0].getMessages()[0];
    const pdf = msg.getAttachments({ includeInlineImages: false }).some(function (a) {
      return a.getContentType() === 'application/pdf' || /\.pdf$/i.test(a.getName());
    });
    const read = keys.has(msg.getId());
    let result = read ? 'Mail déjà lu par Soriya (n° écrit autrement sur la confirmation ?)' : pdf ? 'Mail avec PDF non lu : relecture lancée' : 'Mail sans PDF (numéro cité dans le texte)';
    if (pdf && !read) { label.addToThread(threads[0]); extra.push(threads[0].getId()); relabeled++; }
    out.push([n, m.date, m.driver, threads.length, msg.getSubject(), msg.getFrom(), msg.getDate(), pdf ? 'oui' : 'non',
      read ? 'oui' : 'non', result, new Date()]);
  }
  // Plutôt qu'une relecture complète de la boîte (très coûteuse en quota), seuls ces mails seront lus.
  if (relabeled) {
    const prev = JSON.parse(props.getProperty('SORIYA_EXTRA_THREADS') || '[]');
    props.setProperty('SORIYA_EXTRA_THREADS', JSON.stringify(prev.concat(extra).slice(-50)));
  }

  let sh = conf.ss.getSheetByName(SORIYA_VERIF.SHEET);
  if (!sh) sh = conf.ss.insertSheet(SORIYA_VERIF.SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, SORIYA_VERIF.HEADERS.length).setValues([SORIYA_VERIF.HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (out.length) sh.getRange(2, 1, out.length, SORIYA_VERIF.HEADERS.length).setValues(out);
  return nums.length;
}
