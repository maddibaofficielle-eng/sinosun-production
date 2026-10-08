/**
 * Soriya — le "cerveau" : lecture des documents de transport PDF par Claude.
 * Appel HTTP direct à l'API Messages (Apps Script n'a pas de SDK Anthropic).
 */

/**
 * Types de documents que Soriya sait lire. Chaque activité choisit le sien :
 *   Mailing  → 'confirmation'   (confirmations d'affrètement reçues par e-mail)
 *   WhatsApp → 'lettre_voiture' (lettres de voiture reçues sur WhatsApp)
 * fields = [clé extraite, titre de colonne dans le Journal], dans l'ordre des colonnes.
 * Un 3e élément { computed: true } désigne une colonne calculée par Soriya (pas lue sur le PDF).
 */
const SORIYA_DOC_TYPES = {
  confirmation: {
    label: "confirmation d'affrètement",
    description: "des confirmations d'affrètement (aussi appelées confirmations de commande de transport " +
      "ou ordres de transport), envoyées par le donneur d'ordre au transporteur",
    typeFlag: 'est_confirmation_affretement',
    hints: [
      "numero_affretement = le N° de la confirmation d'affrètement tel qu'imprimé sur le PDF " +
        "(souvent en en-tête : « Confirmation d'affrètement N° … »). Ne pas confondre avec une référence " +
        "client, un n° de commande, de tournée ou de facture.",
      'prix_ht = le montant total HT de la prestation indiqué sur la confirmation.',
      "attente = le temps d'attente et/ou le montant d'attente mentionné (ex. « 1h30 », « 45,00 € ») ; vide si aucun.",
      'prestations = les prestations réalisées ou facturées listées sur le document, avec leur quantité ou ' +
        'montant, séparées par « ; » (ex. « GV ILE DE FRANCE 38,00 ; MANUTENTION 1,00 »).',
    ],
    fields: [
      ['numero_affretement', 'N° affrètement'], ['date_confirmation', 'Date confirmation'],
      ['donneur_ordre', "Donneur d'ordre"], ['transporteur', 'Transporteur (confirmation)'],
      // Transporteur de la lettre de voiture portant le même numéro (voir soriyaRapprocherTransporteurs_).
      ['transporteur_ldv', 'Transporteur', { computed: true }],
      ['lieu_chargement', 'Lieu chargement'], ['date_chargement', 'Date chargement'],
      ['lieu_livraison', 'Lieu livraison'], ['date_livraison', 'Date livraison'],
      ['marchandise', 'Marchandise'], ['poids', 'Poids'], ['immatriculation', 'Immatriculation'],
      ['prix_ht', 'Montant HT'], ['devise', 'Devise'], ['attente', 'Attente'],
      ['prestations', 'Prestations réalisées'],
    ],
    dateFields: ['date_chargement', 'date_confirmation'],
    nameFields: ['transporteur', 'numero_affretement'],
    // Nom imposé : 02-10-2026_Confirmation_affretement_662518.pdf (date du document, puis n° d'affrètement).
    fileName: { datePattern: 'dd-MM-yyyy', label: 'Confirmation_affretement', numberField: 'numero_affretement' },
  },
  lettre_voiture: {
    label: 'lettre de voiture',
    description: 'des lettres de voiture (CMR internationale ou lettre de voiture nationale, ' +
      'récépissé de transport, bon de livraison signé), souvent photographiées, scannées ou en capture d\'écran ' +
      '(capture d\'écran d\'une application de transport reçue par WhatsApp)',
    typeFlag: 'est_lettre_de_voiture',
    hints: [
      'transporteur = la société de transport qui a effectué le transport (et le chauffeur si indiqué).',
      'Si le document est un ticket de caisse (carburant, péage, parking…), une facture ou un devis de fournisseur, mets ' +
        'est_lettre_de_voiture à false et commence remarques par « Ticket de caisse », « Facture » ou « Devis » ' +
        '(ex. « Ticket de caisse carburant TotalEnergies, 85,40 € », « Devis garage Norauto, 420,00 € »).',
      "Pour une capture d'écran, ignore l'interface autour du document (barre d'état, boutons, conversation) " +
        "et ne lis que la lettre de voiture. Si la capture ne montre aucune lettre de voiture, mets " +
        'est_lettre_de_voiture à false.',
      'prestations = les prestations réalisées listées sur le document (souvent « Prestation annexe »), avec ' +
        'leur quantité ou montant, séparées par « ; » (ex. « GV ILE DE FRANCE 38,00 ; MANUTENTION 1,00 »).',
    ],
    fields: [
      ['numero_lettre_voiture', 'N° lettre de voiture'], ['date_emission', 'Date établissement'],
      ['reference_commande', 'Réf. commande / affrètement'], ['expediteur', 'Expéditeur marchandise'],
      ['destinataire', 'Destinataire'], ['transporteur', 'Transporteur'],
      ['prestations', 'Prestations réalisées'],
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
  ].concat((t.hints || []).map(function (h) { return '- ' + h; })).concat([
    "- confiance = \"haute\" si les champs principaux sont nets, \"moyenne\" s'il y a un doute, \"basse\" sinon.",
  ]).join('\n');
}

function soriyaSchema_(typeKey) {
  const t = soriyaDocType_(typeKey);
  const properties = {};
  t.fields.forEach(function (f) { if (!f[2]) properties[f[0]] = { type: 'string' }; });
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
 * @param {string=} model modèle Claude à utiliser (par défaut SORIYA_CONFIG.CLAUDE_MODEL)
 */
function soriyaReadPdf(pdfBlob, context, typeKey, model) {
  const docType = soriyaDocType_(typeKey);
  return soriyaClaudeJson_(pdfBlob, soriyaPrompt_(typeKey), soriyaSchema_(typeKey),
    'Contexte : ' + (context || '(aucun)') + '\nExtrais les informations de cette ' + docType.label + '.', model, 16000);
}

/**
 * Appel à l'API Messages : un document (PDF ou photo) + une consigne → objet JSON conforme au schéma.
 * Réessaie sur 429 / 5xx ; lève une erreur explicite sinon.
 */
function soriyaClaudeJson_(pdfBlob, system, schema, text, model, maxTokens) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY non configurée');

  model = model || SORIYA_CONFIG.CLAUDE_MODEL;
  // Haiku (modèle économique) ne prend ni le réglage d'effort ni le repli automatique.
  const light = model.indexOf('claude-haiku') === 0;
  const isImage = /^image\//.test(pdfBlob.getContentType());
  const body = {
    model: model,
    max_tokens: maxTokens || 16000,
    system: system,
    output_config: {
      format: { type: 'json_schema', schema: schema },
    },
    messages: [{
      role: 'user',
      content: [
        {
          // PDF → bloc « document » ; photo (JPEG, PNG, WebP) → bloc « image ».
          type: isImage ? 'image' : 'document',
          source: {
            type: 'base64',
            media_type: isImage ? pdfBlob.getContentType() : 'application/pdf',
            data: Utilities.base64Encode(pdfBlob.getBytes()),
          },
        },
        { type: 'text', text: text },
      ],
    }],
  };
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (!light) {
    body.fallbacks = 'default';
    body.output_config.effort = SORIYA_CONFIG.CLAUDE_EFFORT;
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
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
