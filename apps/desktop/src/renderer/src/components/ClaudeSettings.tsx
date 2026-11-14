import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ClaudeConnectView, EngineState } from '../../../engine/api.ts';
import { CATALOG, TOOL_NAMES, type ToolKind } from '../../../claude/catalog.ts';
import { request, send } from '../lib/engine.ts';

function CopyBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{label}</span>
        <button
          className="btn btn-small btn-quiet"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={16} strokeWidth={1.5} /> : <Copy size={16} strokeWidth={1.5} />}
          {copied ? 'Copié' : 'Copier'}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      className="switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

const GROUPS: { kind: ToolKind; title: string }[] = [
  { kind: 'read', title: 'Lecture' },
  { kind: 'write', title: 'Écriture' },
];

/** Section Claude des Paramètres : autorisation, droits par outil, connexion. */
export function ClaudeSettings({ state }: { state: EngineState }) {
  const c = state.claude;
  const [connect, setConnect] = useState<ClaudeConnectView | null>(null);

  const setRight = (name: string, on: boolean) => send({ cmd: 'claude.settings', rights: { [name]: on } });
  const preset = (write: boolean) =>
    send({
      cmd: 'claude.settings',
      rights: Object.fromEntries(TOOL_NAMES.map((n) => [n, CATALOG[n].kind === 'read' || write])),
    });

  const openConnect = async () => {
    if (!c.enabled) send({ cmd: 'claude.settings', enabled: true });
    setConnect(await request({ req: 'claude.connect' }));
  };

  return (
    <div className="card">
      <h2>Claude</h2>
      <div className="setting-row">
        <div>
          <div>Autoriser Claude à utiliser Binôme</div>
          <p className="muted">Ton Claude n’agit que sur ce PC : ton dossier partagé, ton historique, ton chat</p>
        </div>
        <Switch on={c.enabled} label="Autoriser Claude" onChange={(on) => send({ cmd: 'claude.settings', enabled: on })} />
      </div>

      {GROUPS.map((g) => (
        <div key={g.kind} className="tool-group">
          <div className="tool-group-head">
            <span>{g.title}</span>
            {g.kind === 'write' && (
              <span className="actions">
                <button className="btn btn-small btn-quiet" onClick={() => preset(false)}>
                  Lecture seule
                </button>
                <button className="btn btn-small btn-quiet" onClick={() => preset(true)}>
                  Lecture et écriture
                </button>
              </span>
            )}
          </div>
          <ul className="list">
            {TOOL_NAMES.filter((n) => CATALOG[n].kind === g.kind).map((n) => (
              <li key={n} className="row tool-row">
                <div className="row-main">
                  <div>{CATALOG[n].title}</div>
                  <div className="muted">{CATALOG[n].hint}</div>
                </div>
                <Switch on={c.rights[n] === true} label={CATALOG[n].title} disabled={!c.enabled} onChange={(on) => setRight(n, on)} />
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="setting-row">
        <div>
          <div>Serveur HTTP local</div>
          <p className="muted">
            Option pour Claude Code, sur 127.0.0.1:{c.http.port}, protégée par un jeton. Claude Desktop n’en a pas besoin
          </p>
        </div>
        <Switch
          on={c.http.enabled}
          label="Serveur HTTP local"
          disabled={!c.enabled}
          onChange={(on) => {
            send({ cmd: 'claude.settings', http: { enabled: on } });
            if (connect) void request({ req: 'claude.connect' }).then(setConnect);
          }}
        />
      </div>

      <div className="actions">
        <button className="btn btn-primary" onClick={() => void openConnect()}>
          Connecter Claude
        </button>
      </div>

      {connect && (
        <div className="connect">
          <p className="secondary">
            Claude Desktop : ouvre Paramètres, Développeur, Modifier la config, et ajoute ce bloc dans
            claude_desktop_config.json. Redémarre ensuite Claude Desktop.
          </p>
          <CopyBlock label="claude_desktop_config.json" code={connect.desktopConfig} />
          <p className="secondary">Claude Code : lance cette commande dans un terminal.</p>
          <CopyBlock label="Claude Code" code={connect.codeCommand} />
          {connect.httpCommand && <CopyBlock label="Claude Code, en HTTP" code={connect.httpCommand} />}
          <p className="muted">
            {connect.httpCommand ? 'La commande HTTP contient le jeton de ton app : ne la partage pas. ' : ''}
            Binôme doit être ouvert pour que Claude l’utilise.
          </p>
        </div>
      )}
    </div>
  );
}
