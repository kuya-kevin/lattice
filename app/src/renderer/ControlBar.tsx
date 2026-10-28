// Logic/GarageBand-style control bar: transport buttons, an LCD (bars/beats + time, tempo,
// time signature, key) and the click / count-in toggles. Also owns recording and the key
// commands, since both drive the transport.
import { useEffect, useRef, useState } from 'react';
import { usePlaybackAnimation, usePlaylistControls, usePlaylistState } from '@waveform-playlist/browser';
import { useMicrophoneAccess, useRecording } from '@waveform-playlist/recording';
import { barLength, formatBarsBeats, formatTime, type Meter } from '../core/metronome';
import { TAP_RESET_MS, tapTempo, type TapState } from '../core/tapTempo';
import { KEYS, TEMPO_RANGE, TIME_SIGNATURES, parseKey, type Session } from '../core/session';
import { newSourceId } from './audio';
import { clicks } from './click';
import { Icon } from './icons';
import { SHORTCUTS, shortcutFor, type ShortcutAction } from './shortcuts';
import { musicalTyping } from './MusicalTyping';
import { takeToNotes, type PlayedNote, type TypingSample } from '../core/musicalTyping';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

interface Props {
  session: Session;
  run: Run;
  importFiles: (f: FileList) => void;
  addBuffer: (id: string, b: AudioBuffer) => void;
}

