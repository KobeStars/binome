import { useEffect, useState } from 'react';
import type { EngineState } from '../../../engine/api.ts';
import { api, send } from '../lib/engine.ts';
import { bytes } from '../lib/format.ts';
import { useNameField } from '../lib/use-name.ts';
import { ClaudeSettings } from '../components/ClaudeSettings.tsx';

const CAPS = [5, 10, 20, 50, 100];
const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' });

function Autostart() {
  const [s, setS] = useState<{ available: boolean; enabled: boolean } | null>(null);
  useEffect(() => {
    void api().autostartGet().then(setS);
  }, []);
  if (!s) return null;
  return (
    <div className="setting-row">
      <div>
        <div>Lancer au démarrage de Windows</div>
        <p className="muted">
          {s.available
            ? 'Binôme démarre près de l’horloge, sans fenêtre, et garde le dossier à jour'
            : 'Disponible une fois l’app installée'}
        </p>
      </div>
      <button
        className="switch"
        role="switch"
        aria-checked={s.enabled}
        aria-label="Lancer au démarrage de Windows"
        disabled={!s.available}
        onClick={async () => setS({ ...s, enabled: await api().autostartSet(!s.enabled) })}
      />
    </div>
  );
}

export function Settings({ state }: { state: EngineState }) {
  const name = useNameField(state.name);
  const [confirm, setConfirm] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => {
    void api().appVersion().then(setVersion);
  }, []);
  const peer = state.peer;

  return (
    <section className="view">
      <header className="view-head">
        <h1>Paramètres</h1>
      </header>

      <div className="settings">
        <div className="card">
          <h2>Toi</h2>
          <label className="field">
            <span>Prénom affiché chez ton binôme</span>
            <input value={name.value} maxLength={40} onChange={(e) => name.onChange(e.target.value)} onBlur={name.commit} />
          </label>
          <Autostart />
        </div>

        {state.sync.folder && (
          <div className="card">
            <h2>Historique</h2>
            <label className="field">
              <span>Espace maximal pour les versions et la corbeille</span>
              <select
                value={Math.round(state.sync.capBytes / 1024 ** 3)}
                onChange={(e) => send({ cmd: 'sync.setHistoryCap', gb: Number(e.target.value) })}
              >
                {CAPS.map((gb) => (
                  <option key={gb} value={gb}>
                    {gb} Go
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {bytes(state.sync.storeBytes)} utilisés, fichiers actuels compris. Au-delà, les versions les plus anciennes
              partent en premier.
            </p>
          </div>
        )}

        <ClaudeSettings state={state} />

        {peer && (
          <div className="card">
            <h2>Appairage</h2>
            <dl className="facts">
              <dt>Relié à</dt>
              <dd>{peer.name}</dd>
              <dt>Depuis le</dt>
              <dd>{date.format(peer.pairedAt)}</dd>
              <dt>Code de vérification</dt>
              <dd className="num">{peer.safetyCode}</dd>
            </dl>
            <p className="muted">
              Ce code doit être le même chez {peer.name}. S’il diffère, quelqu’un s’est interposé pendant l’appairage :
              dissociez-vous et recommencez.
            </p>
            {confirm ? (
              <div className="actions">
                <button className="btn btn-danger" onClick={() => send({ cmd: 'unpair' })}>
                  Dissocier
                </button>
                <button className="btn" onClick={() => setConfirm(false)}>
                  Garder
                </button>
                <span className="muted">Il faudra un nouveau code pour vous relier</span>
              </div>
            ) : (
              <div className="actions">
                <button className="btn" onClick={() => setConfirm(true)}>
                  Dissocier ce PC
                </button>
              </div>
            )}
          </div>
        )}

        <p className="muted version num">Binôme {version}</p>
      </div>
    </section>
  );
}
