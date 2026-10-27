// Muse on the canvas: the conversation floats on the left (collapsible) and the prompt bar sits
// at the bottom centre. The prompt bar can be tucked away into a small "Ask Muse" pill (the
// choice is remembered); sending opens the conversation.
import { useEffect, useRef, useState } from 'react';
import type { Bridge } from '../core/bridge';
import type { StepRecord } from '../core/agent';
import { Icon } from './icons';

interface Entry {
  role: 'user' | 'muse' | 'error';
  text: string;
  steps?: StepRecord[];
}

interface Props {
  bridge: Bridge;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** what Muse is looking at, shown as a chip in the prompt bar (e.g. the selected track) */
  context?: string | null;
}

const PROMPT_HIDDEN_KEY = 'lattice.promptHidden';

function loadPromptHidden(): boolean {
  try {
    return localStorage.getItem(PROMPT_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function ChatPanel({ bridge, open, onOpenChange, context }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [promptHidden, setPromptHidden] = useState(loadPromptHidden);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_HIDDEN_KEY, promptHidden ? '1' : '0');
    } catch {
      // private window or blocked storage: the choice just isn't remembered
    }
  }, [promptHidden]);
  const showPrompt = () => {
    setPromptHidden(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setText('');
    setBusy(true);
    onOpenChange(true);
    setEntries((e) => [...e, { role: 'user', text: msg }]);
    const r = await bridge.sendChat(msg);
    setEntries((e) => [...e, r.ok ? { role: 'muse', text: r.turn.reply, steps: r.turn.steps } : { role: 'error', text: r.error }]);
    setBusy(false);
    queueMicrotask(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
  };

  return (
    <>
      <aside className="chat island" aria-label="Muse chat" hidden={!open}>
        <header>
          <Icon name="spark" size={15} className="spark" />
          Muse {bridge.mode === 'web' && <span className="badge">offline mock</span>}
          <button className="ibtn sm close" aria-label="Hide Muse" title="Hide Muse" onClick={() => onOpenChange(false)}><Icon name="close" size={14} /></button>
        </header>
        <div className="chat-list" ref={listRef} data-testid="chat-list">
          {entries.length === 0 && (
            <div className="hint">
              <p>Ask for what you want to hear. Muse turns the knobs and tells you which ones it moved.</p>
              <ul>
                <li>“Make my vocal stand out in the mix”</li>
                <li>“Turn the hum into a lead, keep it in key”</li>
                <li>“Trim the vocal to 2–9 s and duck the drums 3 dB”</li>
              </ul>
              <p>Your own edits are passed to Muse as feedback.</p>
            </div>
          )}
          {entries.map((e, i) => (
            <div key={i} className={`msg ${e.role}`}>
              <div className="text">{linkify(e.text)}</div>
              {e.steps && e.steps.length > 0 && (
                <ul className="steps">
                  {e.steps.map((s, j) => (
                    <li key={j} className={s.outcome.ok ? 'ok' : 'fail'} title={JSON.stringify(s.outcome.ok ? s.outcome.result : s.outcome.error)}>
                      <b>{s.tool}</b>({compact(s.args)}){s.outcome.ok ? '' : ` ✗ ${s.outcome.error}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {busy && <div className="msg muse pending">Muse is working…</div>}
        </div>
      </aside>

      {promptHidden && (
        <button type="button" className="prompt-pill island" onClick={showPrompt} title="Show the Muse prompt bar" aria-label="Show Muse prompt">
          <Icon name="spark" size={14} className="spark" />Ask Muse
        </button>
      )}
      <form
        className="prompt island"
        hidden={promptHidden}
        onSubmit={(ev) => {
          ev.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          aria-label="Message Muse"
          rows={1}
          value={text}
          placeholder="Tell Muse what to change, e.g. trim the vocal to 2–9 s and duck the drums 3 dB"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="prompt-row">
          {!open && entries.length > 0 && (
            <button type="button" className="chip" onClick={() => onOpenChange(true)}>{entries.length} messages</button>
          )}
          {context && <span className="chip ctx" title="Muse sees this selection">{context}</span>}
          <span className="spacer" />
          <button type="button" className="ibtn sm hide-prompt" onClick={() => setPromptHidden(true)} title="Hide the prompt bar" aria-label="Hide Muse prompt"><Icon name="chev" size={14} /></button>
          <button type="submit" className="send" disabled={busy || !text.trim()}><Icon name="send" size={16} />Send</button>
        </div>
      </form>
    </>
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