export function ControlBar({ session, run, importFiles, addBuffer }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { isPlaying, currentTimeRef } = usePlaybackAnimation();
  const { setLoopEnabled, setLoopRegion } = usePlaylistControls();
  const { isLoopEnabled, loopStart, loopEnd } = usePlaylistState();
  const meter: Meter = { tempo: session.tempo, timeSignature: session.timeSignature };
  const rec = useRecorder(session, run, addBuffer, meter);
  const now = () => currentTimeRef.current ?? 0;
  // Tap tempo previews in the LCD and commits once when the taps stop: one undo step, one hand edit
  const taps = useRef<TapState>();
  const tapTimer = useRef<ReturnType<typeof setTimeout>>();
  const [tapBpm, setTapBpm] = useState<number | null>(null); // shown while tapping
  useEffect(() => () => clearTimeout(tapTimer.current), []);

  const actions: Record<ShortcutAction, () => void> = {
    playStop: () => (isPlaying ? run('stop', { at: now() }) : run('play', { from: now() })),
    goToStart: () => run('go_to', { position: 0 }),
    record: () => rec.toggle(),
    metronome: () => run('set_metronome', { on: !session.metronome.on }),
    countIn: () => run('set_metronome', { count_in: !session.metronome.countIn }),
    cycle: () => {
      if (!(loopEnd > loopStart)) setLoopRegion(0, 4 * barLength(meter)); // default: bars 1-4
      setLoopEnabled(!isLoopEnabled);
    },
    barBack: () => run('go_to', { position: Math.max(0, now() - barLength(meter)) }),
    barForward: () => run('go_to', { position: now() + barLength(meter) }),
    tapTempo: () => {
      taps.current = tapTempo(taps.current, performance.now());
      const { bpm } = taps.current;
      setTapBpm(bpm ?? session.tempo);
      clearTimeout(tapTimer.current);
      tapTimer.current = setTimeout(() => {
        setTapBpm(null);
        if (bpm && bpm !== session.tempo) run('set_tempo', { bpm });
      }, TAP_RESET_MS);
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault(); // stops Space from scrolling or pressing a focused button
      if (e.type === 'keydown' && !e.repeat) actionsRef.current[action]();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, []);

  const tip = (action: ShortcutAction, label: string) => `${label} (${SHORTCUTS.find((s) => s.action === action)?.keys})`;

  // Floating islands over the canvas: session pill (left), transport + LCD (centre), file actions (right).
  return (
    <div className="controlbar" role="toolbar" aria-label="Transport">
      <div className="island pill session-pill">
        <span className="logo" aria-hidden><Icon name="spark" size={14} /></span>
        <b>Lattice</b>
        <small>{session.tracks.length ? `${session.tracks.length} track${session.tracks.length > 1 ? 's' : ''}` : 'new session'}</small>
      </div>

      <div className="island transport">
        <div className="group">
          <button className="ibtn" onClick={actions.goToStart} title={tip('goToStart', 'Go to beginning')} aria-label="Go to beginning"><Icon name="start" /></button>
          <button onClick={actions.playStop} title={tip('playStop', isPlaying ? 'Stop' : 'Play')} aria-label={isPlaying ? 'Stop' : 'Play'} className={`ibtn play${isPlaying ? ' on' : ''}`} disabled={!session.tracks.length && !isPlaying}>
            <Icon name={isPlaying ? 'stop' : 'play'} />
          </button>
          <button onClick={rec.toggle} title={tip('record', 'Record')} aria-label="Record" className={`ibtn rec${rec.isRecording || rec.countingIn ? ' on' : ''}`}><Icon name="rec" /></button>
        </div>

        <Lcd session={session} run={run} meter={meter} tapBpm={tapBpm} onTap={() => actionsRef.current.tapTempo()} recordingFor={rec.isRecording ? rec.duration : null} recordingMidi={rec.midi} countingIn={rec.countingIn} />

        <div className="group">
          <button onClick={actions.cycle} title={tip('cycle', 'Cycle')} aria-label="Cycle" className={`ibtn cycle${isLoopEnabled ? ' on' : ''}`}><Icon name="cycle" /></button>
          <button onClick={actions.metronome} title={tip('metronome', 'Click')} aria-label="Click" aria-pressed={session.metronome.on} className={`ibtn${session.metronome.on ? ' on' : ''}`}>
            <Icon name="metro" />
          </button>
          <button onClick={actions.countIn} title={tip('countIn', 'Count-in (1 bar)')} aria-label="Count-in" aria-pressed={session.metronome.countIn} className={`count-in${session.metronome.countIn ? ' on' : ''}`}>
            1234
          </button>
        </div>
      </div>

      <div className="group actions">
        <button className="island btn" onClick={() => fileRef.current?.click()}><Icon name="import" size={16} />Import…</button>
        <input ref={fileRef} type="file" accept="audio/*" multiple hidden data-testid="file-input" onChange={(e) => e.target.files && importFiles(e.target.files)} />
        <button className="island btn" onClick={() => run('add_track', { name: `Track ${session.tracks.length + 1}` })}><Icon name="plus" size={16} />Track</button>
        {!rec.micReady && <button className="island btn" onClick={rec.enableMic} title={rec.micError}><Icon name="mic" size={16} />Enable mic</button>}
      </div>
    </div>
  );
}

function Lcd({ session, run, meter, tapBpm, onTap, recordingFor, recordingMidi, countingIn }: { session: Session; run: Run; meter: Meter; tapBpm: number | null; onTap: () => void; recordingFor: number | null; recordingMidi: boolean; countingIn: boolean }) {
  const { currentTime, registerFrameCallback, unregisterFrameCallback } = usePlaybackAnimation();
  const barsRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const meterRef = useRef(meter);
  meterRef.current = meter;

  // update the readout every animation frame without re-rendering React
  useEffect(() => {
    registerFrameCallback('lcd', ({ visualTime }) => {
      if (barsRef.current) barsRef.current.textContent = formatBarsBeats(visualTime, meterRef.current);
      if (timeRef.current) timeRef.current.textContent = formatTime(visualTime);
    });
    return () => unregisterFrameCallback('lcd');
  }, [registerFrameCallback, unregisterFrameCallback]);

  return (
    <div className="lcd" data-testid="lcd">
      <div className="cell pos">
        <span className="big" ref={barsRef} data-testid="lcd-bars">{formatBarsBeats(currentTime, meter)}</span>
        <span className="label">{countingIn ? 'COUNT-IN' : recordingFor != null ? `REC${recordingMidi ? ' MIDI' : ''} ${recordingFor.toFixed(1)}s` : 'BAR BEAT'}</span>
      </div>
      <div className="cell">
        <span className="mid" ref={timeRef} data-testid="lcd-time">{formatTime(currentTime)}</span>
        <span className="label">TIME</span>
      </div>
      <div className="cell">
        <TempoField tempo={session.tempo} preview={tapBpm} onCommit={(bpm) => run('set_tempo', { bpm })} onTap={onTap} />
        <span className="label" data-testid="tempo-label">{tapBpm != null ? 'TAP' : 'BPM'}</span>
      </div>
      <div className="cell">
        <select
          className="lcd-field"
          aria-label="Time signature"
          value={session.timeSignature.join('/')}
          onChange={(e) => {
            const [beats, unit] = e.target.value.split('/').map(Number);
            run('set_time_signature', { beats, unit });
            e.target.blur();
          }}
        >
          {TIME_SIGNATURES.map((ts) => (
            <option key={ts.join('/')}>{ts.join('/')}</option>
          ))}
        </select>
        <span className="label">SIGNATURE</span>
      </div>
      <div className="cell">
        <KeyField value={session.key} onCommit={(key) => run('set_key', { key })} />
        <span className="label">KEY</span>
      </div>
    </div>
  );
}

/** Click to type a tempo; Enter or leaving the field commits, Esc cancels, ↑/↓ nudge (⇧ = 10).
 *  T taps the tempo, here or anywhere (Logic's Tap Tempo); a hint says so while it's focused.
 *  While tapping, `preview` is shown instead of the session tempo. */
function TempoField({ tempo, preview, onCommit, onTap }: { tempo: number; preview: number | null; onCommit: (bpm: number) => void; onTap: () => void }) {
  const [text, setText] = useState(String(tempo));
  const [focused, setFocused] = useState(false);
  useEffect(() => setText(String(tempo)), [tempo]);
  const commit = (value = text) => {
    const bpm = Number(value);
    if (Number.isFinite(bpm) && bpm >= TEMPO_RANGE[0] && bpm <= TEMPO_RANGE[1]) {
      if (bpm !== tempo) onCommit(bpm);
    } else setText(String(tempo));
  };
  return (
    <>
      <input
        className="lcd-field tempo"
        aria-label="Tempo"
        title="Type a tempo, or tap T"
        inputMode="decimal"
        value={preview != null ? String(preview) : text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          e.target.select();
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 't' || e.key === 'T') {
            e.preventDefault();
            if (!e.repeat) onTap();
            return;
          }
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(String(tempo));
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = Math.min(TEMPO_RANGE[1], Math.max(TEMPO_RANGE[0], Math.round(Number(text) || tempo) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)));
            setText(String(next));
            commit(String(next));
          }
        }}
      />
      {focused && <span className="tap-hint" data-testid="tap-hint" role="status">Type a BPM, or tap <kbd>T</kbd> in time</span>}
    </>
  );
}

