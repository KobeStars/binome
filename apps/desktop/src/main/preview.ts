// Protocole binome:// pour les aperçus : l'interface lit images, vidéos et textes
// sans accès direct au disque. Deux racines seulement : le dossier partagé et les fichiers reçus.
//   binome://shared/maquettes/affiche.png
//   binome://inbox/devis.pdf
// Plus les deux avatars, écrits par le moteur dans le dossier de données :
//   binome://avatar/me   binome://avatar/peer

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { AVATAR_FILES, imageType } from '../engine/profile.ts';

export const PREVIEW_SCHEME = 'binome';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/** À appeler avant `app.whenReady()`. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function avatar(dataDir: string, who: string): Promise<Response> {
  const file = who === 'me' ? AVATAR_FILES.me : who === 'peer' ? AVATAR_FILES.peer : null;
  const data = file ? await readFile(join(dataDir, file)).catch(() => null) : null;
  const type = data ? imageType(data) : null;
  if (!data || !type) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: {
      'content-type': type,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-security-policy': "default-src 'none'",
    },
  });
}

export function handlePreviews(roots: () => { shared: string | null; inbox: string; data: string }): void {
  protocol.handle(PREVIEW_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.hostname === 'avatar') return avatar(roots().data, url.pathname.replace(/^\/+/, ''));
    const base = url.hostname === 'shared' ? roots().shared : url.hostname === 'inbox' ? roots().inbox : null;
    if (!base) return new Response(null, { status: 404 });
    const abs = resolve(base, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!inside(abs, resolve(base))) return new Response(null, { status: 403 });

    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) return new Response(null, { status: 404 });
    const type = TYPES[extname(abs).toLowerCase()] ?? 'text/plain; charset=utf-8';
    const headers: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      // La page (file:// ou le serveur de dev) n'a pas la même origine que binome:// : fetch exige le CORS.
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range, content-length',
      // Un SVG ne doit jamais exécuter de script, même ouvert directement.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    };

    // Plages d'octets : nécessaires pour avancer dans une vidéo, utiles pour lire le début d'un texte.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (range && st.size > 0) {
      let start = range[1] ? Number(range[1]) : NaN;
      let end = range[2] ? Number(range[2]) : st.size - 1;
      if (Number.isNaN(start)) {
        start = Math.max(0, st.size - end);
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } });
      const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${st.size}` },
      });
    }
    const body = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...headers, 'content-length': String(st.size) } });
  });
}
