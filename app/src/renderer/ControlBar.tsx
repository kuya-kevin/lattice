// Logic/GarageBand-style control bar: transport buttons, an LCD (bars/beats + time, tempo,
// time signature, key) and the click / count-in toggles. Also owns recording and the key
// commands, since both drive the transport.
import { useEffect, useRef, useState } from 'react';
import { usePlaybackAnimation, usePlaylistControls, usePlaylistState } from '@waveform-playlist/browser';
import { useMicrophoneAccess, useRecording } from '@waveform-playlist/recording';
import { barLength, formatBarsBeats, formatTime, type Meter } from '../core/metronome';
import { KEYS, TEMPO_RANGE, TIME_SIGNATURES, parseKey, type Session } from '../core/session';
import { newSourceId } from './audio';
import { clicks } from './click';
import { Icon } from './icons';
import { SHORTCUTS, shortcutFor, type ShortcutAction } from './shortcuts';

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

        <Lcd session={session} run={run} meter={meter} recordingFor={rec.isRecording ? rec.duration : null} countingIn={rec.countingIn} />

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

function Lcd({ session, run, meter, recordingFor, countingIn }: { session: Session; run: Run; meter: Meter; recordingFor: number | null; countingIn: boolean }) {
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
        <span className="label">{countingIn ? 'COUNT-IN' : recordingFor != null ? `REC ${recordingFor.toFixed(1)}s` : 'BAR BEAT'}</span>
      </div>
      <div className="cell">
        <span className="mid" ref={timeRef} data-testid="lcd-time">{formatTime(currentTime)}</span>
        <span className="label">TIME</span>
      </div>
      <div className="cell">
        <TempoField tempo={session.tempo} onCommit={(bpm) => run('set_tempo', { bpm })} />
        <span className="label">BPM</span>
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

/** Click to type a tempo; Enter or leaving the field commits, Esc cancels, ↑/↓ nudge (⇧ = 10). */
function TempoField({ tempo, onCommit }: { tempo: number; onCommit: (bpm: number) => void }) {
  const [text, setText] = useState(String(tempo));
  useEffect(() => setText(String(tempo)), [tempo]);
  const commit = (value = text) => {
    const bpm = Number(value);
    if (Number.isFinite(bpm) && bpm >= TEMPO_RANGE[0] && bpm <= TEMPO_RANGE[1]) {
      if (bpm !== tempo) onCommit(bpm);
    } else setText(String(tempo));
  };
  return (
    <input
      className="lcd-field tempo"
      aria-label="Tempo"
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => commit()}
      onKeyDown={(e) => {
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

/** Mic recording: onto the punch-in track if armed, else the record-armed track, else the
 *  selected track, else a new one.
 *  With count-in on, one bar of clicks plays first; with the click on, it plays during the take. */
function useRecorder(session: Session, run: Run, addBuffer: (id: string, b: AudioBuffer) => void, meter: Meter) {
  const mic = useMicrophoneAccess();
  const rec = useRecording(mic.stream);
  const { currentTimeRef } = usePlaybackAnimation();
  const { setRecordingActive } = usePlaylistControls();
  const [countingIn, setCountingIn] = useState(false);
  const take = useRef<{ trackId: string; start: number; ownClick: boolean } | null>(null);
  const latest = useRef({ session, meter });
  latest.current = { session, meter };

  const finish = async () => {
    const t = take.current;
    if (!t) return;
    take.current = null;
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

  const start = async () => {
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
    isRecording: rec.isRecording,
    duration: rec.duration,
    countingIn,
    micReady: !!mic.stream,
    micError: mic.error?.message,
    enableMic: () => mic.requestAccess(),
    toggle: () => (take.current ? finish() : countingIn ? undefined : start()),
  };
}
