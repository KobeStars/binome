// Markdown des pages de la Bibliothèque, rendu en éléments React : jamais de HTML brut,
// donc ni script ni balise venue du texte. Sous-ensemble : titres, paragraphes, listes,
// citations, blocs de code, gras, italique, code, liens http(s).

import type { ReactNode } from 'react';
import { api } from './engine.ts';

type Block =
  | { k: 'h'; level: number; text: string }
  | { k: 'p'; text: string }
  | { k: 'ul' | 'ol'; items: string[] }
  | { k: 'quote'; text: string }
  | { k: 'code'; text: string }
  | { k: 'hr' };

function blocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ k: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ k: 'code', text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ k: 'h', level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      out.push({ k: 'hr' });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = /\d/.test(li[1]!) ? 'ol' : 'ul';
      const last = out[out.length - 1];
      if (last && last.k === kind) last.items.push(li[2]!);
      else out.push({ k: kind, items: [li[2]!] });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const last = out[out.length - 1];
      if (last?.k === 'quote') last.text += ` ${q[1]}`;
      else out.push({ k: 'quote', text: q[1]! });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** Gras, italique, code et liens dans une ligne. */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${m.index}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), m.index)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(m[3].slice(1, -1), m.index)}</em>);
    else if (m[4]) out.push(<Link key={k} href={m[5]!} label={m[4].slice(1, m[4].indexOf(']'))} />);
    else if (m[6]) out.push(<Link key={k} href={m[6]} label={m[6]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        void api().openLink(href);
      }}
    >
      {label}
    </a>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((b, i) => {
        switch (b.k) {
          case 'h':
            return b.level === 1 ? <h3 key={i}>{inline(b.text)}</h3> : <h4 key={i}>{inline(b.text)}</h4>;
          case 'p':
            return <p key={i}>{inline(b.text)}</p>;
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((t, j) => (
                  <li key={j}>{inline(t)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((t, j) => (
                  <li key={j}>{inline(t)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={i}>{inline(b.text)}</blockquote>;
          case 'code':
            return <pre key={i}>{b.text}</pre>;
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
