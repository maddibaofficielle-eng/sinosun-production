/**
 * Soriya — discussion avec l'assistante depuis le site.
 *
 * La page envoie la question, l'historique récent et un résumé chiffré des données affichées (CA par mois et par
 * chauffeur, planning, factures, alertes…). Claude répond en s'appuyant uniquement sur ce résumé.
 * Appel direct (interface à clé, Web.gs) ou par le site à compte Google (soriya-web) via doPost : l'identité est
 * alors vérifiée avec le jeton Google de la personne connectée (OWNER_EMAIL ou SHARE_WITH seulement).
 */

const SORIYA_CHAT = {
  MAX_TOKENS: 1500,
  MAX_CONTEXT: 60000, // caractères du résumé des données
  HISTORY: 8,         // derniers échanges gardés
};

/** Réponse de Soriya (texte). */
function soriyaChatAnswer_(question, history, context) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('Clé API Claude absente : le chat est indisponible.');
  question = String(question || '').slice(0, 2000).trim();
  if (!question) throw new Error('Question vide');
  const tz = Session.getScriptTimeZone();
  const system = [
    "Tu es Soriya, l'assistante de gestion de GFD Logistic, transporteur express sous-traitant d'Ecotime (Île-de-France).",
    "Tu réponds au gérant en français, de façon brève, précise et chaleureuse, au vouvoiement.",
    'Tu t\'appuies UNIQUEMENT sur les données JSON fournies (résumé de l\'application, à jour au ' +
      Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm') + '). Si une information n\'y est pas, dis-le simplement et indique',
    'quelle page du site consulter (Tableau de bord, Planning, Courses & CA, Dépenses, Factures, Préparer une facture,',
    'Lettres de voiture, Rapprochement, Sous-traitants, Administratif, Chauffeurs).',
    'Montants : HT sauf mention contraire, format français (1 234,50 €). Ne jamais inventer de chiffre.',
    'Mise en forme : phrases courtes, listes à puces si utile, pas de tableau large. Pas de Markdown complexe (gras **…** permis).',
  ].join('\n');
  const msgs = [];
  (Array.isArray(history) ? history : []).slice(-SORIYA_CHAT.HISTORY * 2).forEach(function (m) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.text) msgs.push({ role: m.role, content: String(m.text).slice(0, 4000) });
  });
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const ctx = JSON.stringify(context || {}).slice(0, SORIYA_CHAT.MAX_CONTEXT);
  msgs.push({ role: 'user', content: '<donnees>\n' + ctx + '\n</donnees>\n\nQuestion : ' + question });
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: SORIYA_CONFIG.CLAUDE_MODEL, max_tokens: SORIYA_CHAT.MAX_TOKENS, system: system, messages: msgs }),
  });
  if (res.getResponseCode() !== 200) {
    let msg = res.getContentText().slice(0, 200);
    try { const err = JSON.parse(res.getContentText()).error; if (err) msg = err.message; } catch (e) { /* texte brut */ }
    throw new Error('Soriya ne peut pas répondre pour l\'instant (' + res.getResponseCode() + ' : ' + msg + ')');
  }
  const json = JSON.parse(res.getContentText());
  return json.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
}

/** Appel du site à compte Google : { token, question, history, context } → { answer } ou { error }. */
function soriyaChatPost_(body) {
  let email = '';
  try {
    const info = JSON.parse(UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(body.token || ''),
      { muteHttpExceptions: true }).getContentText());
    email = String(info.email || '').toLowerCase();
  } catch (e) { /* jeton illisible */ }
  const allowed = [SORIYA_CONFIG.OWNER_EMAIL].concat(SORIYA_CONFIG.SHARE_WITH || []).map(function (x) { return String(x).toLowerCase(); });
  if (!email || allowed.indexOf(email) < 0) return { error: 'Accès refusé au chat Soriya pour ce compte.' };
  try { return { answer: soriyaChatAnswer_(body.question, body.history, body.context) }; }
  catch (e) { return { error: e.message }; }
}