/** Pick a key from the list or type one ("Gm", "F# major"); invalid input reverts. */
function KeyField({ value, onCommit }: { value: string | null; onCommit: (key: string) => void }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    const key = text.trim() ? parseKey(text) : '';
    if (key === null) return setText(value ?? '');
    if (key !== (value ?? '')) onCommit(key);
    setText(key);
  };
  return (
    <>
      <input
        className="lcd-field key"
        aria-label="Key"
        list="lattice-keys"
        placeholder="—"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setText(value ?? '');
        }}
      />
      <datalist id="lattice-keys">
        {KEYS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </>
  );
}

/** A MIDI take from the Musical Typing keyboard: the notes heard so far, and whether the
 *  transport has started rolling (so a stop ends the take). */
interface MidiTake {
  played: PlayedNote[];
  unsubscribe: () => void;
  rolling: boolean;
  instrument: TypingSample | null;
}

/** Recording: onto the punch-in track if armed, else the record-armed track, else the
 *  selected track, else a new one. With Musical Typing on, the take is MIDI: the transport
 *  rolls and the notes played become a MIDI clip (record_midi); otherwise it is the mic.
 *  With count-in on, one bar of clicks plays first; with the click on, it plays during the take. */
function useRecorder(session: Session, run: Run, addBuffer: (id: string, b: AudioBuffer) => void, meter: Meter) {
  const mic = useMicrophoneAccess();
  const rec = useRecording(mic.stream);
  const { isPlaying, currentTimeRef } = usePlaybackAnimation();
  const { setRecordingActive } = usePlaylistControls();
  const [countingIn, setCountingIn] = useState(false);
  const [midiFor, setMidiFor] = useState<number | null>(null); // seconds into a MIDI take
  const take = useRef<{ trackId: string; start: number; ownClick: boolean; midi?: MidiTake } | null>(null);
  const latest = useRef({ session, meter });
  latest.current = { session, meter };

  const finishMidi = async (t: { trackId: string; start: number; midi?: MidiTake }) => {
    t.midi!.unsubscribe();
    setMidiFor(null);
    const end = Math.max(t.start, currentTimeRef.current ?? t.start);
    run('stop', { at: end });
    const notes = takeToNotes(t.midi!.played, t.start, end);
    const inst = t.midi!.instrument;
    const sample = inst && { instrument: inst.name, sample: { source_id: inst.sample.sourceId, offset: inst.sample.offset, duration: inst.sample.duration, root: inst.sample.root } };
    if (notes.length) await run('record_midi', { track_id: t.trackId, start: t.start, duration: end - t.start, notes, ...sample });
  };

  const finish = async () => {
    const t = take.current;
    if (!t) return;
    take.current = null;
    if (t.midi) return finishMidi(t);
    const b = await rec.stopRecording();
    if (t.ownClick) clicks.stop();
    setRecordingActive(false);
    run('stop', { at: currentTimeRef.current ?? t.start });
    if (!b) return;
    const id = newSourceId();
    addBuffer(id, b);
    await run('record_take', { source_id: id, track_id: t.trackId, start: t.start, duration: b.duration });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // a MIDI take ends when the transport stops (Space), like in Logic
  useEffect(() => {
    const m = take.current?.midi;
    if (!m) return;
    if (isPlaying) m.rolling = true;
    else if (m.rolling) finishRef.current();
  }, [isPlaying]);
  useEffect(() => {
    if (midiFor === null) return;
    const id = setInterval(() => take.current?.midi && setMidiFor(Math.max(0, (currentTimeRef.current ?? 0) - take.current.start)), 100);
    return () => clearInterval(id);
  }, [midiFor === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const startMidi = async () => {
    const { session: s, meter: m } = latest.current;
    let trackId = s.punchIn?.trackId ?? s.tracks.find((x) => x.armed)?.id ?? s.selection.trackId;
    if (!trackId) trackId = (await run('add_track', { name: 'Keys' })).result?.track_id ?? null;
    if (!trackId) return;
    const at = s.punchIn?.start ?? currentTimeRef.current ?? 0;
    if (s.metronome.countIn) {
      setCountingIn(true);
      await clicks.countIn(m);
      setCountingIn(false);
    }
    const played: PlayedNote[] = [];
    const unsubscribe = musicalTyping.onNote((e) => {
      if (e.type === 'on') played.push({ pitch: e.pitch, velocity: e.velocity, start: e.time, end: null });
      else {
        for (let i = played.length - 1; i >= 0; i--) {
          if (played[i].pitch === e.pitch && played[i].end === null) {
            played[i].end = e.time;
            break;
          }
        }
      }
    });
    // the take keeps the instrument it was played with (a sampled clip, or the piano)
    take.current = { trackId, start: at, ownClick: false, midi: { played, unsubscribe, rolling: false, instrument: musicalTyping.instrument() } };
    setMidiFor(0);
    run('play', { from: at }); // the transport rolls (even past the last region) and is the take's clock
    if (s.punchIn) setTimeout(() => finishRef.current(), (s.punchIn.end - s.punchIn.start) * 1000);
  };

  const start = async () => {
    if (musicalTyping.get().on) return startMidi();
    if (!mic.stream) {
      await mic.requestAccess();
      return; // the stream arrives on the next render; press record again
    }
    const { session: s, meter: m } = latest.current;
    let trackId = s.punchIn?.trackId ?? s.tracks.find((x) => x.armed)?.id ?? s.selection.trackId;
    if (!trackId) trackId = (await run('add_track', { name: 'Recording' })).result?.track_id ?? null;
    if (!trackId) return;
    const at = s.punchIn?.start ?? currentTimeRef.current ?? 0;
    if (s.metronome.countIn) {
      setCountingIn(true);
      await clicks.countIn(m);
      setCountingIn(false);
    }
    if (!(await rec.startRecording())) return;
    // TODO: latency compensation and pre-roll (useIntegratedRecording has both)
    const hasAudio = s.tracks.some((x) => x.clips.length);
    take.current = { trackId, start: at, ownClick: !hasAudio && s.metronome.on };
    if (hasAudio) {
      setRecordingActive(true, trackId);
      run('play', { from: at }); // the click follows playback (TransportSync)
    } else if (s.metronome.on) {
      clicks.start(at, m); // nothing to play back: click on its own
    }
    if (s.punchIn) setTimeout(() => finishRef.current(), (s.punchIn.end - s.punchIn.start) * 1000);
  };

  return {
    isRecording: rec.isRecording || midiFor !== null,
    duration: midiFor ?? rec.duration,
    midi: midiFor !== null,
    countingIn,
    micReady: !!mic.stream,
    micError: mic.error?.message,
    enableMic: () => mic.requestAccess(),
    toggle: () => (take.current ? finish() : countingIn ? undefined : start()),
  };
}
