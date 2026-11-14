import { useCallback, useMemo, useState } from 'react';
import { ArrowLeftRight, Folder, History as HistoryIcon, MessageSquare, Settings as SettingsIcon } from 'lucide-react';
import type { EngineState } from '../../engine/api.ts';
import { Liaison } from './components/Liaison.tsx';
import { Logo } from './components/Logo.tsx';
import { ClaudeConfirm } from './components/ClaudeConfirm.tsx';
import { Preview } from './components/Preview.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { useEngine } from './lib/engine.ts';
import { routeLabel } from './lib/format.ts';
import type { PreviewTarget } from './lib/preview.ts';
import { UiContext, type Ui } from './lib/ui.tsx';
import { Chat } from './views/Chat.tsx';
import { Files } from './views/Files.tsx';
import { History } from './views/History.tsx';
import { Pairing } from './views/Pairing.tsx';
import { Settings } from './views/Settings.tsx';
import { Transfers } from './views/Transfers.tsx';

type Section = 'files' | 'transfers' | 'history' | 'chat' | 'settings';

const NAV: { id: Section; label: string; Icon: typeof Folder }[] = [
  { id: 'files', label: 'Fichiers', Icon: Folder },
  { id: 'transfers', label: 'Transferts', Icon: ArrowLeftRight },
  { id: 'history', label: 'Historique', Icon: HistoryIcon },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'settings', label: 'Paramètres', Icon: SettingsIcon },
];

/** Présence en bas de la barre latérale : la signature en petit. */
function Presence({ state }: { state: EngineState }) {
  const peer = state.peer!;
  const linkState = state.route ? 'on' : state.peerOnline ? 'pending' : 'off';
  const status =
    state.server !== 'online'
      ? 'Serveur injoignable'
      : state.route
        ? `En ligne, ${routeLabel(state.route)}`
        : state.peerOnline
          ? 'Connexion'
          : 'Hors ligne';
  return (
    <div className="presence">
      <div className="presence-names">
        <span>Toi</span>
        <span>{peer.name}</span>
      </div>
      <Liaison state={linkState} />
      <div className="presence-status">{status}</div>
    </div>
  );
}

export function App() {
  const state = useEngine();
  const [section, setSection] = useState<Section>('files');
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [draftFile, setDraftFile] = useState<string | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);

  const ui = useMemo<Ui>(
    () => ({
      openPreview: setPreview,
      discuss: (path) => {
        setDraftFile(path);
        setSection('chat');
      },
    }),
    [],
  );

  if (!state) return <div className="titlebar" />;

  return (
    <UiContext.Provider value={ui}>
      <div className="titlebar" />
      {!state.peer ? (
        <Pairing state={state} />
      ) : (
        <div className={`shell${preview ? ' has-panel' : ''}`}>
          <aside className="sidebar">
            <div className="brand">
              <Logo />
              <span className="brand-name">Binôme</span>
            </div>
            <nav>
              {NAV.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  className={`nav-item${section === id ? ' is-active' : ''}`}
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => setSection(id)}
                >
                  <Icon size={16} strokeWidth={1.5} />
                  {label}
                  {id === 'chat' && state.chat.unread > 0 && section !== 'chat' && (
                    <span className="nav-count" aria-label={`${state.chat.unread} non lus`}>
                      {state.chat.unread}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-foot">
              <UpdateBanner />
              <Presence state={state} />
            </div>
          </aside>

          {section === 'files' && <Files state={state} />}
          {section === 'transfers' && <Transfers state={state} />}
          {section === 'history' && <History state={state} />}
          {section === 'chat' && <Chat state={state} draftFile={draftFile} setDraftFile={setDraftFile} />}
          {section === 'settings' && <Settings state={state} />}

          {preview && <Preview target={preview} folder={state.sync.folder} onClose={closePreview} />}
        </div>
      )}
      <ClaudeConfirm state={state} />
    </UiContext.Provider>
  );
}
