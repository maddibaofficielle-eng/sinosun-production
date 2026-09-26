# Soriya — agent IA d'archivage des confirmations d'affrètement

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
