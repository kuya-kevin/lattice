// Muse on the canvas: the conversation floats on the left (collapsible) and the prompt bar sits
// at the bottom centre. The prompt bar can be tucked away into a small "Ask Muse" pill (the
// choice is remembered); sending opens the conversation. B2: hold ` or the mic button to speak a
// message instead; playback pauses, and the transcript is sent as soon as you let go.
// B14: the speaker button (set_voice_reply) has Muse read its replies aloud (voiceReply.ts).
import { useEffect, useRef, useState } from 'react';
import type { Bridge } from '../core/bridge';
import type { StepRecord } from '../core/agent';
import { groupSoundRuns, linkSoundNames, soundsFromSteps } from '../core/library';
import { showSounds } from './libraryShow';
import { clipLength } from '../core/stt';
import { Icon } from './icons';
import { recordingActive, startCapture, type Capture } from './pushToTalk';
import { isPushToTalkKey } from './shortcuts';
import { voiceReplyFor } from './voiceReply';

interface Entry {
  role: 'user' | 'muse' | 'error';
  text: string;
  steps?: StepRecord[];
  /** B2: came from push-to-talk */
  spoken?: boolean;
}

/** a push-to-talk hold in progress: the mic opens asynchronously, so `live` arrives later */
type Held = { since: number; capture: Promise<Capture>; live?: Capture };
type Talk = { phase: 'listening' } | { phase: 'transcribing' } | { phase: 'note'; text: string } | null;

interface Props {
  bridge: Bridge;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** what Muse is looking at, shown as a chip in the prompt bar (e.g. the selected track) */
  context?: string | null;
  /** B2: stop the transport while the mic is open (the speakers would reach it). B14: returns
   *  a token for resumePlayback, or null if nothing was playing. */
  pausePlayback?: () => unknown;
  /** B14: play again after Muse spoke, unless the transport moved meanwhile */
  resumePlayback?: (token: unknown) => void;
  /** B14: read Muse's replies aloud (session.voiceReply) */
  voiceOn?: boolean;
}

const PROMPT_HIDDEN_KEY = 'lattice.promptHidden';

