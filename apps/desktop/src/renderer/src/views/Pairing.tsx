import { useEffect, useState } from 'react';
import type { EngineState } from '../../../engine/api.ts';
import { send } from '../lib/engine.ts';
import { useNameField } from '../lib/use-name.ts';

function useCountdown(until: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Ticket({ code, expiresAt }: { code: string; expiresAt: number }) {
  const left = useCountdown(expiresAt);
  return (
    <div className="ticket">
      <span className="ticket-code" aria-label={code.split('').join(' ')}>
        {code.slice(0, 3)}
        <span className="gap" />
        {code.slice(3)}
      </span>
      <span className="muted num">valable {left}</span>
    </div>
  );
}

/**
 * Écran d'appairage : ce PC à gauche, celui du binôme à droite,
 * le code posé sur le trait qui va les relier.
 */
export function Pairing({ state }: { state: EngineState }) {
  const name = useNameField(state.name);
  const [mode, setMode] = useState<'choose' | 'join'>('choose');
  const [code, setCode] = useState('');
  const p = state.pairing;
  const offline = state.server !== 'online';
  const busy = p.status === 'creating' || p.status === 'joining';
  const showing = p.status === 'showing';

  const join = () => {
    name.commit();
    send({ cmd: 'pair.join', code });
  };

  return (
    <main className="pairing">
      <div className="pairing-inner">
        <div className="pairing-head">
          <h1>Relier deux PC</h1>
          <p className="secondary">
            Un code à 6 chiffres suffit, sans compte. Ensuite, les fichiers passent directement d’un PC à l’autre, chiffrés.
          </p>
        </div>

        <div className="pairing-stage">
          <div className="pairing-end">
            <span className="liaison-dot" />
            <span className="pairing-label">{name.value.trim() || 'Ce PC'}</span>
          </div>

          <div className="pairing-track">
            {showing ? (
              <Ticket code={p.code} expiresAt={p.expiresAt} />
            ) : mode === 'join' ? (
              <form
                className="ticket"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (code.length === 6) join();
                }}
              >
                <input
                  className="ticket-input"
                  autoFocus
                  inputMode="numeric"
                  aria-label="Code reçu"
                  placeholder="000 000"
                  value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <span className="muted">Le code affiché chez ton binôme</span>
              </form>
            ) : null}
          </div>

          <div className={`pairing-end${showing || busy ? ' is-waiting' : ''}`}>
            <span className="liaison-dot is-peer" />
            <span className="pairing-label">Ton binôme</span>
          </div>
        </div>

        <div className="pairing-foot">
          {showing ? (
            <>
              <p className="secondary">Ton binôme tape ce code dans son app, et vous êtes reliés</p>
              <div className="actions">
                <button className="btn" onClick={() => send({ cmd: 'pair.cancel' })}>
                  Annuler
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span>Ton prénom, tel qu’il s’affichera chez l’autre</span>
                <input
                  value={name.value}
                  maxLength={40}
                  onChange={(e) => name.onChange(e.target.value)}
                  onBlur={name.commit}
                />
              </label>
              {mode === 'choose' ? (
                <div className="actions">
                  <button
                    className="btn btn-primary"
                    disabled={offline || busy || !name.value.trim()}
                    onClick={() => {
                      name.commit();
                      send({ cmd: 'pair.create' });
                    }}
                  >
                    {p.status === 'creating' ? 'Création du code' : 'Créer un code'}
                  </button>
                  <button className="btn" disabled={offline || busy} onClick={() => setMode('join')}>
                    J’ai un code
                  </button>
                </div>
              ) : (
                <div className="actions">
                  <button className="btn btn-primary" disabled={offline || busy || code.length !== 6} onClick={join}>
                    {p.status === 'joining' ? 'Connexion' : 'Rejoindre'}
                  </button>
                  <button className="btn" onClick={() => setMode('choose')}>
                    Retour
                  </button>
                </div>
              )}
            </>
          )}
          {p.status === 'error' && <p className="error">{p.message}</p>}
          {offline && <p className="muted">Serveur injoignable, nouvel essai automatique</p>}
        </div>
      </div>
    </main>
  );
}
