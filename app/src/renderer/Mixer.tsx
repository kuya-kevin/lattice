// The mixer (X): one channel strip per track side by side, as in Logic's Mixer, so the tracks'
// levels read against each other. Each strip has a pan knob, a volume fader with a live
// post-fader meter beside it (peak, L and R), Mute / Solo, and the track's name in its colour.
// The fader and pan knob are the track's Utility Gain and Pan, the same values the device panel
// shows; they move them with set_utility_gain and set_pan, the tools Muse uses (editTools.ts; they
// add a Utility when there is none). The track volume (set_gain) stays on the track header slider.
// Both play live while dragged and commit on release; click the dB readout to type a gain.
import { useEffect, useRef, useState } from 'react';
import { usePlaylistControls, usePlaylistData } from '@waveform-playlist/browser';
import type { Session, Track } from '../core/session';
import { panUtility } from '../core/editTools';
import { panText } from '../core/setups';
import { previewParam, trackLevels } from '../fx/engine/live';
import { dbToGain } from './audio';
import { trackColor } from './TrackHeader';
import './Mixer.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** The fader and meter share one scale, so a meter at the fader cap reads as that level. */
const TOP_DB = 12;
const BOTTOM_DB = -60;
const SCALE = [12, 6, 0, -6, -12, -24, -40, -60];
/** The fader's travel: the Utility Gain's floor up to the scale's top (the Utility goes to +24; a
 *  typed value above +12 pins the cap at the top). */