function loadPromptHidden(): boolean {
  try {
    return localStorage.getItem(PROMPT_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function ChatPanel({ bridge, open, onOpenChange, context, pausePlayback, resumePlayback, voiceOn = false }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  // Oct 30: each project starts a new conversation with Muse (main forgets it too)
  useEffect(() => {
    const clear = () => setEntries([]);
    window.addEventListener('lattice-project-opened', clear); // ProjectMenu's PROJECT_OPENED
    return () => window.removeEventListener('lattice-project-opened', clear);
  }, []);
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
  // ---- B14 spoken replies ----
  const voice = voiceReplyFor(bridge.mode);
  voice.transport = { pause: () => pausePlayback?.() ?? null, resume: (t) => resumePlayback?.(t) };
  const [speaking, setSpeaking] = useState(voice.speaking());
  useEffect(() => voice.subscribe(setSpeaking), [voice]);
  const [voiceStatus, setVoiceStatus] = useState(voice.voice.status());
  useEffect(() => voice.voice.onStatus(setVoiceStatus), [voice]);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  useEffect(() => {
    if (!voiceOn) voice.stop();
    else voice.voice.warm?.(); // load the model now, not on the first reply
  }, [voiceOn, voice]);
  const toggleVoice = () => void bridge.runTool('set_voice_reply', { on: !voiceOn });

  const showPrompt = () => {
    setPromptHidden(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async (raw = text, spoken = false) => {
    const msg = raw.trim();
    if (!msg || busy) return;
    if (!spoken) setText('');
    setBusy(true);
    onOpenChange(true);
    setEntries((e) => [...e, { role: 'user', text: msg, spoken }]);
    const r = await bridge.sendChat(msg);
    if (r.ok && voiceOnRef.current) voice.say(r.turn.reply); // B14 (Muse may have just turned it on)
    setEntries((e) => [...e, r.ok ? { role: 'muse', text: r.turn.reply, steps: r.turn.steps } : { role: 'error', text: r.error }]);
    setBusy(false);
    queueMicrotask(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
  };

  // ---- B2 push-to-talk ----
  const [talk, setTalk] = useState<Talk>(null);
  const [meter, setMeter] = useState({ level: 0, seconds: 0 });
  const held = useRef<Held | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const note = (msg: string) => {
    setTalk({ phase: 'note', text: msg });
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setTalk((t) => (t?.phase === 'note' ? null : t)), 2500);
  };
  const startTalk = () => {
    voice.stop(); // B14: pressing push-to-talk cuts Muse off
    if (held.current) return;
    if (busy) return note('Muse is still working on the last message');
    if (recordingActive()) return note('Can’t listen while recording');
    pausePlayback?.();
    const h: Held = { since: performance.now(), capture: startCapture(() => void talkRef.current.stop()) };
    held.current = h;
    setTalk({ phase: 'listening' });
    h.capture.then(
      (c) => (h.live = c),
      (e) => {
        if (held.current === h) held.current = null;
        note(`Mic unavailable: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };
  const stopTalk = async () => {
    const h = held.current;
    if (!h) return;
    held.current = null;
    const seconds = (performance.now() - h.since) / 1000;
    const capture = await h.capture.catch(() => null);
    if (!capture) return;
    if (clipLength(seconds) === 'too short') {
      capture.cancel();
      return note('Too short: hold ` while you speak');
    }
    setTalk({ phase: 'transcribing' });
    try {
      const r = await bridge.transcribe((await capture.stop()).wav);
      if (!r.ok) throw new Error(r.error);
      setTalk(null);
      send(r.text, true);
    } catch (e) {
      setTalk(null);
      onOpenChange(true);
      setEntries((x) => [...x, { role: 'error', text: `Couldn’t transcribe: ${e instanceof Error ? e.message : String(e)}` }]);
    }
  };
  const talkRef = useRef({ start: startTalk, stop: stopTalk });
  talkRef.current = { start: startTalk, stop: stopTalk };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!isPushToTalkKey(e)) return;
      e.preventDefault();
      if (!e.repeat) talkRef.current.start();
    };
    const up = (e: KeyboardEvent) => e.code === 'Backquote' && talkRef.current.stop();
    const blur = () => talkRef.current.stop();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, []);
  const listening = talk?.phase === 'listening';
  useEffect(() => {
    if (!listening) return;
    let raf = 0;
    const tick = () => {
      const h = held.current;
      if (h) setMeter({ level: h.live?.level() ?? 0, seconds: (performance.now() - h.since) / 1000 });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [listening]);

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
            <div key={i} className={`msg ${e.role}${e.spoken ? ' spoken' : ''}`} title={e.spoken ? 'Spoken (push-to-talk)' : undefined}>
              <div className="text">{e.spoken && <Icon name="mic" size={12} className="spoken-icon" />}{e.role === 'muse' && e.steps ? withSounds(e.text, e.steps) : linkify(e.text)}</div>
              {e.role === 'muse' && e.steps && soundsFromSteps(e.steps).length > 1 && (
                <button
                  className="link show-sounds" data-testid="chat-show-sounds"
                  onClick={() => showSounds({ ids: soundsFromSteps(e.steps!).map((x) => x.library_id), label: 'From Muse' })}
                >
                  Show these {soundsFromSteps(e.steps).length} sounds in the library ›
                </button>
              )}
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

      {voiceOn && !talk && (voiceStatus.state === 'loading' || voiceStatus.state === 'error') && (
        <div className={`ptt-status island${voiceStatus.state === 'error' ? ' error' : ''}`} data-testid="voice-loading" role="status">
          <Icon name="speaker" size={14} />
          {voiceStatus.state === 'loading'
            ? (voiceStatus.progress ?? 0) >= 100
              ? "Starting Muse's voice…" // downloaded; the model is being set up on the GPU (~30 s the first time)
              : `Loading Muse's voice… ${voiceStatus.progress ?? 0}% (first time only, about 115 MB)`
            : `Muse's voice didn't load: ${voiceStatus.error}. Turn the speaker off and on to try again.`}
        </div>
      )}
      {speaking && !talk && voiceStatus.state !== 'loading' && (
        <div className="ptt-status island" data-testid="voice-status" role="status">
          <Icon name="speaker" size={14} className="live" />
          Muse is speaking… hold ` to talk
        </div>
      )}
      {talk && (
        <div className={`ptt-status island ${talk.phase}`} data-testid="ptt-status" role="status">
          {talk.phase === 'listening' ? (
            <>
              <Icon name="mic" size={14} className="live" />
              Listening… {meter.seconds.toFixed(1)} s
              <span className="ptt-meter"><i style={{ width: `${Math.round(meter.level * 100)}%` }} /></span>
            </>
          ) : talk.phase === 'transcribing' ? 'Transcribing…' : talk.text}
        </div>
      )}
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
          <button
            type="button"
            className={`ibtn sm voice${voiceOn ? ' on' : ''}`}
            aria-pressed={voiceOn}
            aria-label="Speak Muse’s replies"
            title={voiceOn ? 'Muse reads its replies aloud (click to stop)' : 'Have Muse read its replies aloud'}
            onClick={toggleVoice}
          >
            <Icon name="speaker" size={15} />
          </button>
          <button type="button" className="ibtn sm hide-prompt" onClick={() => setPromptHidden(true)} title="Hide the prompt bar" aria-label="Hide Muse prompt"><Icon name="chev" size={14} /></button>
          <button
            type="button"
            className={`ibtn sm mic${listening ? ' on' : ''}`}
            aria-label="Hold to talk to Muse"
            title="Hold to talk to Muse (or hold `)"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              startTalk();
            }}
            onPointerUp={() => stopTalk()}
            onPointerCancel={() => stopTalk()}
          >
            <Icon name="mic" size={15} />
          </button>
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

/** Sound names Muse found in the library become links: a click opens the library on that
 *  sound and plays it, with the rest of what Muse found listed around it. A run of names
 *  ("A, B, C and D") is shown as a list, one sound per row with its note. */
function withSounds(text: string, steps: StepRecord[]) {
  const sounds = soundsFromSteps(steps);
  const ids = sounds.map((x) => x.library_id);
  const noteOf = new Map(sounds.map((x) => [x.library_id, x.note]));
  const open = (id: string) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    showSounds({ ids, focus: id, label: 'From Muse' });
  };
  const link = (p: { text: string; id: string }, key: number) => (
    <a key={key} href="#" role="button" className="sound-link" data-sound={p.id} title="Open in the library and play it" onClick={open(p.id)}>{p.text}</a>
  );
  return groupSoundRuns(linkSoundNames(text, sounds)).map((p, i) =>
    'list' in p ? (
      <ul key={i} className="sound-list" data-testid="chat-sound-list">
        {p.list.map((s, j) => (
          <li key={j}>
            <a href="#" role="button" data-sound={s.id} title={`${s.text}: open in the library and play it`} onClick={open(s.id)}>
              <span className="play" aria-hidden>▶</span>
              <span className="nm">{s.text}</span>
              {noteOf.get(s.id) && <span className="note">{noteOf.get(s.id)}</span>}
            </a>
          </li>
        ))}
      </ul>
    ) : 'id' in p ? link(p, i) : <span key={i}>{linkify(p.text)}</span>,
  );
}

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+\.mp3)/g).map((part, i) =>
    /^https?:\/\/\S+\.mp3$/.test(part) ? <audio key={i} controls preload="none" src={part} /> : <span key={i}>{part}</span>,
  );
}
