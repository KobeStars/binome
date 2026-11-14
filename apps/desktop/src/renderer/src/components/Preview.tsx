import { useEffect, useState } from 'react';
import { FileText, MessageSquare, X } from 'lucide-react';
import { api } from '../lib/engine.ts';
import { absoluteIn, baseName, previewKind, previewUrl, type PreviewTarget } from '../lib/preview.ts';
import { useUi } from '../lib/ui.tsx';

const TEXT_LIMIT = 256 * 1024;

/** « maquettes/affiche.png » → « maquettes », un fichier à la racine → « Dossier partagé ». */
function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : 'Dossier partagé';
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    let alive = true;
    setText(null);
    // Seulement le début d'un gros fichier texte.
    fetch(url, { headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } })
      .then(async (r) => {
        const total = Number(r.headers.get('content-range')?.split('/')[1] ?? 0);
        const body = await r.text();
        if (!alive) return;
        setText(body);
        setCut(total > TEXT_LIMIT);
      })
      .catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
  }, [url]);
  if (text === null) return <p className="muted">Chargement</p>;
  return (
    <pre>
      {text}
      {cut && '\n\n…'}
    </pre>
  );
}

/** Panneau à droite : image, vidéo, son ou texte, sans quitter l'app. */
export function Preview({
  target,
  folder,
  onClose,
}: {
  target: PreviewTarget;
  folder: string | null;
  onClose: () => void;
}) {
  const ui = useUi();
  const [broken, setBroken] = useState(false);
  const url = previewUrl(target);
  const kind = previewKind(target.path);
  useEffect(() => setBroken(false), [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const abs = target.root === 'shared' && folder ? absoluteIn(folder, target.path) : null;

  return (
    <aside className="panel" aria-label="Aperçu">
      <div className="panel-head">
        <div className="panel-title">
          <div>{baseName(target.path)}</div>
          <div className="muted" title={target.path}>
            {target.root === 'inbox' ? 'Fichiers reçus' : folderOf(target.path)}
          </div>
        </div>
        <button className="icon-btn" title="Fermer" onClick={onClose}>
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="panel-body">
        {broken ? (
          <div className="panel-none">
            <FileText size={18} strokeWidth={1.5} />
            <p>Fichier introuvable</p>
            <p className="muted">Il a peut-être été déplacé ou supprimé</p>
          </div>
        ) : kind === 'image' ? (
          <img src={url} alt={baseName(target.path)} onError={() => setBroken(true)} />
        ) : kind === 'video' ? (
          <video src={url} controls onError={() => setBroken(true)} />
        ) : kind === 'audio' ? (
          <audio src={url} controls onError={() => setBroken(true)} />
        ) : kind === 'text' ? (
          <TextPreview url={url} />
        ) : (
          <div className="panel-none">
            <FileText size={18} strokeWidth={1.5} />
            <p>Pas d’aperçu pour ce type de fichier</p>
            <p className="muted">Ouvre-le dans son application depuis l’Explorateur</p>
          </div>
        )}
      </div>

      <div className="panel-foot">
        {abs && (
          <button className="btn btn-small" onClick={() => void api().reveal(abs)}>
            Afficher dans l’Explorateur
          </button>
        )}
        {target.root === 'shared' && (
          <button className="btn btn-small" onClick={() => ui.discuss(target.path)}>
            <MessageSquare size={16} strokeWidth={1.5} />
            En parler
          </button>
        )}
      </div>
    </aside>
  );
}
