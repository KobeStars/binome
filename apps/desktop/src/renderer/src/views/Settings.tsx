import { useEffect, useState } from 'react';
import type { EngineState, PeerStatus, StatusKind } from '../../../engine/api.ts';
import type { UpdateInfo, UpdateStatus } from '../../../main/updater.ts';
import { Avatar } from '../components/Avatar.tsx';
import { api, request, send } from '../lib/engine.ts';
import { bytes } from '../lib/format.ts';
import { STATUS_LABEL, STATUS_SUGGESTIONS } from '../lib/profile.ts';
import { useUi } from '../lib/ui.tsx';
import { useNameField } from '../lib/use-name.ts';
import { ClaudeSettings } from '../components/ClaudeSettings.tsx';
import { LibrarySettings } from '../components/LibrarySettings.tsx';

const CAPS = [5, 10, 20, 50, 100];
const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' });
const KINDS: StatusKind[] = ['available', 'busy', 'away'];

/** Message d'une erreur venue du main, sans le préfixe ajouté par Electron. */
function errorText(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : '';
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') || fallback;
}

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

/** Photo de profil : recadrée en carré et réduite par le main, envoyée à l'autre. */
function AvatarPicker({ state }: { state: EngineState }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const peer = state.peer?.name ?? 'ton binôme';

  const choose = async () => {
    setBusy(true);
    try {
      const data = await api().pickAvatar();
      if (data) await request({ req: 'profile.avatar', data });
    } catch (err) {
      ui.toast(errorText(err, 'Cette image ne passe pas'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avatar-row">
      <Avatar who="me" rev={state.me.avatar} name={state.name} size={56} />
      <div className="avatar-row-text">
        <div className="actions">
          <button className="btn btn-small" disabled={busy} onClick={() => void choose()}>
            {state.me.avatar ? 'Changer la photo' : 'Choisir une photo'}
          </button>
          {state.me.avatar > 0 && (
            <button className="btn btn-small btn-quiet" onClick={() => void request({ req: 'profile.avatar', data: null })}>
              Retirer
            </button>
          )}
        </div>
        <p className="muted">Sans photo, ce sont tes initiales. {peer} voit la même chose que toi.</p>
      </div>
    </div>
  );
}

/** Disponibilité et petit mot, affichés chez l'autre à côté de ton nom. */
function StatusEditor({ state }: { state: EngineState }) {
  const current = state.me.status;
  const [text, setText] = useState(current?.text ?? '');
  const [dirty, setDirty] = useState(false);
  const peer = state.peer?.name ?? 'ton binôme';
  const kind = current?.kind ?? 'available';

  useEffect(() => {
    if (!dirty) setText(current?.text ?? '');
  }, [current?.text, dirty]);

  /** « Disponible » sans texte : pas de statut du tout. */
  const set = (k: StatusKind, t: string) => {
    const status: PeerStatus | null = k === 'available' && !t ? null : { kind: k, text: t };
    send({ cmd: 'profile.status', status });
  };

  const commit = () => {
    setDirty(false);
    const t = text.trim();
    if (t !== (current?.text ?? '')) set(kind, t);
  };

  return (
    <div className="field">
      <span>Statut affiché chez {peer}</span>
      <div className="segmented" role="radiogroup" aria-label="Disponibilité">
        {KINDS.map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} onClick={() => set(k, text.trim())}>
            <span className={`status-dot is-${k}`} />
            {STATUS_LABEL[k]}
          </button>
        ))}
      </div>
      <input
        value={text}
        maxLength={60}
        placeholder="Un mot pour ton binôme : en train de coder, AFK"
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <div className="chips">
        {STATUS_SUGGESTIONS.map((s) => (
          <button
            key={s.text}
            className="chip"
            onClick={() => {
              setText(s.text);
              setDirty(false);
              set(s.kind, s.text);
            }}
          >
            {s.text}
          </button>
        ))}
        {current && (
          <button
            className="chip chip-quiet"
            onClick={() => {
              setText('');
              setDirty(false);
              send({ cmd: 'profile.status', status: null });
            }}
          >
            Effacer
          </button>
        )}
      </div>
      {kind === 'busy' && <p className="muted">Occupé : les wizz de {peer} arrivent sans secousse ni son.</p>}
    </div>
  );
}

function updateLine(s: UpdateStatus): string {
  switch (s.state) {
    case 'checking':
      return 'Vérification en cours';
    case 'latest':
      return 'À jour';
    case 'downloading':
      return s.rollback ? `Retour à la ${s.version} : ${s.percent} %` : `Téléchargement de la ${s.version} : ${s.percent} %`;
    case 'ready':
      return s.rollback ? `Retour à la ${s.version}, redémarrage` : `Version ${s.version} prête`;
    case 'skipped':
      return `Version ${s.version} mise de côté : tu en es revenu`;
    case 'error':
      return s.message;
    default:
      return 'Vérifiées au démarrage puis toutes les 4 heures';
  }
}

