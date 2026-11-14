import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import type { ChatMessageView, EngineState } from '../../../engine/api.ts';
import { FileIcon } from '../components/FileIcon.tsx';
import { Liaison } from '../components/Liaison.tsx';
import { request, send } from '../lib/engine.ts';
import { baseName } from '../lib/preview.ts';
import { useUi } from '../lib/ui.tsx';

const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const GROUP_MS = 5 * 60_000;

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return day.format(d);
}

/** Messages consécutifs du même auteur, à moins de 5 minutes d'écart. */
function groups(messages: ChatMessageView[]): ChatMessageView[][] {
  const out: ChatMessageView[][] = [];
  for (const m of messages) {
    const last = out.at(-1);
    const prev = last?.at(-1);
    if (last && prev && prev.mine === m.mine && m.at - prev.at < GROUP_MS && dayLabel(prev.at) === dayLabel(m.at)) {
      last.push(m);
    } else out.push([m]);
  }
  return out;
}

export function Chat({
  state,
  draftFile,
  setDraftFile,
}: {
  state: EngineState;
  draftFile: string | null;
  setDraftFile: (path: string | null) => void;
}) {
  const ui = useUi();
  const peer = state.peer?.name ?? 'ton binôme';
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const revision = state.chat.revision;

  useEffect(() => {
    void request({ req: 'chat.list' }).then(setMessages, () => setMessages([]));
    // La vue est à l'écran : ce qui arrive est lu. Fenêtre cachée dans la barre des tâches : non.
    if (document.visibilityState === 'visible') send({ cmd: 'chat.read' });
  }, [revision]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') send({ cmd: 'chat.read' });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (draftFile) input.current?.focus();
  }, [draftFile]);

  // Reste collé en bas quand un message arrive.
  useLayoutEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [messages.length]);

  // Zone de saisie qui grandit avec le texte.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim()) return;
    send({ cmd: 'chat.send', text, file: draftFile });
    setText('');
    setDraftFile(null);
  };

  const files = state.sync.recent.filter((r) => !r.deleted);

  return (
    <section className="chat">
      <header className="view-head">
        <div>
          <h1>Chat</h1>
          <p className="secondary">
            Avec {peer}
            {state.route ? '' : ', hors ligne pour l’instant'}
          </p>
        </div>
      </header>

      <div className="thread" ref={thread}>
        {messages.length === 0 && (
          <div className="empty">
            <p>Écris à {peer}</p>
            <p className="muted">Un message écrit hors ligne part dès que vous êtes reliés</p>
          </div>
        )}
        {groups(messages).map((g, i, all) => {
          const first = g[0]!;
          const last = g.at(-1)!;
          const newDay = i === 0 || dayLabel(all[i - 1]![0]!.at) !== dayLabel(first.at);
          return (
            <Fragment key={first.id}>
              {newDay && <div className="thread-day">{dayLabel(first.at)}</div>}
              <div className={`group${first.mine ? ' is-mine' : ''}`}>
                {g.map((m) => (
                  <div key={m.id} className="bubble">
                    {m.file && (
                      <button className="bubble-file" onClick={() => ui.openPreview({ root: 'shared', path: m.file! })}>
                        <FileText size={16} strokeWidth={1.5} />
                        {m.file}
                      </button>
                    )}
                    {m.text}
                  </div>
                ))}
                <div className="group-meta">
                  {g.some((m) => m.via === 'claude') && <span className="via">via Claude</span>}
                  <span className="num">{time.format(last.at)}</span>
                  {last.mine && (
                    <span title={last.status === 'pending' ? 'En attente de ' + peer : 'Reçu'}>
                      <Liaison state={last.status === 'pending' ? 'off' : 'sent'} />
                    </span>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      <div className="composer">
        {picking && (
          <ul className="list picker">
            {files.length === 0 && <li className="row muted">Aucun fichier dans le dossier partagé</li>}
            {files.map((f) => (
              <li key={f.path}>
                <button
                  className="row"
                  onClick={() => {
                    setDraftFile(f.path);
                    setPicking(false);
                  }}
                >
                  <FileIcon path={f.path} />
                  <span className="row-main">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={input}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={`Message à ${peer}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-foot">
          {draftFile ? (
            <span className="composer-file" title={draftFile}>
              <FileText size={16} strokeWidth={1.5} />
              <span>{baseName(draftFile)}</span>
              <button className="icon-btn" title="Retirer" onClick={() => setDraftFile(null)}>
                <X size={16} strokeWidth={1.5} />
              </button>
            </span>
          ) : (
            <button className="btn btn-small btn-quiet" onClick={() => setPicking((p) => !p)} disabled={!state.sync.folder}>
              <Paperclip size={16} strokeWidth={1.5} />
              Citer un fichier
            </button>
          )}
          <button className="btn btn-small btn-primary" disabled={!text.trim()} onClick={submit}>
            Envoyer
          </button>
        </div>
      </div>
    </section>
  );
}
