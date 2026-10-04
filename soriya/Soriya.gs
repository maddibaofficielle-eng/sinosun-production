/**
 * Soriya — le "cerveau" : lecture des documents de transport PDF par Claude.
 * Appel HTTP direct à l'API Messages (Apps Script n'a pas de SDK Anthropic).
 */

/**
 * Types de documents que Soriya sait lire. Chaque activité choisit le sien :
 *   Mailing  → 'confirmation'   (confirmations d'affrètement reçues par e-mail)
 *   WhatsApp → 'lettre_voiture' (lettres de voiture reçues sur WhatsApp)
 * fields = [clé extraite, titre de colonne dans le Journal], dans l'ordre des colonnes.
 */
const SORIYA_DOC_TYPES = {
  confirmation: {
    label: "confirmation d'affrètement",
    description: "des confirmations d'affrètement (aussi appelées confirmations de commande de transport " +
      "ou ordres de transport), envoyées par le donneur d'ordre au transporteur",
    typeFlag: 'est_confirmation_affretement',
    fields: [
      ['numero_affretement', 'N° affrètement'], ['date_confirmation', 'Date confirmation'],
      ['donneur_ordre', "Donneur d'ordre"], ['transporteur', 'Transporteur'],
      ['lieu_chargement', 'Lieu chargement'], ['date_chargement', 'Date chargement'],
      ['lieu_livraison', 'Lieu livraison'], ['date_livraison', 'Date livraison'],
      ['marchandise', 'Marchandise'], ['poids', 'Poids'], ['immatriculation', 'Immatriculation'],
      ['prix_ht', 'Prix HT'], ['devise', 'Devise'],
    ],
    dateFields: ['date_chargement', 'date_confirmation'],
    nameFields: ['transporteur', 'numero_affretement'],
    // Nom imposé : 2026-09-09_Confirmation_affretement.pdf (_2, _3… si le nom existe déjà).
    fileName: { datePattern: 'yyyy-MM-dd', label: 'Confirmation_affretement' },
  },
  lettre_voiture: {
    label: 'lettre de voiture',
    description: 'des lettres de voiture (CMR internationale ou lettre de voiture nationale, ' +
      'récépissé de transport, bon de livraison signé), souvent photographiées ou scannées',
    typeFlag: 'est_lettre_de_voiture',
    fields: [
      ['numero_lettre_voiture', 'N° lettre de voiture'], ['date_emission', 'Date établissement'],
      ['reference_commande', 'Réf. commande / affrètement'], ['expediteur', 'Expéditeur marchandise'],
      ['destinataire', 'Destinataire'], ['transporteur', 'Transporteur'],
      ['lieu_prise_en_charge', 'Lieu prise en charge'], ['date_prise_en_charge', 'Date prise en charge'],
      ['lieu_livraison', 'Lieu livraison'], ['date_livraison', 'Date livraison'],
      ['marchandise', 'Marchandise'], ['nombre_colis', 'Colis / palettes'], ['poids', 'Poids'],
      ['immatriculation', 'Immatriculation'], ['reserves', 'Réserves à la livraison'],
      ['signee_destinataire', 'Signée par le destinataire (oui/non)'],
    ],
    dateFields: ['date_livraison', 'date_prise_en_charge', 'date_emission'],
    nameFields: ['transporteur', 'numero_lettre_voiture'],
    // Nom imposé : 02-10-2026_Lettres_de_voiture_662518.pdf (date du document, puis n° de la lettre).
    fileName: { datePattern: 'dd-MM-yyyy', label: 'Lettres_de_voiture', numberField: 'numero_lettre_voiture' },
  },
};

function soriyaDocType_(typeKey) {
  const t = SORIYA_DOC_TYPES[typeKey];
  if (!t) throw new Error('Type de document inconnu : ' + typeKey);
  return t;
}

function soriyaPrompt_(typeKey) {
  const t = soriyaDocType_(typeKey);
  return [
    "Tu es Soriya, assistante spécialisée en transport routier et en affrètement pour l'équipe Ecotime.",
    'Tu lis ' + t.description + ' et tu en extrais les informations clés.',
    '',
    'Règles :',
    "- Recopie les valeurs telles qu'elles figurent sur le document ; n'invente rien.",
    '- Si une information est absente ou illisible, renvoie une chaîne vide "".',
    '- Dates au format AAAA-MM-JJ.',
    '- Montants : nombre seul avec un point décimal (ex. "1250.00"), sans symbole monétaire.',
    "- Si le PDF n'est pas une " + t.label + ', mets ' + t.typeFlag + ' à false',
    '  et explique dans remarques de quel document il s\'agit.',
    "- confiance = \"haute\" si les champs principaux sont nets, \"moyenne\" s'il y a un doute, \"basse\" sinon.",
  ].join('\n');
}

function soriyaSchema_(typeKey) {
  const t = soriyaDocType_(typeKey);
  const properties = {};
  t.fields.forEach(function (f) { properties[f[0]] = { type: 'string' }; });
  properties.remarques = { type: 'string' };
  properties[t.typeFlag] = { type: 'boolean' };
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
 * @param {string} context contexte utile (objet du mail, expéditeur WhatsApp…)
 * @param {string} typeKey clé de SORIYA_DOC_TYPES
 */
function soriyaReadPdf(pdfBlob, context, typeKey) {
  const docType = soriyaDocType_(typeKey);
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY non configurée');

  const body = {
    model: SORIYA_CONFIG.CLAUDE_MODEL,
    max_tokens: 16000,
    fallbacks: 'default',
    system: soriyaPrompt_(typeKey),
    output_config: {
      effort: SORIYA_CONFIG.CLAUDE_EFFORT,
      format: { type: 'json_schema', schema: soriyaSchema_(typeKey) },
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
          text: 'Contexte : ' + (context || '(aucun)') +
            '\nExtrais les informations de cette ' + docType.label + '.',
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
