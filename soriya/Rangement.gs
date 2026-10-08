/**
 * Soriya — rangement Gmail des mails Ecotime « Une mission vous a été attribuée ».
 *
 * Une fois lus par Soriya (libellé « ecotime/Archivé par Soriya »), ces mails sont déplacés dans un sous-libellé
 * du mois de leur réception, sous « ecotime » : « ecotime/2026-10 Octobre », « ecotime/2026-09 Septembre »…
 * Le sous-libellé du mois est créé automatiquement. « Déplacer » = ajouter le libellé du mois, retirer le libellé
 * « ecotime » et sortir le mail de la boîte de réception. Soriya les retrouve toujours (recherche par expéditeur).
 */

const SORIYA_RANGEMENT = {
  // Recherche Gmail des mails à ranger (seulement ceux encore dans la boîte de réception ou sous « ecotime »).
  // L'objet est vérifié dans le code (accents : « à été attribuée ») plutôt que par la recherche Gmail.
  QUERY: 'from:info@ecotimegroup.com {in:inbox label:ecotime}',
  MONTHS: ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre',
    'Novembre', 'Décembre'],
};

/** Nom du sous-libellé d'un mois : « ecotime/2026-10 Octobre » (ordre chronologique dans Gmail). */
function soriyaMissionLabelName_(date) {
  const tz = Session.getScriptTimeZone();
  const m = Number(Utilities.formatDate(date, tz, 'M'));
  return SORIYA_CONFIG.GMAIL_LABEL + '/' + Utilities.formatDate(date, tz, 'yyyy-MM') + ' ' + SORIYA_RANGEMENT.MONTHS[m - 1];
}

/**
 * Range les mails « mission attribuée » déjà lus par Soriya. Par lots de 100 conversations, tant qu'il reste du temps.
 * @return {number} conversations rangées
 */
function soriyaRangerMissions_(started) {
  const done = GmailApp.getUserLabelByName(SORIYA_CONFIG.PROCESSED_LABEL);
  const parent = GmailApp.getUserLabelByName(SORIYA_CONFIG.GMAIL_LABEL);
  if (!done) return 0;
  // Le libellé du mois en cours existe toujours, même avant le premier mail du mois.
  soriyaLabel_(soriyaMissionLabelName_(new Date()));
  let moved = 0, skipped = 0;
  while (Date.now() - started < SORIYA_CONFIG.MAX_RUNTIME_MS) {
    // Les conversations rangées sortent de la recherche ; celles laissées de côté (pas encore lues) sont sautées.
    const page = GmailApp.search(SORIYA_RANGEMENT.QUERY, skipped, 100);
    if (!page.length) break;
    const threads = page.filter(function (t) {
      // Seulement les mails déjà lus et archivés par Soriya, et vraiment « mission attribuée ».
      return /mission vous (a|à) été attribu/i.test(t.getFirstMessageSubject()) &&
        t.getLabels().some(function (l) { return l.getName() === SORIYA_CONFIG.PROCESSED_LABEL; });
    });
    skipped += page.length - threads.length;
    const byMonth = {};
    threads.forEach(function (t) {
      const name = soriyaMissionLabelName_(t.getMessages()[0].getDate());
      (byMonth[name] = byMonth[name] || []).push(t);
    });
    Object.keys(byMonth).forEach(function (name) {
      const list = byMonth[name];
      soriyaLabel_(name).addToThreads(list);
      if (parent) parent.removeFromThreads(list);
      GmailApp.moveThreadsToArchive(list);
      moved += list.length;
    });
    if (page.length < 100) break;
  }
  return moved;
}

function soriyaLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
