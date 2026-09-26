/**
 * Soriya — le "cerveau" : lecture d'une confirmation d'affrètement PDF par Claude.
 * Appel HTTP direct à l'API Messages (Apps Script n'a pas de SDK Anthropic).
 */

const SORIYA_SYSTEM_PROMPT = [
  "Tu es Soriya, assistante spécialisée en transport routier et en affrètement pour l'équipe Ecotime.",
  "Tu lis des confirmations d'affrètement (aussi appelées confirmations de commande de transport,",
  "lettres de voiture d'affrètement ou ordres de transport) et tu en extrais les informations clés.",
  '',
  'Règles :',
  "- Recopie les valeurs telles qu'elles figurent sur le document ; n'invente rien.",
  '- Si une information est absente ou illisible, renvoie une chaîne vide "".',
  '- Dates au format AAAA-MM-JJ.',
  '- Montants : nombre seul avec un point décimal (ex. "1250.00"), sans symbole monétaire.',
  "- Si le PDF n'est pas une confirmation d'affrètement (facture, CMR seule, publicité...),",
  '  mets est_confirmation_affretement à false et explique pourquoi dans remarques.',
  "- confiance = \"haute\" si les champs principaux sont nets, \"moyenne\" s'il y a un doute, \"basse\" sinon.",
].join('\n');

const SORIYA_FIELDS = [
  'numero_affretement', 'date_confirmation', 'donneur_ordre', 'transporteur',
  'lieu_chargement', 'date_chargement', 'lieu_livraison', 'date_livraison',
  'marchandise', 'poids', 'immatriculation', 'prix_ht', 'devise', 'remarques',
];

function soriyaSchema_() {
  const properties = {};
  SORIYA_FIELDS.forEach(function (f) { properties[f] = { type: 'string' }; });
  properties.est_confirmation_affretement = { type: 'boolean' };
  properties.confiance = { type: 'string', enum: ['haute', 'moyenne', 'basse'] };
  return {
    type: 'object',
    properties: properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * Envoie le PDF à Claude et renvoie l'objet extrait, ou lève une erreur explicite.
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @param {string} emailSubject contexte utile (le sujet du mail aide souvent)
 */
function soriyaReadPdf(pdfBlob, emailSubject) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY non configurée');

  const body = {
    model: SORIYA_CONFIG.CLAUDE_MODEL,
    max_tokens: 16000,
    fallbacks: 'default',
    system: SORIYA_SYSTEM_PROMPT,
    output_config: {
      effort: SORIYA_CONFIG.CLAUDE_EFFORT,
      format: { type: 'json_schema', schema: soriyaSchema_() },
    },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: Utilities.base64Encode(pdfBlob.getBytes()),
          },
        },
        {
          type: 'text',
          text: 'Objet du mail : ' + (emailSubject || '(sans objet)') +
            '\nExtrais les informations de cette confirmation d\'affrètement.',
        },
      ],
    }],
  };

  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    // 429 (limite de débit) et 5xx/529 (surcharge) : on réessaie avec une attente croissante.
    if (code === 429 || code >= 500) {
      Utilities.sleep(2000 * attempt * attempt);
      continue;
    }
    break;
  }

  const code = response.getResponseCode();
  const raw = response.getContentText();
  if (code !== 200) {
    let msg = raw.slice(0, 300);
    try {
      const err = JSON.parse(raw).error;
      if (err) msg = err.type + ' — ' + err.message;
    } catch (e) { /* réponse non JSON : on garde le texte brut */ }
    throw new Error('API Claude HTTP ' + code + ' : ' + msg);
  }
  const json = JSON.parse(raw);
  if (json.stop_reason === 'refusal') {
    throw new Error('Claude a refusé de traiter ce document');
  }
  if (json.stop_reason === 'max_tokens') {
    throw new Error('Réponse de Claude tronquée (max_tokens)');
  }

  const textBlocks = json.content.filter(function (b) { return b.type === 'text'; });
  if (!textBlocks.length) throw new Error('Réponse de Claude sans texte');
  return JSON.parse(textBlocks[textBlocks.length - 1].text);
}
