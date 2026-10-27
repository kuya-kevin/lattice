import { useRef, useState } from 'react';
import type { Bridge } from '../core/bridge';
import type { StepRecord } from '../core/agent';

interface Entry {
  role: 'user' | 'muse' | 'error';
  text: string;
  steps?: StepRecord[];
}

export function ChatPanel({ bridge }: { bridge: Bridge }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setText('');
    setBusy(true);
    setEntries((e) => [...e, { role: 'user', text: msg }]);
    const r = await bridge.sendChat(msg);
    setEntries((e) => [...e, r.ok ? { role: 'muse', text: r.turn.reply, steps: r.turn.steps } : { role: 'error', text: r.error }]);
    setBusy(false);
    queueMicrotask(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
  };

  return (
    <aside className="chat" aria-label="Muse chat">
      <header>Muse {bridge.mode === 'web' && <span className="badge">offline mock</span>}</header>
      <div className="chat-list" ref={listRef} data-testid="chat-list">
        {entries.length === 0 && <p className="hint">Ask Muse to trim, mix, punch in, or find a sound. Your own edits are passed to Muse as feedback.</p>}
        {entries.map((e, i) => (
          <div key={i} className={`msg ${e.role}`}>
            {e.steps && e.steps.length > 0 && (
              <ul className="steps">
                {e.steps.map((s, j) => (
                  <li key={j} className={s.outcome.ok ? 'ok' : 'fail'} title={JSON.stringify(s.outcome.ok ? s.outcome.result : s.outcome.error)}>
                    {s.tool}({compact(s.args)}){s.outcome.ok ? '' : ` ✗ ${s.outcome.error}`}
                  </li>
                ))}
              </ul>
            )}
            <div className="text">{linkify(e.text)}</div>
          </div>
        ))}
        {busy && <div className="msg muse pending">Muse is working…</div>}
      </div>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          send();
        }}
      >
        <textarea
          value={text}
          placeholder="e.g. trim the vocal to 2–9 s and duck the drums 3 dB"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}

function compact(args: unknown): string {
  const s = JSON.stringify(args) ?? '';
  return s.length > 80 ? s.slice(0, 77) + '…' : s.replace(/^\{|\}$/g, '');
}

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+\.mp3)/g).map((part, i) =>
    /^https?:\/\/\S+\.mp3$/.test(part) ? <audio key={i} controls preload="none" src={part} /> : <span key={i}>{part}</span>,
  );
}
