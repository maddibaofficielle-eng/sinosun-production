# Soriya · Mailing — archivage IA des confirmations d'affrètement

*Mailing* est l'activité de Soriya qui traite les mails : elle archive les PDF reçus dans Gmail vers Google Drive.

Soriya surveille le libellé Gmail **`ecotime`**, récupère chaque PDF reçu, le **lit** (Claude),
le **renomme** proprement, le **range** dans Google Drive et tient un **journal** dans Google Sheets.

```
Gmail (libellé "ecotime")
   │  toutes les 15 min
   ▼
Soriya (Google Apps Script, dans votre compte Google)
   ├─ 1. Récupère les pièces jointes PDF pas encore traitées
   ├─ 2. Écarte les doublons (même PDF déjà archivé, par empreinte SHA-256)
   ├─ 3. Lit le PDF avec Claude → n° d'affrètement, transporteur, chargement, livraison, prix…
   ├─ 4. Renomme : 2026-09-24_TRANSPORTS DUPONT_AF-12345.pdf
   ├─ 5. Range dans Drive : Ecotime - Confirmations d'affrètement/2026/09/
   │     (ou dans « À vérifier » si le PDF n'est pas une confirmation ou si la lecture est douteuse)
   ├─ 6. Ajoute une ligne au Google Sheet « Journal Soriya »
   └─ 7. Pose le libellé « ecotime/Archivé par Soriya » et vous envoie un compte rendu par e-mail
```

Pas de serveur à louer : tout tourne dans Google Apps Script, avec votre compte Google.
Sans clé Claude, Soriya archive quand même les PDF (étapes 1, 2, 5, 6, 7) sans les lire ni les renommer.

## Ce que Soriya extrait de chaque confirmation

N° d'affrètement · date de confirmation · donneur d'ordre · transporteur · lieu et date de chargement ·
lieu et date de livraison · marchandise · poids · immatriculation · prix HT · devise ·
niveau de confiance · remarques.

Tout est visible dans le Journal (filtres et tableaux croisés possibles) et dans la description de chaque fichier Drive.

## Installation (≈ 10 minutes)