/** Version, canal bêta, retour en arrière, partage des plantages. */
function Updates({ state, openCrashes }: { state: EngineState; openCrashes: () => void }) {
  const ui = useUi();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [confirm, setConfirm] = useState(false);
  const peer = state.peer?.name ?? 'ton binôme';

  useEffect(() => {
    void api().updateInfo().then(setInfo);
    return api().onUpdate((status) => {
      setInfo((i) => (i ? { ...i, status } : i));
      // Le reste (canal, version précédente) change rarement : relu seulement en fin d'étape.
      if (status.state !== 'downloading' && status.state !== 'checking') void api().updateInfo().then(setInfo);
    });
  }, []);

  if (!info) return null;
  const s = info.status;
  const rollingBack = (s.state === 'downloading' || s.state === 'ready') && s.rollback === true;

  return (
    <div className="card">
      <h2>Mises à jour</h2>
      <dl className="facts">
        <dt>Version</dt>
        <dd>
          <span className="num">{info.current}</span>
          {info.current.includes('-') && <span className="secondary"> bêta</span>}
        </dd>
        {state.peerProfile.app && (
          <>
            <dt>Chez {peer}</dt>
            <dd className="num">{state.peerProfile.app}</dd>
          </>
        )}
      </dl>

      {!info.enabled ? (
        <p className="muted">Les mises à jour ne marchent que dans l’app installée.</p>
      ) : (
        <>
          <div className="setting-row">
            <div>
              <div>Recevoir les versions bêta</div>
              <p className="muted">
                Tu reçois les nouveautés avant {peer} pour les tester. Si une bêta plante, tu reviens à la version
                précédente en un clic.
              </p>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={info.channel === 'beta'}
              aria-label="Recevoir les versions bêta"
              onClick={async () => setInfo(await api().setUpdateChannel(info.channel === 'beta' ? 'stable' : 'beta'))}
            />
          </div>

          <div className="update-line">
            <span className={s.state === 'error' ? 'error' : 'secondary'}>{updateLine(s)}</span>
            {s.state === 'skipped' ? (
              <button className="btn btn-small" onClick={() => void api().installSkipped()}>
                L’installer quand même
              </button>
            ) : s.state === 'ready' && !s.rollback ? (
              <button className="btn btn-small btn-primary" onClick={() => void api().installUpdate()}>
                Redémarrer
              </button>
            ) : (
              <button
                className="btn btn-small"
                disabled={s.state === 'checking' || s.state === 'downloading' || rollingBack}
                onClick={async () => setInfo(await api().checkUpdates())}
              >
                Vérifier
              </button>
            )}
          </div>

          {info.previous && !rollingBack && (
            <div className="actions">
              {confirm ? (
                <>
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      setConfirm(false);
                      try {
                        await api().rollback();
                      } catch (err) {
                        ui.toast(errorText(err, 'Retour en arrière impossible'));
                      }
                    }}
                  >
                    Revenir à la {info.previous}
                  </button>
                  <button className="btn" onClick={() => setConfirm(false)}>
                    Annuler
                  </button>
                  <span className="muted">Binôme redémarre dès la version téléchargée</span>
                </>
              ) : (
                <button className="btn" onClick={() => setConfirm(true)}>
                  Revenir à la version {info.previous}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <div className="setting-row">
        <div>
          <div>Envoyer mes plantages à {peer}</div>
          <p className="muted">
            Si Binôme plante, {peer} reçoit la fin du journal pour comprendre ce qui s’est passé.{' '}
            <button className="link" onClick={openCrashes}>
              Voir les plantages
            </button>
          </p>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={state.crashes.share}
          aria-label={`Envoyer mes plantages à ${peer}`}
          onClick={() => send({ cmd: 'crash.share', on: !state.crashes.share })}
        />
      </div>
    </div>
  );
}

export function Settings({ state, openCrashes }: { state: EngineState; openCrashes: () => void }) {
  const name = useNameField(state.name);
  const [confirm, setConfirm] = useState(false);
  const peer = state.peer;

  return (
    <section className="view">
      <header className="view-head">
        <h1>Paramètres</h1>
      </header>

      <div className="settings">
        <div className="card">
          <h2>Toi</h2>
          <AvatarPicker state={state} />
          <label className="field">
            <span>Pseudo affiché chez {peer?.name ?? 'ton binôme'}</span>
            <input value={name.value} maxLength={40} onChange={(e) => name.onChange(e.target.value)} onBlur={name.commit} />
          </label>
          <StatusEditor state={state} />
          <Autostart />
        </div>

        <Updates state={state} openCrashes={openCrashes} />

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

        <LibrarySettings state={state} />

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
      </div>
    </section>
  );
}
