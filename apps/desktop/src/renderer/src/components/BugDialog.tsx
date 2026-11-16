import { useState } from 'react';
import { Camera, X } from 'lucide-react';
import { api, request } from '../lib/engine.ts';
import { errorText } from '../lib/library.ts';
import { useUi } from '../lib/ui.tsx';

/** Rapport de bug : description et capture d'écran, envoyés à l'auteur de l'app. */
export function BugDialog({ app, name, author, onClose }: { app: string; name: string; author: string; onClose: () => void }) {
  const ui = useUi();
  const [text, setText] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const capture = async () => {
    setError('');
    const data = await api().captureScreen().catch(() => null);
    if (data) setShot(data);
    else setError('Capture impossible');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await request({ req: 'lib.bug', app, text, shot });
      ui.toast(`Rapport envoyé à ${author}`);
      onClose();
    } catch (err) {
      setError(errorText(err, 'Envoi impossible'));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="bug-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="bug-title">Signaler un bug dans {name}</h2>
        <label className="field">
          <span>Ce qui se passe, et comment le refaire</span>
          <textarea rows={5} value={text} maxLength={4000} autoFocus onChange={(e) => setText(e.target.value)} disabled={busy} />
        </label>
        {shot ? (
          <div className="shot">
            <img src={`data:image/jpeg;base64,${shot}`} alt="Capture d’écran jointe" />
            <button className="icon-btn" aria-label="Retirer la capture" onClick={() => setShot(null)} disabled={busy}>
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
        ) : (
          <div className="actions">
            <button className="btn btn-small" onClick={() => void capture()} disabled={busy}>
              <Camera size={16} strokeWidth={1.5} />
              Capturer l’écran
            </button>
            <span className="muted">Binôme se cache le temps de la capture</span>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
            Envoyer à {author}
          </button>
        </div>
      </div>
    </div>
  );
}