1. **Libellé Gmail** : vérifiez que les confirmations arrivent bien dans le libellé `ecotime`
   (au besoin, créez un filtre Gmail : *De : l'expéditeur Ecotime → Appliquer le libellé « ecotime »*).
2. Ouvrez <https://script.google.com> → **Nouveau projet** → nommez-le `Soriya`.
3. Créez trois fichiers de script et collez-y le contenu de ce dossier :
   `Config.gs`, `Soriya.gs`, `Code.gs` (supprimez le `Code.gs` vide d'origine avant de coller le vôtre).
4. **Paramètres du projet** (roue dentée) :
   - **Fuseau horaire** : choisissez *(GMT+01:00) Paris*. C'est le seul réglage utile du fichier
     `appsscript.json` : **inutile de créer ce fichier**, Google demande de lui-même les autorisations
     nécessaires au premier lancement. (Il existe déjà, caché ; pour le voir, cochez *Afficher le fichier
     manifeste « appsscript.json » dans l'éditeur*. On ne le crée jamais avec le bouton « + ».)
   - dans **Propriétés du script**, ajoutez `CLAUDE_API_KEY` = votre clé API Anthropic
     (à créer sur <https://console.anthropic.com>). La clé reste stockée dans votre projet, jamais dans le code.
5. Dans l'éditeur, choisissez la fonction **`apercuSoriya`** → **Exécuter** → acceptez les autorisations.
   Le journal d'exécution affiche les PDF que Soriya va traiter.
6. Choisissez **`installerSoriya`** → **Exécuter**. Soriya fait un premier passage puis tourne toutes les 15 minutes.

> Pour rattraper l'historique ancien, mettez temporairement `SEARCH_WINDOW_DAYS: 3650` dans `Config.gs`,
> exécutez `soriyaRun` (plusieurs fois si besoin : chaque passage s'arrête proprement au bout de 5 minutes
> et reprend là où il en était), puis remettez `30`.

## Réglages (`Config.gs`)

| Réglage | Par défaut | Rôle |
|---|---|---|
| `GMAIL_LABEL` | `ecotime` | Libellé surveillé |
| `PROCESSED_LABEL` | `ecotime/Archivé par Soriya` | Libellé posé sur les conversations traitées |
| `DRIVE_ROOT_FOLDER` | `Ecotime - Confirmations d'affrètement` | Dossier Drive racine |
| `TRIGGER_EVERY_MINUTES` | `15` | Fréquence de vérification |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | `claude-opus-5` / `low` | Modèle et effort de lecture |
| `SEND_SUMMARY_EMAIL` | `true` | Compte rendu par e-mail après chaque passage utile |

## Fiabilité

- **Aucun PDF perdu** : si la lecture IA échoue, le fichier est quand même archivé (statut indiqué dans le Journal).
  Si c'est l'enregistrement Drive qui échoue, le PDF n'est pas marqué comme traité et Soriya réessaie au passage suivant.
- **Pas de doublons** : chaque pièce jointe est identifiée (mail + nom de fichier) et chaque contenu par empreinte SHA-256.
- **Pas de chevauchement** : un verrou empêche deux passages simultanés.
- **Vos mails ne sont ni supprimés ni déplacés** : Soriya ajoute seulement un libellé.

## Commandes

| Fonction | Effet |
|---|---|
| `apercuSoriya()` | Liste ce qui serait traité, sans rien archiver |
| `soriyaRun()` | Lance un passage maintenant |
| `installerSoriya()` | Active le passage automatique |
| `desinstallerSoriya()` | Arrête le passage automatique |

## Coût indicatif

Apps Script, Gmail et Drive : gratuits dans les limites de votre compte Google.
Lecture Claude : quelques centimes par confirmation (selon le nombre de pages).

## Activité WhatsApp

Soriya traite aussi les **lettres de voiture** reçues en PDF sur son numéro WhatsApp **06 52 13 53 08**,
quel que soit l'expéditeur (filtre possible avec `WHATSAPP_ALLOWED_SENDERS` dans `Config.gs`).
Elles sont renommées `JJ-MM-AAAA_Lettres_de_voiture_<n°>.pdf` (ex. `02-10-2026_Lettres_de_voiture_662518.pdf`)
et rangées à part des confirmations d'affrètement, dans le dossier Drive **« Ecotime - Lettres de Voiture »**
(par année/mois, ou « À vérifier »), avec leur propre **« Journal Lettres de voiture »** : n° de lettre de voiture,
référence de commande, expéditeur, destinataire, transporteur, prise en charge, livraison, colis, poids,
immatriculation, réserves, signature du destinataire.

```
Expéditeur autorisé ──PDF──▶ WhatsApp 06 52 13 53 08 (API WhatsApp Business Cloud)
      ──▶ Make : détecte le message, filtre les PDF, télécharge le fichier
      ──▶ Drive : « Soriya - Entrée WhatsApp » (racine de Mon Drive) (fichier nommé WA_<expéditeur>_<horodatage>_<nom>.pdf)
      ──▶ Soriya (WhatsApp.gs, toutes les 15 min) : lecture Claude, renommage, classement, Journal Lettres de voiture
```

**Scénario Make « Soriya · WhatsApp »**

1. WhatsApp Business Cloud — *Watch Events* (numéro 06 52 13 53 08).
2. Filtre : type de message = `document` **et** type MIME = `application/pdf`.
3. WhatsApp Business Cloud — *Download a Media* (identifiant du document).
4. Google Drive (compte gfd.logistic) — *Upload a File* dans `Soriya - Entrée WhatsApp`
   (désigné par son identifiant, donc insensible à un renommage du dossier),
   nom : `WA_{{expéditeur}}_{{horodatage}}_{{nom du fichier}}`.

Le filtre sur l'expéditeur est fait par Soriya : un PDF d'un numéro non autorisé est mis de côté dans
`Soriya - Entrée WhatsApp/Expéditeur non autorisé`, sans être lu.


et `Code.gs` par leur nouvelle version, puis exécuter `apercuSoriyaWhatsApp` et `installerSoriyaWhatsApp`.

## Remise à zéro (`Maintenance.gs`)

`reinitialiserSoriya()` repart sur des données propres pour les deux activités :

- **Mailing** : journal vidé, PDF archivés mis à la corbeille puis re-téléchargés depuis Gmail
  (tout l'historique est relu pendant 6 h).
- **WhatsApp** : aucun PDF supprimé (WhatsApp ne permet pas de les re-télécharger) ; tous sont remis
  dans « Soriya - Entrée WhatsApp » sous leur nom d'origine, une seule copie par contenu identique,
  journal vidé.
- Les deux activités repartent seules (1er passage sous 1 à 5 min, puis toutes les 15 min).

Les doublons ne polluent plus le journal : ils sont notés dans un onglet **« Doublons »** séparé.

## Publication automatique (clasp)

Le dossier `soriya/` est relié au projet Apps Script (`.clasp.json`). Une correction se publie avec
`clasp push` : plus de copier-coller dans l'éditeur. L'API Apps Script doit être activée sur
https://script.google.com/home/usersettings (compte gfd.logistic).

## Pilotage (`Pilotage.gs`)

- **Tableau de bord** : Google Sheet « Soriya - Tableau de bord » (racine de Mon Drive), mis à jour à
  chaque passage : dernier passage, archivés, erreurs, en attente, à vérifier, doublons, documents par mois.
- **Rapport quotidien** : un seul e-mail par jour (18 h) au lieu d'un par passage.
- **Passages toutes les 5 minutes**, Mailing et WhatsApp en parallèle ; les déclencheurs se
  recréent seuls après une mise à jour du code.
