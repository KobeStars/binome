// Exécution des outils de Claude dans le moteur. Chaque outil n'agit que sur ce PC :
// le dossier partagé local, l'historique local, le chat. Jamais sur le PC de l'autre.

import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { errorResult, type ToolName, type ToolResult } from '../claude/tools.ts';
import type { Chat } from './chat.ts';
import type { Library } from './library/library.ts';
import type { EngineState } from './api.ts';
import { keyOf, safeRemotePath, toAbs } from './sync/paths.ts';
import type { Sync } from './sync/sync.ts';
import type { DirectTransfers } from './transfer/direct.ts';

export interface ToolContext {
  sync: Sync | null;
  chat: Chat | null;
  library: Library | null;
  transfers: DirectTransfers;
  state: EngineState;
  nameOf(device: string): string;
  /** Demande à l'utilisateur, dans l'app. Faux si refus ou sans réponse. */
  confirm(text: string): Promise<boolean>;
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGE = 5 * 1024 * 1024;
const DEFAULT_READ = 100_000;
const MAX_LIST = 2000;

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const iso = (ms: number) => new Date(ms).toISOString();

function size(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${(n / 1024 ** 3).toFixed(2)} Go`;
}

function needLibrary(ctx: ToolContext): Library {
  if (!ctx.library) throw new Error('Bibliothèque indisponible');
  return ctx.library;
}

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const CATEGORY = { game: 'jeu', tool: 'outil', bot: 'bot', site: 'site', other: 'autre' } as const;

function needSync(ctx: ToolContext): Sync {
  if (!ctx.sync) throw new Error('Aucun dossier partagé n’est choisi dans Binôme');
  return ctx.sync;
}

/** Chemin relatif sûr dans le dossier partagé, ou erreur. */
function sharedPath(raw: unknown): string {
  const path = safeRemotePath(typeof raw === 'string' ? raw.replace(/\\/g, '/').replace(/^\.?\//, '') : raw);
  if (!path) throw new Error('Chemin invalide : il doit être relatif au dossier partagé, sans « .. »');
  return path;
}

export async function runTool(ctx: ToolContext, tool: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (tool) {
    case 'list_files': {
      const sync = needSync(ctx);
      const folder = typeof args.folder === 'string' && args.folder.trim() ? sharedPath(args.folder) : null;
      const prefix = folder ? `${keyOf(folder)}/` : '';
      const files = sync.index
        .live()
        .filter((e) => !prefix || e.key.startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (files.length === 0) return text(folder ? `Aucun fichier dans ${folder}` : 'Le dossier partagé est vide');
      const shown = files.slice(0, MAX_LIST);
      const body = shown.map((e) => `${e.path}\t${size(e.size)}\t${iso(e.vtime)}\t${ctx.nameOf(e.by)}`).join('\n');
      const more = files.length > MAX_LIST ? `\n… et ${files.length - MAX_LIST} autres` : '';
      return text(`${files.length} fichier(s). Colonnes : chemin, taille, date de la version, auteur\n${body}${more}`);
    }

    case 'read_file': {
      const sync = needSync(ctx);
      const path = sharedPath(args.path);
      const abs = toAbs(sync.root, path);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) return errorResult(`Fichier introuvable : ${path}`);

      const mime = IMAGE_TYPES[extname(path).toLowerCase()];
      if (mime && args.offset === undefined) {
        if (st.size > MAX_IMAGE) return errorResult(`Image trop lourde pour être lue (${size(st.size)}, maximum 5 Mo)`);
        const file = await open(abs, 'r');
        try {
          const buf = Buffer.alloc(st.size);
          await file.read(buf, 0, st.size, 0);
          return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }] };
        } finally {
          await file.close();
        }
      }

      const offset = Math.min(Number(args.offset ?? 0), st.size);
      const max = Math.min(Number(args.max_bytes ?? DEFAULT_READ), 1_000_000);
      const length = Math.min(max, st.size - offset);
      const buf = Buffer.alloc(length);
      const file = await open(abs, 'r');
      try {
        await file.read(buf, 0, length, offset);
      } finally {
        await file.close();
      }
      if (buf.subarray(0, 8192).includes(0)) {
        return text(`${path} est un fichier binaire de ${size(st.size)}, pas lisible comme du texte`);
      }
      const end = offset + length;
      const tail = end < st.size ? `\n\n[… suite à partir de offset=${end}, taille totale ${st.size} octets]` : '';
      return text(buf.toString('utf8') + tail);
    }

    case 'get_history': {
      const sync = needSync(ctx);
      const path = sharedPath(args.path);
      const versions = sync.versionsOf(path);
      if (versions.length === 0) return text(`Aucune version connue pour ${path}`);
      const current = sync.index.get(keyOf(path));
      let currentSeen = false;
      const lines = versions.map((v) => {
        const isCurrent = !currentSeen && !!v.hash && !!current && !current.deleted && current.hash === v.hash;
        if (isCurrent) currentSeen = true;
        const what = v.kind === 'deleted' ? 'supprimé' : v.kind === 'added' ? 'ajouté' : 'modifié';
        return [
          `version_id=${v.id}`,
          iso(v.at),
          what,
          ctx.nameOf(v.by),
          v.hash ? size(v.size) : '-',
          isCurrent ? 'version actuelle' : v.hash ? 'restaurable' : '',
          v.via === 'claude' ? 'via Claude' : '',
        ]
          .filter(Boolean)
          .join('\t');
      });
      return text(`Versions de ${path}, de la plus récente à la plus ancienne\n${lines.join('\n')}`);
    }

    case 'get_status': {
      const s = ctx.state;
      const sync = ctx.sync;
      const route = { lan: 'réseau local', internet: 'connexion directe', relay: 'relais' } as const;
      const lines = [
        `Moi : ${s.name}`,
        s.peer ? `Binôme : ${s.peer.name}` : 'Pas encore relié à un autre PC',
        s.peer ? `En ligne : ${s.route ? `oui, ${route[s.route]}` : s.peerOnline ? 'connexion en cours' : 'non'}` : '',
        `Serveur : ${s.server === 'online' ? 'joignable' : 'injoignable'}`,
        sync ? `Dossier partagé : ${sync.root}` : 'Aucun dossier partagé',
        sync ? `Fichiers : ${sync.stats().files}, ${size(sync.stats().bytes)}` : '',
        sync ? `En cours de réception : ${sync.stats().pending}` : '',
        sync?.lastSync ? `Dernière synchro : ${iso(sync.lastSync)}` : sync ? 'Dernière synchro : pas encore' : '',
        ...(sync?.conflicts() ?? []).map((c) => `Conflit non vu : ${c.path} (autre version dans ${c.aside})`),
      ];
      return text(lines.filter(Boolean).join('\n'));
    }

    case 'get_changelog': {
      const sync = needSync(ctx);
      const limit = Math.min(Number(args.limit ?? 50), 500);
      const since = typeof args.since === 'string' ? Date.parse(args.since) : NaN;
      const items = sync
        .journal(500)
        .filter((v) => Number.isNaN(since) || v.at > since)
        .slice(0, limit);
      if (items.length === 0) return text('Aucun changement sur cette période');
      const verb = { added: 'a ajouté', modified: 'a modifié', deleted: 'a supprimé' } as const;
      return text(
        items
          .map((v) => `${iso(v.at)}\t${ctx.nameOf(v.by)} ${verb[v.kind]} ${v.path}${v.via === 'claude' ? ' (via Claude)' : ''}`)
          .join('\n'),
      );
    }

    case 'send_file': {
      if (!ctx.state.peer) return errorResult('Binôme n’est relié à aucun autre PC');
      const raw = typeof args.path === 'string' ? args.path : '';
      let abs: string;
      if (isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw)) {
        // Hors du dossier partagé : l'utilisateur doit accepter que ce fichier quitte son PC.
        const ok = await ctx.confirm(`Claude veut envoyer ${raw} à ${ctx.state.peer.name}`);
        if (!ok) return errorResult('Envoi refusé par l’utilisateur');
        abs = raw;
      } else {
        const sync = needSync(ctx);
        abs = toAbs(sync.root, sharedPath(raw));
      }
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) return errorResult(`Fichier introuvable : ${raw}`);
      const view = await ctx.transfers.send(abs, 'claude');
      const when = ctx.state.route ? 'envoi en cours' : `${ctx.state.peer.name} est hors ligne, l’envoi partira à la reconnexion`;
      return text(`${view.name} (${size(view.size)}) : ${when}`);
    }

    case 'restore_version': {
      const sync = needSync(ctx);
      const id = Number(args.version_id);
      const v = Number.isInteger(id) ? sync.history.get(id) : null;
      if (!v?.hash) return errorResult('Version introuvable ou sans contenu (une suppression ne se restaure pas)');
      const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(v.at);
      const ok = await ctx.confirm(`Claude veut restaurer ${v.path} à la version du ${date} (${ctx.nameOf(v.by)})`);
      if (!ok) return errorResult('Restauration refusée par l’utilisateur');
      await sync.restore(v.id, 'claude');
      return text(`${v.path} restauré à la version du ${date}. La nouvelle version part aussi chez l’autre`);
    }

    case 'send_message': {
      if (!ctx.chat) return errorResult('Chat indisponible');
      if (!ctx.state.peer) return errorResult('Binôme n’est relié à aucun autre PC');
      const body = typeof args.text === 'string' ? args.text.trim() : '';
      if (!body) return errorResult('Message vide');
      const file = typeof args.file === 'string' && args.file ? sharedPath(args.file) : null;
      const m = ctx.chat.write(body, file, 'claude');
      return text(ctx.state.route ? 'Message envoyé' : `Message enregistré, il partira quand ${ctx.state.peer.name} sera en ligne (id ${m.id})`);
    }

    case 'get_library': {
      const lib = needLibrary(ctx);
      if (typeof args.app === 'string' && args.app.trim()) {
        const found = lib.find(args.app);
        if (!found) return errorResult(`Aucune app ne s’appelle ${args.app}`);
        const d = lib.detail(found.id);
        const lines = [
          `${d.name} (${CATEGORY[d.category]}), par ${d.author}, version ${d.version}, ${size(d.size)}, ${d.count} fichier(s)`,
          `Identifiant : ${d.id}`,
          d.mine ? `Publiée depuis : ${d.source ?? '?'}` : `Installée : ${d.installed ?? 'non'}${d.update ? ' (mise à jour disponible)' : ''}`,
          `Temps de jeu : ${hours(d.playMs)}, ${d.launches} lancement(s)`,
          d.exe ? `Exécutable : ${d.exe}` : 'Pas d’exécutable',
          d.tags.length ? `Tags : ${d.tags.join(', ')}` : '',
          d.requirements ? `Configuration requise : ${d.requirements}` : '',
          '',
          d.description,
          '',
          'Notes de version :',
          ...d.releases.map((r) => `- ${r.version} (${iso(r.at)}) ${r.notes.replace(/\s+/g, ' ').slice(0, 300)}`),
          '',
          `Avis : ${d.reviews.length ? d.reviews.map((r) => `${r.stars}/5 par ${r.by} : ${r.text}`).join(' | ') : 'aucun'}`,
          `Bugs : ${d.bugs.length ? '' : 'aucun'}`,
          ...d.bugs.map((b) => `- [${b.status === 'fixed' ? 'corrigé' : 'ouvert'}] v${b.version}, ${b.by}, ${iso(b.at)} : ${b.text.slice(0, 400)}`),
        ];
        return text(lines.filter((l, i) => l !== '' || i > 0).join('\n'));
      }
      const apps = lib.list();
      if (apps.length === 0) return text('La Bibliothèque est vide');
      return text(
        `${apps.length} app(s). Colonnes : nom, catégorie, auteur, version, installée, temps de jeu, note\n` +
          apps
            .map((a) =>
              [
                a.name,
                CATEGORY[a.category],
                a.author,
                a.version,
                a.mine ? 'publiée ici' : a.installed ? `${a.installed}${a.update ? ' (mise à jour dispo)' : ''}` : 'non',
                hours(a.playMs),
                a.rating ? `${a.rating}/5` : '-',
              ].join('\t'),
            )
            .join('\n'),
      );
    }

    case 'publish_app': {
      const lib = needLibrary(ctx);
      const existing = typeof args.app === 'string' && args.app.trim() ? lib.find(args.app) : null;
      if (args.app && !existing) return errorResult(`Aucune app ne s’appelle ${String(args.app)}`);
      if (existing && !existing.mine) return errorResult('Cette app a été publiée par l’autre personne');
      const detail = existing ? lib.detail(existing.id) : null;
      const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
      if (path && !isAbsolute(path)) return errorResult('Le chemin doit être absolu');
      if (!path && !detail) return errorResult('Donne le dossier ou l’exe à publier (path)');
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : (detail?.name ?? '');
      if (!name) return errorResult('Donne un nom (name)');
      const version = String(args.version ?? '').trim();
      const what = `${name} ${version} depuis ${path ?? detail?.source ?? '?'}`;
      const ok = await ctx.confirm(existing ? `Claude veut publier la mise à jour ${what}` : `Claude veut publier ${what} dans la Bibliothèque`);
      if (!ok) return errorResult('Publication refusée par l’utilisateur');
      const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
      const r = await lib.publish(
        {
          app: existing?.id,
          source: path,
          exe: typeof args.exe === 'string' ? args.exe : undefined,
          name,
          version,
          category: (typeof args.category === 'string' ? args.category : (detail?.category ?? 'game')) as 'game',
          tags: Array.isArray(args.tags) ? args.tags.map(String) : (detail?.tags ?? []),
          description: str(args.description, detail?.description ?? ''),
          requirements: str(args.requirements, detail?.requirements ?? ''),
          notes: str(args.notes, ''),
        },
        'claude',
      );
      const d = lib.detail(r.app);
      return text(`${d.name} ${d.version} publié : ${d.count} fichier(s), ${size(d.size)}${d.exe ? `, lancement par ${d.exe}` : ', sans exécutable de lancement'}. Identifiant ${d.id}`);
    }

    case 'report_bug': {
      const lib = needLibrary(ctx);
      const found = typeof args.app === 'string' ? lib.find(args.app) : null;
      if (!found) return errorResult(`Aucune app ne s’appelle ${String(args.app)}`);
      if (found.mine) return errorResult('Cette app a été publiée sur ce PC : le rapport irait à soi-même');
      const body = typeof args.text === 'string' ? args.text.trim() : '';
      if (!body) return errorResult('Décris le bug');
      await lib.bug(found.id, `${body}\n\n(via Claude)`, null);
      return text(ctx.state.route ? `Rapport envoyé à l’auteur de ${found.name}` : `Rapport enregistré, il partira à la reconnexion`);
    }
  }
}
