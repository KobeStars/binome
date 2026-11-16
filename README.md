# Binôme

Un dossier identique sur deux PC Windows, synchronisé en direct entre deux personnes. Pas de compte, pas de cloud : les fichiers passent d'un PC à l'autre, chiffrés.

Architecture et choix techniques : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## État

| Étape | Contenu | État |
|---|---|---|
| 1 | Architecture | fait |
| 2 | Serveur de signalisation, appairage CPace | fait |
| 3 | Lien P2P chiffré, relais, envoi direct | fait |
| 4 | Mises à jour automatiques | fait |
| 5 | Moteur de synchro | fait |
| 6 | Historique, corbeille, conflits | fait |
| 7 | Interface complète | fait |
| 8 | Connexion avec Claude (serveur MCP) | fait |
| 9 | Mode LAN, bande passante, reprise | à faire |
| 10 | Profil (pseudo, avatar, statut), wizz, journal de plantage, canal bêta, retour à la version précédente | fait |
| 11 | Bibliothèque : pages de jeux et d'apps, installation, mises à jour, avis, succès | fait |

## Organisation

```
packages/protocol   messages et encodages partagés
apps/signaling      serveur Railway : codes d'appairage, salons, présence
apps/desktop        application Electron : main, preload, moteur (utilityProcess), interface React, serveur MCP
tests/              tests de bout en bout, serveur réel en local
```

## Développement

Node 22.12 ou plus récent.

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

Les mêmes tests avec le Node embarqué dans Electron (sa crypto diffère de celle de Node) :

```bash
npm run test:electron
```

Serveur de signalisation en local, sur le port 8787 :

```bash
npm run signaling:dev
```

L'app, branchée sur ce serveur local :

```bash
npm run desktop:dev
```

### Tester à deux sur un seul PC

Chaque profil a ses propres clés, son appairage et son dossier de réception. Dans deux terminaux PowerShell :

```powershell
$env:BINOME_PROFILE='a'; npm run desktop:dev
```

```powershell
$env:BINOME_PROFILE='b'; npm run desktop:dev
```

| Variable | Rôle |
|---|---|
| `BINOME_PROFILE` | Profil séparé (données dans `%APPDATA%\Binôme-<profil>`) |
| `BINOME_SIGNALING_URL` | Serveur de signalisation, `ws://127.0.0.1:8787` par défaut |
| `BINOME_INBOX` | Dossier de réception, `Téléchargements\Binôme` par défaut |
| `BINOME_FORCE_RELAY=1` | Saute WebRTC et passe par le relais |

## Appairage

1. Alex clique sur « Inviter » : l'app affiche un code comme `482 913`, valable 5 minutes.
2. L'ami tape ce code.
3. Les deux écrans affichent un code de vérification de 8 chiffres. S'il est identique des deux côtés, personne ne s'est interposé.

Le serveur ne reçoit que les 2 premiers chiffres, qui servent de rendez-vous. Les 4 autres restent sur les deux PC et servent de mot de passe à l'échange de clés (CPace). Un code ne sert qu'une fois, même s'il est faux. 10 essais par minute et par IP au maximum.

## Bibliothèque

Chacun publie ses jeux et apps, l'autre les installe et y joue.

- **Publier** : un dossier ou un exe, avec nom, icône, bannière, galerie, description en Markdown, catégorie, tags, version, configuration requise, notes de version. La version est figée à la publication : chaque fichier est découpé en blocs (FastCDC), compressés un par un en zstd, et la page est signée avec la clé de l'appareil.
- **Installer** : dans `%LOCALAPPDATA%\Binôme\Bibliothèque` (réglable). Chaque bloc est vérifié à l'arrivée, puis chaque fichier. Les blocs reçus quittent le magasin une fois installés : pas de copie en double.
- **Mettre à jour** : seuls les blocs absents sont téléchargés ; ceux de la version installée sont relus sur le disque. Automatique par défaut, avec notification.
- **Lancer** : confirmation au premier lancement d'une app de l'autre. Le temps de jeu est compté, l'autre voit « Joue à … », et Discord aussi si un identifiant d'application est renseigné dans Paramètres.
- **Social** : avis de 1 à 5 étoiles, rapports de bug avec capture d'écran, « Teste mon jeu ! » (une minute pour répondre), tableau d'idées et wishlist communs.
- **Succès, XP, niveaux** : comptés sur chaque PC. Le niveau débloque des couleurs d'accent. Récap du mois dans l'onglet Récap. Sons et animations désactivables.

Protocole pair à pair 3 : une app plus ancienne ignore les messages de la Bibliothèque.

## Connecter Claude

Chacun peut brancher son propre Claude (Claude Desktop ou Claude Code) sur son app. Claude n'agit que sur ce PC : le dossier partagé local, l'historique, le chat. Jamais directement sur le PC de l'autre.

1. Paramètres, section Claude : « Connecter Claude ». L'app affiche le bloc pour `claude_desktop_config.json` et la commande `claude mcp add` pour Claude Code, avec les bons chemins.
2. Claude Desktop : Paramètres, Développeur, Modifier la config, coller le bloc, redémarrer Claude Desktop.
3. Binôme doit être ouvert pour que Claude l'utilise.