const FADER_MIN = -48;
const UTILITY_MAX = 24;
const heightOf = (db: number) => (Math.max(BOTTOM_DB, Math.min(TOP_DB, db)) - BOTTOM_DB) / (TOP_DB - BOTTOM_DB);
const dbText = (db: number) => (db === -Infinity || db <= BOTTOM_DB ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

export function Mixer({ session, run }: { session: Session; run: Run }) {
  const levels = useLevels(session.tracks.map((t) => t.id));
  if (!session.tracks.length) return <p className="hint">Add a track to mix it here.</p>;
  return (
    <div className="mixer" data-testid="mixer" role="group" aria-label="Mixer">
      {session.tracks.map((t, i) => (
        <Strip key={t.id} session={session} track={t} index={i} run={run} levels={levels[t.id]} />
      ))}
    </div>
  );
}

/** Live peak per track and channel (dBFS), with the highest peak held until clicked. */
function useLevels(ids: string[]) {
  const [levels, setLevels] = useState<Record<string, { now: number[]; held: number }>>({});
  const key = ids.join(',');
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (time - last < 33) return; // ~30 fps is plenty for a meter
      last = time;
      setLevels((cur) => {
        const next: typeof cur = {};
        for (const id of key ? key.split(',') : []) {
          const now = trackLevels(id) ?? [-Infinity, -Infinity];
          const prev = cur[id];
          // the bar falls back smoothly (~20 dB/s) rather than flickering, as meters do
          const shown = now.map((v, c) => Math.max(v, (prev?.now[c] ?? -Infinity) - 0.7));
          next[id] = { now: shown, held: Math.max(prev?.held ?? -Infinity, ...now) };
        }
        return next;
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [key]);
  const reset = (id: string) => setLevels((cur) => ({ ...cur, [id]: { now: cur[id]?.now ?? [], held: -Infinity } }));
  return Object.fromEntries(ids.map((id) => [id, { ...(levels[id] ?? { now: [-Infinity, -Infinity], held: -Infinity }), reset: () => reset(id) }]));
}

function Strip({ session, track: t, index, run, levels }: { session: Session; track: Track; index: number; run: Run; levels: { now: number[]; held: number; reset: () => void } }) {
  const { setTrackVolume, setTrackPan } = usePlaylistControls();
  const { tracks } = usePlaylistData();
  const engineIndex = tracks.findIndex((x) => x.id === t.id); // the playlist's order can lag a move
  const selected = session.selection.trackId === t.id;
  const utility = panUtility(t);
  const utilityGain = Number(utility?.params.gain ?? 0) || 0;
  const [gain, setGain] = useState(utilityGain);
  useEffect(() => setGain(utilityGain), [utilityGain]);
  const previewGain = (v: number) => {
    if (utility) previewParam(t.id, utility.id, 'gain', v);
    else if (engineIndex >= 0) setTrackVolume(engineIndex, dbToGain(t.gainDb + v)); // no Utility yet: on the track volume, until set_utility_gain adds one
  };
  const moveGain = (v: number) => {
    setGain(v);
    previewGain(v); // heard while dragging
  };
  const commitGain = async (v = gain) => {
    if (Math.abs(v - utilityGain) < 0.05) return;
    await run('set_utility_gain', { track_id: t.id, gain_db: v });
    if (!utility && engineIndex >= 0) setTrackVolume(engineIndex, dbToGain(t.gainDb)); // the new Utility carries it from here on
  };

  const pan = Number(utility?.params.pan ?? 0) || 0;
  const previewPan = (v: number) => {
    if (utility) previewParam(t.id, utility.id, 'pan', v);
    else if (engineIndex >= 0) setTrackPan(engineIndex, v); // no Utility yet: the playlist's own panner, until set_pan adds one
  };
  const commitPan = async (v: number) => {
    if (Math.abs(v - pan) < 0.005) return previewPan(pan);
    await run('set_pan', { track_id: t.id, pan: v });
    if (!utility && engineIndex >= 0) setTrackPan(engineIndex, 0); // the new Utility pans from here on
  };

  const color = trackColor(session, index);
  return (
    <div
      className={`strip${selected ? ' selected' : ''}${t.muted ? ' muted' : ''}`}
      data-testid={`strip-${t.id}`}
      style={{ '--track-color': color } as React.CSSProperties}
      onMouseDown={() => !selected && run('select', { track_id: t.id })}
    >
      <PanKnob name={t.name} value={pan} onMove={previewPan} onCommit={commitPan} />
      <div className="strip-readouts">
        <GainField id={t.id} name={t.name} value={gain} onCommit={(v) => { moveGain(v); commitGain(v); }} />
        <button
          className={`strip-peak${levels.held > 0 ? ' over' : ''}`}
          data-testid={`peak-${t.id}`}
          data-peak={Number.isFinite(levels.held) ? levels.held.toFixed(1) : ''}
          title="Highest peak (dBFS) since the last click; red above 0 dB. Click to reset."
          onMouseDown={(e) => e.stopPropagation()}
          onClick={levels.reset}
        >
          {dbText(levels.held)}
        </button>
      </div>
      <div className="strip-fader-area">
        <input
          type="range" className="fader" min={FADER_MIN} max={TOP_DB} step={0.5} value={Math.min(TOP_DB, gain)}
          aria-label={`${t.name} volume`} title="Utility Gain (Alt-click: 0 dB)"
          style={{ height: `${(1 - heightOf(FADER_MIN)) * 100}%` }}
          onChange={(e) => moveGain(Number(e.target.value))}
          onPointerDown={(e) => {
            if (!e.altKey) return;
            e.preventDefault();
            moveGain(0);
            commitGain(0);
          }}
          onPointerUp={() => commitGain()} onKeyUp={() => commitGain()}
        />
        <div className="strip-scale" aria-hidden>
          {SCALE.map((db) => (
            <span key={db} style={{ bottom: `${heightOf(db) * 100}%` }}>{db > 0 ? `+${db}` : db}</span>
          ))}
        </div>
        <div className="meter" aria-hidden data-testid={`meter-${t.id}`} data-level={levels.now.map((v) => (Number.isFinite(v) ? v.toFixed(1) : '-inf')).join(',')}>
          {levels.now.map((v, c) => (
            <div key={c} className="meter-ch">
              <div className="meter-off" style={{ height: `${(1 - heightOf(v)) * 100}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="strip-ms">
        <button className={`ms${t.muted ? ' on mute' : ''}`} title="Mute" aria-label={`Mute ${t.name}`} aria-pressed={t.muted} onClick={() => run('mute', { track_id: t.id, muted: !t.muted })}>M</button>
        <button className={`ms${t.soloed ? ' on solo' : ''}`} title="Solo" aria-label={`Solo ${t.name}`} aria-pressed={t.soloed} onClick={() => run('solo', { track_id: t.id, soloed: !t.soloed })}>S</button>
      </div>
      <div className="strip-name" title={`${t.name} (${t.id})`}>{t.name}</div>
    </div>
  );
}

/** The fader's dB readout; click it to type a gain (Enter or leaving it sets it, Escape cancels). */
function GainField({ id, name, value, onCommit }: { id: string; name: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const closed = useRef(false); // Enter / Escape already closed it; the blur that follows is not a second commit
  const done = (keep: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const v = Number((text ?? '').trim().replace(/\s*dB$/i, '').replace('−', '-'));
    setText(null);
    if (keep && text !== null && text.trim() !== '' && Number.isFinite(v)) onCommit(Math.round(Math.max(FADER_MIN, Math.min(UTILITY_MAX, v)) * 10) / 10);
  };
  if (text === null)
    return (
      <button
        className="strip-db" data-testid={`gain-${id}`} title="Utility Gain (dB). Click to type a value."
        aria-label={`${name} volume value`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          closed.current = false;
          setText(value.toFixed(1));
        }}
      >
        {`${value > 0 ? '+' : ''}${value.toFixed(1)}`}
      </button>
    );
  return (
    <input
      className="strip-db" data-testid={`gain-input-${id}`} aria-label={`${name} volume dB`} autoFocus
      value={text} inputMode="decimal"
      onFocus={(e) => e.target.select()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation(); // typing digits mustn't fire the app's shortcuts
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
      }}
    />
  );
}

/** A rotary pan knob: drag up or down (or arrow keys) to pan, Alt-click or double-click to centre. */
function PanKnob({ name, value, onMove, onCommit }: { name: string; value: number; onMove: (v: number) => void; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setV(value);
  }, [value]);
  const set = (x: number) => {
    const r = Math.round(Math.max(-1, Math.min(1, x)) * 100) / 100;
    setV(r);
    onMove(r);
    return r;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.altKey) return onCommit(set(0));
    const y0 = e.clientY;
    const v0 = v;
    let last = v0;
    dragging.current = true;
    const move = (ev: PointerEvent) => (last = set(v0 + (y0 - ev.clientY) / 100)); // 100 px: centre to hard right
    const up = () => {
      dragging.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const angle = v * 135;
  return (
    <div className="pan">
      <div
        className="pan-knob" role="slider" tabIndex={0}
        aria-label={`${name} pan`} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={v} aria-valuetext={panText(v)}
        title={`Pan: ${panText(v)} (drag; Alt-click or double-click: centre)`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => onCommit(set(0))}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.05 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.05 : 0;
          if (!step) return;
          e.preventDefault();
          e.stopPropagation(); // arrows also move the playhead elsewhere
          onCommit(set(v + step));
        }}
      >
        <div className="pan-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      <span className="pan-text">{Math.abs(v) < 0.005 ? 'C' : `${Math.round(Math.abs(v) * 100)}${v < 0 ? 'L' : 'R'}`}</span>
    </div>
  );
}
