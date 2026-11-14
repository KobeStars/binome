// Config electron-builder. Le dépôt GitHub de publication vient de GITHUB_REPOSITORY,
// fourni par GitHub Actions : rien à modifier si le dépôt change de nom.
// En local, BINOME_REPO=propriétaire/dépôt permet de tester une publication.

const repo = process.env.GITHUB_REPOSITORY || process.env.BINOME_REPO || '';
const [owner, name] = repo.split('/');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.binome.desktop',
  productName: 'Binôme',
  executableName: 'Binome',
  directories: { output: 'release', buildResources: 'resources' },
  files: ['out/**', 'package.json'],
  asar: true,
  // Le module natif de node-datachannel ne peut pas être chargé depuis l'archive asar.
  // Le serveur MCP est lancé par Claude avec le Node d'Electron : il doit être lisible hors de l'archive.
  asarUnpack: ['**/*.node', 'out/main/**'],
  // node-datachannel fournit des binaires N-API précompilés : pas de recompilation.
  npmRebuild: false,
  // Icônes de la barre des tâches et de la fenêtre, lues à côté de l'app installée.
  extraResources: [
    { from: 'resources/tray.png', to: 'tray.png' },
    { from: 'resources/tray@2x.png', to: 'tray@2x.png' },
    { from: 'resources/icon.png', to: 'icon.png' },
  ],
  win: {
    icon: 'resources/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    // Nom ASCII : GitHub renomme les fichiers accentués et la mise à jour ne les retrouverait pas.
    artifactName: 'Binome-Setup-${version}.${ext}',
  },
  nsis: {
    // Installation par utilisateur, sans droits administrateur : les mises à jour passent sans invite.
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: true,
    shortcutName: 'Binôme',
    deleteAppDataOnUninstall: false,
  },
  // Brouillon : le workflow le crée avant l'envoi et le publie après (voir release.yml).
  publish: owner && name ? [{ provider: 'github', owner, repo: name, releaseType: 'draft' }] : null,
};
