// Exécution des outils de Claude dans le moteur. Chaque outil n'agit que sur ce PC :
// le dossier partagé local, l'historique local, le chat. Jamais sur le PC de l'autre.

import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { errorResult, type ToolName, type ToolResult } from '../claude/tools.ts';
import type { Chat } from './chat.ts';
import type { EngineState } from './api.ts';
import { keyOf, safeRemotePath, toAbs } from './sync/paths.ts';
import type { Sync } from './sync/sync.ts';
import type { DirectTransfers } from './transfer/direct.ts';

export interface ToolContext {
  sync: Sync | null;
  chat: Chat | null;
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
  }
}
