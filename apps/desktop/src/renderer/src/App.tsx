import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Folder, History as HistoryIcon, MessageSquare, Settings as SettingsIcon, Zap } from 'lucide-react';
import type { EngineState } from '../../engine/api.ts';
import { Avatar } from './components/Avatar.tsx';
import { Liaison } from './components/Liaison.tsx';
import { Logo } from './components/Logo.tsx';
import { ClaudeConfirm } from './components/ClaudeConfirm.tsx';
import { Preview } from './components/Preview.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { api, onEngineEvent, request, useEngine } from './lib/engine.ts';
import { routeLabel } from './lib/format.ts';
import type { PreviewTarget } from './lib/preview.ts';
import { canWizz, statusText } from './lib/profile.ts';
import { UiContext, type Ui } from './lib/ui.tsx';
import { wizzEffect } from './lib/wizz.ts';
import { Chat } from './views/Chat.tsx';
import { Files } from './views/Files.tsx';
import { History, type HistoryTab } from './views/History.tsx';
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

/** Présence en bas de la barre latérale : la signature en petit, avec les deux visages. */
function Presence({ state, onWizz }: { state: EngineState; onWizz: () => void }) {
  const peer = state.peer!;
  const online = state.route !== null;
  const linkState = state.route ? 'on' : state.peerOnline ? 'pending' : 'off';
  const status =
    state.server !== 'online'
      ? 'Serveur injoignable'
      : state.route
        ? `En ligne, ${routeLabel(state.route)}`
        : state.peerOnline
          ? 'Connexion'
          : 'Hors ligne';
  const peerStatus = online ? statusText(state.peerProfile.status) : null;
  return (
    <div className="presence">
      <div className="presence-people">
        <span className="presence-person">
          <Avatar who="me" rev={state.me.avatar} name={state.name} size={22} />
          <span>Toi</span>
        </span>
        <span className="presence-person">
          <span className="presence-peer-name">{peer.name}</span>
          <Avatar
            who="peer"
            rev={state.peerProfile.avatar}
            name={peer.name}
            size={22}
            status={online ? (state.peerProfile.status?.kind ?? 'available') : 'offline'}
          />
        </span>
      </div>
      <Liaison state={linkState} />
      <div className="presence-foot">
        <div className="presence-lines">
          <div className="presence-status">{status}</div>
          {peerStatus && (
            <div className="presence-peer-status" title={`${peer.name} : ${peerStatus}`}>
              {peerStatus}
            </div>
          )}
        </div>
        {canWizz(state) && (
          <button className="icon-btn" title={`Envoyer un wizz à ${peer.name}`} aria-label={`Envoyer un wizz à ${peer.name}`} onClick={onWizz}>
            <Zap size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const state = useEngine();
  const [section, setSection] = useState<Section>('files');
  const [historyTab, setHistoryTab] = useState<HistoryTab>('journal');
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [draftFile, setDraftFile] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const peerName = useRef('ton binôme');
  peerName.current = state?.peer?.name ?? 'ton binôme';

  const showToast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToast({ id, text });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 3500);
  }, []);

  const ui = useMemo<Ui>(
    () => ({
      openPreview: setPreview,
      discuss: (path) => {
        setDraftFile(path);
        setSection('chat');
      },
      toast: showToast,
      wizz: async () => {
        const result = await request({ req: 'wizz' }).catch(() => 'offline' as const);
        if (result === 'wait') showToast('Un wizz toutes les 10 secondes, pas plus');
        else if (result === 'offline') showToast(`${peerName.current} est hors ligne`);
        else showToast(`Wizz envoyé à ${peerName.current}`);
      },
    }),
    [showToast],
  );

  // Wizz reçu : secousse et son, sauf si on est « Occupé ».
  useEffect(
    () =>
      onEngineEvent((e) => {
        if (e.ev !== 'wizz') return;
        const who = e.from || 'Ton binôme';
        if (!e.quiet) wizzEffect();
        showToast(e.quiet ? `${who} t’a envoyé un wizz, reçu sans bruit` : `${who} t’envoie un wizz`);
      }),
    [showToast],
  );

  // Clic sur une notification Windows.
  useEffect(
    () =>
      api().onNavigate((target) => {
        if (target === 'chat') setSection('chat');
        else {
          setHistoryTab('crashes');
          setSection('history');
        }
      }),
    [],
  );

  if (!state) return <div className="titlebar" />;

  const badges: Partial<Record<Section, number>> = {
    chat: state.chat.unread,
    history: state.crashes.unseen,
  };

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
              {NAV.map(({ id, label, Icon }) => {
                const count = badges[id] ?? 0;
                return (
                  <button
                    key={id}
                    className={`nav-item${section === id ? ' is-active' : ''}`}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => setSection(id)}
                  >
                    <Icon size={16} strokeWidth={1.5} />
                    {label}
                    {count > 0 && section !== id && (
                      <span
                        className={`nav-count${id === 'history' ? ' is-alert' : ''}`}
                        aria-label={id === 'history' ? `${count} plantage(s) à voir` : `${count} non lus`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="sidebar-foot">
              <UpdateBanner />
              <Presence state={state} onWizz={() => void ui.wizz()} />
            </div>
          </aside>

          {section === 'files' && <Files state={state} />}
          {section === 'transfers' && <Transfers state={state} />}
          {section === 'history' && <History state={state} tab={historyTab} setTab={setHistoryTab} />}
          {section === 'chat' && <Chat state={state} draftFile={draftFile} setDraftFile={setDraftFile} />}
          {section === 'settings' && <Settings state={state} openCrashes={() => {
            setHistoryTab('crashes');
            setSection('history');
          }} />}

          {preview && <Preview target={preview} folder={state.sync.folder} onClose={closePreview} />}
        </div>
      )}
      <ClaudeConfirm state={state} />
      {toast && (
        <div className="toast" role="status" key={toast.id}>
          {toast.text}
        </div>
      )}
    </UiContext.Provider>
  );
}
