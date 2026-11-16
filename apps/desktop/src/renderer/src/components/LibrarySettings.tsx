import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import type { EngineState } from '../../../engine/api.ts';
import { api, send } from '../lib/engine.ts';
import { ACCENTS, setFx, useFx } from '../lib/fx.ts';

const DISCORD_STATUS = {
  off: 'Désactivé',
  connecting: 'Connexion à Discord',
  connected: 'Relié à Discord',
  unavailable: 'Discord n’est pas ouvert',
} as const;

function Switch({ label, hint, on, set }: { label: string; hint: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="setting-row">
      <div>
        <div>{label}</div>
        <p className="muted">{hint}</p>
      </div>
      <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} />
    </div>
  );
}

export function LibrarySettings({ state }: { state: EngineState }) {
  const lib = state.library;
  const fx = useFx();
  const [clientId, setClientId] = useState(lib.discord.clientId);
  useEffect(() => setClientId(lib.discord.clientId), [lib.discord.clientId]);
  const peer = state.peer?.name ?? 'ton binôme';

  return (
    <>
      <div className="card">
        <h2>Bibliothèque</h2>
        <div className="field">
          <span>Dossier d’installation des jeux et apps</span>
          <div className="actions">
            <span className="path mono" title={lib.dir}>
              {lib.dir}
            </span>
            <button
              className="btn btn-small"
              onClick={async () => {
                const p = await api().pickFolder();
                if (p) send({ cmd: 'lib.settings', dir: p });
              }}
            >
              Changer
            </button>
          </div>
          <p className="muted">Les apps déjà installées restent où elles sont.</p>
        </div>
        <Switch
          label="Mises à jour automatiques"
          hint={`Une nouvelle version publiée par ${peer} se télécharge seule, fichiers modifiés seulement`}
          on={lib.autoUpdate}
          set={(v) => send({ cmd: 'lib.settings', autoUpdate: v })}
        />
        <label className="field">
          <span>Discord Rich Presence : identifiant d’application</span>
          <input
            className="mono"
            value={clientId}
            placeholder="Developer Portal > Applications > Application ID"
            inputMode="numeric"
            onChange={(e) => setClientId(e.target.value.replace(/\D/g, ''))}
            onBlur={() => clientId !== lib.discord.clientId && send({ cmd: 'lib.settings', discordClientId: clientId })}
          />
        </label>
        <p className="muted">
          {DISCORD_STATUS[lib.discord.status]}. Avec un identifiant, Discord affiche « Joue à … » quand tu lances un jeu
          depuis Binôme.
        </p>
      </div>

      <div className="card">
        <h2>Ambiance</h2>
        <Switch label="Sons" hint="Succès, niveau, fin d’installation, demande de test" on={fx.sounds} set={(v) => setFx({ sounds: v })} />
        <Switch label="Animations" hint="Transitions et apparitions" on={fx.motion} set={(v) => setFx({ motion: v })} />
        <div className="field">
          <span>Couleur d’accent, débloquée avec le niveau</span>
          <div className="accents" role="radiogroup" aria-label="Couleur d’accent">
            {ACCENTS.map((a) => {
              const locked = a.level > lib.level.level;
              return (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={fx.accent === a.id}
                  disabled={locked}
                  title={locked ? `Niveau ${a.level}` : a.name}
                  onClick={() => setFx({ accent: a.id })}
                  className="accent"
                >
                  <span className="accent-dot" style={{ background: a.color }} />
                  {a.name}
                  {locked && (
                    <span className="accent-lock num">
                      <Lock size={12} strokeWidth={1.5} />
                      {a.level}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