| Outil | Droit | Effet |
|---|---|---|
| `list_files` | lecture | Liste le dossier partagé |
| `read_file` | lecture | Lit un texte, ou une image renvoyée comme image |
| `get_history` | lecture | Les 10 dernières versions d'un fichier |
| `get_status` | lecture | En ligne, chemin, dernière synchro, conflits |
| `get_changelog` | lecture | Qui a modifié quoi, et quand |
| `send_file` | écriture | Envoie un fichier ; hors du dossier partagé, confirmation dans l'app |
| `restore_version` | écriture | Restaure une version, toujours avec confirmation dans l'app |
| `send_message` | écriture | Écrit dans le chat, marqué « via Claude » |
| `get_library` | lecture | Jeux et apps de la Bibliothèque, ou la page complète d'une app |
| `publish_app` | écriture | Publie un dossier ou un exe, toujours avec confirmation dans l'app |
| `report_bug` | écriture | Envoie un rapport de bug à l'auteur d'une app |

Par défaut, la lecture est autorisée et l'écriture désactivée. Chaque outil se règle dans Paramètres. Tout ce que Claude demande, accepté ou refusé, est listé dans Historique, onglet Claude. Les versions et messages faits par Claude portent la mention « via Claude », chez les deux.

Option : un serveur MCP en HTTP sur `127.0.0.1` (port 47821 par défaut), protégé par le jeton de l'app, pour Claude Code.

## Déployer le serveur sur Railway

Le fichier `railway.json` à la racine décrit le build : Dockerfile `apps/signaling/Dockerfile`, contexte à la racine du dépôt, une seule instance, contrôle de santé sur `/health`.

1. Sur Railway, créer un service depuis ce dépôt GitHub.
2. Dans Settings, générer un domaine public. Railway fournit `PORT`, rien d'autre à configurer.
3. Vérifier : `https://<domaine>/health` renvoie `{"ok":true,...}`.
4. L'app se connectera à `wss://<domaine>`.

Garder une seule instance : les salons sont en mémoire. Un redémarrage coupe les connexions, les apps se reconnectent seules (1 s, 2 s, 4 s… jusqu'à 30 s).

Pour que l'app utilise ce serveur, définir `MAIN_VITE_SIGNALING_URL=wss://<domaine>` au moment du build.

## Publier une version

Une version = un tag `vX.Y.Z`. GitHub Actions ([release.yml](.github/workflows/release.yml)) lance les tests, construit l'installeur Windows et publie la release. Le numéro de version vient du tag, pas besoin de modifier `package.json`.

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

Les apps installées vérifient au démarrage puis toutes les 4 heures. Elles téléchargent la nouvelle version en arrière-plan (seuls les blocs modifiés de l'installeur quand c'est possible), puis affichent « Version 0.2.0 prête » avec un bouton Redémarrer. Sans clic, la mise à jour s'installe à la prochaine fermeture.

### Bêta, puis stable

Un tag avec un tiret publie une **préversion** : seules les apps réglées sur « Recevoir les versions bêta » (Paramètres, Mises à jour) la reçoivent. L'un teste, l'autre reste sur la version stable.

```bash
git tag v0.2.0-beta.1
```

```bash
git push origin v0.2.0-beta.1
```

Une fois la bêta validée, le tag `v0.2.0` publie la version stable pour les deux. Une app sur le canal bêta reçoit aussi les versions stables.

### Retour à la version précédente

Chaque PC retient les versions qu'il a lancées et celles qui ont tourné 5 minutes sans plantage en boucle (`updates.json` dans les données de l'app). Paramètres, Mises à jour : « Revenir à la version X » réinstalle la dernière version saine depuis sa release GitHub. Si une nouvelle version plante 3 fois en 10 minutes, ou si ses deux derniers lancements ont planté, l'app le propose d'elle-même. La version dont on revient est mise de côté : elle ne se réinstalle pas toute seule.

Le retour en arrière ne marche qu'à partir de la deuxième version installée avec ce garde-fou : il faut une version saine connue de ce PC.

### Plantages

Un plantage du moteur, de l'interface ou de l'app est noté (Historique, onglet Plantages) avec la fin de son journal, et envoyé à l'autre PC, qui reçoit une notification. Le partage se coupe dans Paramètres, Mises à jour.

### Une fois, avant la première release

1. **Dépôt public.** electron-updater lit les releases sans jeton. Avec un dépôt privé, il faudrait embarquer un jeton GitHub dans l'app : à éviter. Autre option, un second dépôt public qui ne contient que les releases.
2. **Variable `SIGNALING_URL`** dans Settings > Secrets and variables > Actions > Variables, avec `wss://<domaine Railway>`. Elle est intégrée à l'app au build.
3. **Permissions** : Settings > Actions > General > Workflow permissions doit autoriser l'écriture (le workflow le demande aussi via `permissions: contents: write`).

### À savoir

- **Pas de signature de code.** Windows SmartScreen affichera « Windows a protégé votre ordinateur » à la première installation : Informations complémentaires > Exécuter quand même. Les mises à jour suivantes passent sans alerte.
- **Installation par utilisateur** dans `%LOCALAPPDATA%\Programs`, sans droits administrateur.
- **Icône** : générée par `npm run icons` (deux points reliés), à relancer si le symbole change.

### Tester une mise à jour sans publier

1. Construire l'installeur d'une version plus récente, pointé vers un serveur local :

```bash
npm pkg set version=0.1.1 -w @binome/desktop
```

```bash
cd apps/desktop && npx electron-vite build && npx electron-builder --config electron-builder.config.cjs --win nsis --publish never -c.directories.output=release-test -c.publish.provider=generic -c.publish.url=http://127.0.0.1:8899/
```

2. Servir `apps/desktop/release-test` sur le port 8899, remettre la version à 0.1.0, construire avec `npm run dist:dir -w @binome/desktop`, puis copier `release-test/win-unpacked/resources/app-update.yml` dans `release/win-unpacked/resources/`.
3. Lancer `release/win-unpacked/Binome.exe` : le bandeau de mise à jour apparaît après 10 secondes.
