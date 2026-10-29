// [S3 midi] Piano Roll: the selected MIDI region's notes, in the editor area under the board
// (Logic: double-click a MIDI region or press P; BandLab's MIDI Editor). Keys on the left, bars
// on top, one row per semitone. Pointer tool: click selects (Shift adds), drag moves (time snaps
// to the grid, rows change pitch), drag a note's right edge to resize, drag on empty grid to
// select the notes in a rectangle (Shift adds), double-click empty grid to add a note, Delete removes, ↑/↓ transpose (Shift: octave). Pencil tool: click adds.
// As in GarageBand, a strip under the bar numbers shows the region, and the light line inside
// each note is its velocity. Clicking a note or a key plays it on the region's own instrument
// (its sample, the drum kit, or the piano), through the track's effects.
// Each gesture commits once as edit_midi_notes (one undo step, a hand edit Muse sees);
// transpose and quantize use the same tools Muse has.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePlaybackAnimation } from '@waveform-playlist/browser';
import { getGlobalContext } from '@waveform-playlist/playout';
import type { Bridge } from '../core/bridge';
import { barLength, beatLength, type Meter } from '../core/metronome';
import { GRIDS, noteName, type MidiData, type MidiNote } from '../core/midi';
import type { Session } from '../core/session';
import { isTyping } from './shortcuts';
import { ExtractMidiControl } from './ExtractMidi';
import { trackEffects } from '../fx/engine/live';
import { buffers } from './audio';
import { auditionNote, kitSamples } from './midiSynth';
import { padKeyLabel, type Kit } from '../core/kit';
import { trackColor } from './TrackHeader';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const ROW = 12; // px per semitone
const KEYS_W = 52;
const RULER_H = 34; // bar numbers + the region strip (GarageBand)
const BASE_PX_PER_BEAT = 56;
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const BLACK = new Set([1, 3, 6, 8, 10]);
const GM_DRUMS: Record<number, string> = {
  35: 'Kick 2', 36: 'Kick', 37: 'Stick', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Tom L', 42: 'Hat',
  43: 'Tom L2', 44: 'Pedal hat', 45: 'Tom M', 46: 'Open hat', 47: 'Tom M2', 48: 'Tom H', 49: 'Crash', 51: 'Ride',
};
const GRID_OPTIONS = ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T', 'off'];

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const sortKey = (a: MidiNote, b: MidiNote) => a.start - b.start || a.pitch - b.pitch;

/** Round and sort notes the way edit_midi_notes stores them, carrying a selection along. */
function settle(notes: MidiNote[], sel: Set<number>): { notes: MidiNote[]; sel: Set<number> } {
  const tagged = notes
    .map((n, i) => ({ n: { ...n, start: r4(Math.max(0, n.start)), duration: r4(n.duration), velocity: Math.round(n.velocity) }, s: sel.has(i) }))
    .sort((a, b) => sortKey(a.n, b.n));
  return { notes: tagged.map((t) => t.n), sel: new Set(tagged.flatMap((t, i) => (t.s ? [i] : []))) };
}

/** Play one note as the region sounds: its instrument, through its track's device chain. */
function preview(midi: MidiData | undefined, trackId: string | undefined, pitch: number, velocity = 100, kit?: Kit) {
  try {
    const ctx = getGlobalContext().rawContext as unknown as AudioContext;
    if (ctx.state === 'suspended') void ctx.resume();
    const out = ctx.createGain();
    const unroute = trackId ? trackEffects(trackId)(out, ctx.destination, false) : out.connect(ctx.destination);
    auditionNote(ctx, out, midi, pitch, velocity, midi?.sample ? buffers.get(midi.sample.sourceId) : undefined, 0.25, kit && kitSamples(kit).samples);
    setTimeout(() => {
      out.disconnect();
      if (typeof unroute === 'function') unroute();
    }, 1500);
  } catch {
    // no audio context yet: previews are a nicety
  }
}

/** A rubber-band selection on empty grid, in grid pixels. */
interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: Set<number>; // kept selected (Shift)
}

interface Drag {
  kind: 'move' | 'resize';
  x0: number;
  y0: number;
  anchor: number; // index of the grabbed note
  orig: MidiNote[];
  moved: boolean;
}

export function PianoRoll({ session, run, bridge }: { session: Session; run: Run; bridge: Bridge }) {
  const trackIndex = session.tracks.findIndex((t) => t.clips.some((c) => c.id === session.selection.clipId));
  const track = session.tracks[trackIndex];
  const clip = track?.clips.find((c) => c.id === session.selection.clipId);

  const [tool, setTool] = useState<'pointer' | 'pencil'>('pointer');
  const [grid, setGrid] = useState('1/16');
  const [zoom, setZoom] = useState(2);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [draft, setDraft] = useState<MidiNote[] | null>(null);
  const drag = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const { currentTimeRef } = usePlaybackAnimation();
  const [viewW, setViewW] = useState(0); // visible grid width: the bars run on to fill it
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - KEYS_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, [clip?.midi ? 1 : 0]);

  const midi = clip?.midi;
  const notes = draft ?? midi?.notes ?? [];
  const meter: Meter = { tempo: session.tempo, timeSignature: session.timeSignature };
  const beat = beatLength(meter);
  const bar = barLength(meter);
  const pps = (BASE_PX_PER_BEAT * ZOOMS[zoom]) / beat; // px per second
  const step = grid === 'off' ? 0 : (60 / session.tempo) * GRIDS[grid]; // GRIDS are in quarter notes

  // note times are seconds from the clip's source start; the view starts at the bar holding the clip
  const sourceStart = clip ? clip.start - clip.offset : 0;
  const viewStart = clip ? Math.floor(clip.start / bar + 1e-6) * bar : 0;
  const lastT = clip ? Math.max(clip.start + clip.duration, ...notes.map((n) => sourceStart + n.start + n.duration)) + bar : bar;
  const viewEnd = viewStart + Math.ceil(Math.max(lastT - viewStart, viewW / pps) / bar) * bar;
  const width = Math.ceil((viewEnd - viewStart) * pps);
  // B12: a region on a sample pad names its rows after the pads (and shows all of them)
  const kit = midi?.kit ? session.kits?.[midi.kit] : undefined;
  const padOf = (p: number) => kit?.pads.findIndex((x) => x.note === p) ?? -1;
  const rowName = (p: number) => (padOf(p) >= 0 ? kit!.pads[padOf(p)].label : midi?.drum ? GM_DRUMS[p] : undefined);
  const pitches = [...notes.map((n) => n.pitch), ...(kit?.pads.map((p) => p.note) ?? [])];
  const hi = Math.min(127, Math.max(midi?.drum && !kit ? 52 : kit ? 0 : 96, ...pitches.map((p) => p + (kit ? 1 : 4))));
  const lo = Math.max(0, Math.min(midi?.drum && !kit ? 35 : kit ? 127 : 24, ...pitches.map((p) => p - (kit ? 1 : 4))));
  const rows = hi - lo + 1;
  const xOf = (sourceT: number) => (sourceStart + sourceT - viewStart) * pps;
  const snapTl = (tl: number) => (step ? Math.round(tl / step) * step : tl);
  const play = (pitch: number, velocity = 100) => preview(midi, track?.id, pitch, velocity, kit);

  // a new region: clear the selection and bring its notes into view
  const clipId = clip?.id;
  useEffect(() => {
    setSel(new Set());
    setDraft(null);
  }, [clipId]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !midi) return;
    const mid = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
    el.scrollTop = Math.max(0, (hi - mid) * ROW - el.clientHeight / 2 + RULER_H);
    el.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  // playhead (follows playback; otherwise the transport position)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = currentTimeRef.current ?? session.transport.position;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${KEYS_W + (t - viewStart) * pps}px)`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [currentTimeRef, session.transport.position, viewStart, pps]);

  const commit = async (next: MidiNote[], nextSel: Set<number>) => {
    if (!clip) return;
    const s = settle(next, nextSel);
    setDraft(s.notes); // hold the result until the session catches up
    setSel(s.sel);
    await run('edit_midi_notes', { clip_id: clip.id, notes: s.notes });
    setDraft(null);
  };

  const transpose = (semitones: number) => {
    if (!clip || !midi?.notes.length) return;
    const which = sel.size ? [...sel] : undefined;
    run('transpose_midi', { clip_id: clip.id, semitones, ...(which ? { notes: which } : {}) });
  };

  // Delete / arrows / Escape act on the selected notes before the window's region commands
  const latest = useRef({ sel, notes, commit, transpose });
  latest.current = { sel, notes, commit, transpose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { sel: s, notes: ns, commit: c, transpose: tr } = latest.current;
      if (!s.size || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') c(ns.filter((_, i) => !s.has(i)), new Set());
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') tr((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
      else if (e.key === 'Escape') setSel(new Set());
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const gridPoint = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { tl: viewStart + x / pps, pitch: hi - Math.floor(y / ROW) };
  };

  const addNote = (e: React.MouseEvent) => {
    const { tl, pitch } = gridPoint(e);
    if (pitch < 0 || pitch > 127) return;
    const len = step || beat / 4;
    const start = (step ? Math.floor(tl / step) * step : tl) - sourceStart;
    if (start < 0) return;
    const velocity = sel.size ? notes[[...sel][0]].velocity : 100;
    play(pitch, velocity);
    commit([...notes, { pitch, start, duration: len, velocity }], new Set([notes.length]));
  };

  const onNoteDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const resize = (e.target as HTMLElement).classList.contains('pr-note-end');
    let next = sel;
    if (e.shiftKey) {
      next = new Set(sel);
      if (next.has(i)) next.delete(i);
      else next.add(i);
    } else if (!sel.has(i)) next = new Set([i]);
    setSel(next);
    play(notes[i].pitch, notes[i].velocity);
    if (!next.has(i)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: resize ? 'resize' : 'move', x0: e.clientX, y0: e.clientY, anchor: i, orig: notes, moved: false };
  };

  const onNoteMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / pps;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3 && Math.abs(e.clientY - d.y0) < 3) return;
    d.moved = true;
    const a = d.orig[d.anchor];
    if (d.kind === 'move') {
      const tl = sourceStart + a.start;
      const dt = Math.max(-Math.min(...[...sel].map((i) => d.orig[i].start)), snapTl(tl + dx) - tl);
      const dp = -Math.round((e.clientY - d.y0) / ROW);
      const dpOk = [...sel].every((i) => d.orig[i].pitch + dp >= 0 && d.orig[i].pitch + dp <= 127) ? dp : 0;
      setDraft(d.orig.map((n, i) => (sel.has(i) ? { ...n, start: n.start + dt, pitch: n.pitch + dpOk } : n)));
    } else {
      const end = sourceStart + a.start + a.duration;
      const dd = snapTl(end + dx) - end;
      const min = step || 0.02;
      setDraft(d.orig.map((n, i) => (sel.has(i) ? { ...n, duration: Math.max(min, n.duration + dd) } : n)));
    }
  };

  const onNoteUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || !draft) return setDraft(null);
    const a = d.orig[d.anchor];
    const b = draft[d.anchor];
    if (b.pitch !== a.pitch) play(b.pitch, b.velocity);
    commit(draft, sel);
  };

  const setVelocity = (v: number) => setDraft(notes.map((n, i) => (sel.has(i) ? { ...n, velocity: v } : n)));

  if (!clip || !track) {
    return (
      <div className="piano-roll empty" data-testid="piano-roll">
        <p className="hint">Double-click a region to edit its notes (P).</p>
      </div>
    );
  }
  if (!midi) {
    return (
      <div className="piano-roll empty" data-testid="piano-roll">
        <p className="hint">
          <b>{clip.name}</b> is an audio region: no notes to edit. Turn it into MIDI tracks first.
        </p>
        <ExtractMidiControl session={session} bridge={bridge} run={run} />
      </div>
    );
  }

  const color = trackColor(session, trackIndex);
  const selVel = sel.size ? Math.round([...sel].reduce((k, i) => k + notes[i].velocity, 0) / sel.size) : null;
  const beatPx = beat * pps;
  const barPx = bar * pps;
  const bars = Array.from({ length: Math.ceil((viewEnd - viewStart) / bar) }, (_, k) => Math.round((viewStart + k * bar) / bar) + 1);
  const regionL = (clip.start - viewStart) * pps;
  const regionR = (clip.start + clip.duration - viewStart) * pps;

  return (
    <div className="piano-roll" data-testid="piano-roll" style={{ ['--note' as string]: color }}>
      <div className="pr-toolbar" role="toolbar" aria-label="Piano Roll">
        <span className="pr-title" style={{ color }}>{track.name}</span>
        <span className="pr-sub">{clip.name !== track.name ? `${clip.name} · ` : ''}{midi.notes.length} notes{midi.drum ? ' · drums' : ''}</span>
        <div className="seg" role="radiogroup" aria-label="Piano Roll tool">
          <button role="radio" aria-checked={tool === 'pointer'} className={tool === 'pointer' ? 'on' : ''} onClick={() => setTool('pointer')} title="Pointer: select, move, resize">Pointer</button>
          <button role="radio" aria-checked={tool === 'pencil'} className={tool === 'pencil' ? 'on' : ''} onClick={() => setTool('pencil')} title="Pencil: click to add notes">Pencil</button>
        </div>
        <label className="tb-label">
          Grid{' '}
          <select aria-label="Piano Roll grid" value={grid} onChange={(e) => setGrid(e.target.value)}>
            {GRID_OPTIONS.map((g) => (
              <option key={g} value={g}>{g === 'off' ? 'Off' : g}</option>
            ))}
          </select>
        </label>
        <button disabled={grid === 'off' || !midi.notes.length} onClick={() => run('quantize_midi', { clip_id: clip.id, grid })} title="Quantize every note in the region to the grid">
          Quantize
        </button>
        <div className="seg" role="group" aria-label="Transpose">
          {[-12, -1, 1, 12].map((t) => (
            <button key={t} aria-label={`Transpose ${t > 0 ? '+' : ''}${t}`} onClick={() => transpose(t)} title={`${sel.size ? 'Selected notes' : 'All notes'} ${t > 0 ? 'up' : 'down'} ${Math.abs(t) === 12 ? 'an octave' : 'a semitone'}`}>
              {t > 0 ? '+' : ''}{t}
            </button>
          ))}
        </div>
        <label className="tb-label pr-vel" title={sel.size ? 'Velocity of the selected notes' : 'Select notes to set their velocity'}>
          Velocity
          <input
            type="range" min={1} max={127} aria-label="Velocity" disabled={selVel === null} value={selVel ?? 100}
            onChange={(e) => setVelocity(Number(e.target.value))}
            onPointerUp={() => draft && commit(draft, sel)}
            onKeyUp={() => draft && commit(draft, sel)}
          />
          <span className="pr-vel-n">{selVel ?? '–'}</span>
        </label>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Piano Roll zoom">
          <button aria-label="Zoom out notes" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>−</button>
          <button aria-label="Zoom in notes" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
        </div>
      </div>

      <div className="pr-scroll" ref={scrollRef}>
        <div className="pr-canvas" style={{ gridTemplateColumns: `${KEYS_W}px ${width}px`, gridTemplateRows: `${RULER_H}px ${rows * ROW}px` }}>
          <div className="pr-corner" />
          <div
            className="pr-ruler"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const t = viewStart + (e.clientX - r.left) / pps;
              run('go_to', { position: Math.max(0, step ? Math.round(t / step) * step : t) });
            }}
          >
            {bars.map((b, k) => (
              <span key={b} style={{ left: k * barPx }}>{b}</span>
            ))}
            <div className="pr-region" style={{ left: regionL, width: regionR - regionL }} title={clip.name}>{clip.name}</div>
          </div>

          <div className="pr-keys">
            {Array.from({ length: rows }, (_, k) => {
              const p = hi - k;
              const black = BLACK.has(p % 12);
              const pad = padOf(p);
              const label = midi.drum ? rowName(p) : p % 12 === 0 ? noteName(p) : '';
              return (
                <div
                  key={p} className={`pr-key${black ? ' black' : ''}`} style={{ height: ROW }} onPointerDown={() => play(p)}
                  data-pad={pad >= 0 ? pad : undefined}
                  title={pad >= 0 ? `${kit!.pads[pad].label} (pad ${padKeyLabel(pad)}, note ${p})` : midi.drum ? `${p} ${GM_DRUMS[p] ?? ''}` : noteName(p)}
                >
                  {label}
                </div>
              );
            })}
          </div>

          <div
            className={`pr-grid${tool === 'pencil' ? ' pencil' : ''}`}
            data-testid="pr-grid" data-row={ROW}
            style={{
              backgroundImage: [
                `linear-gradient(90deg, var(--line-strong) 1px, transparent 1px)`,
                `linear-gradient(90deg, var(--line) 1px, transparent 1px)`,
                ...(step && step * pps >= 8 ? [`linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)`] : []),
              ].join(','),
              backgroundSize: [`${barPx}px 100%`, `${beatPx}px 100%`, ...(step && step * pps >= 8 ? [`${step * pps}px 100%`] : [])].join(','),
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (tool === 'pencil') return addNote(e);
              const base = e.shiftKey ? new Set(sel) : new Set<number>();
              setSel(base);
              const r = e.currentTarget.getBoundingClientRect();
              e.currentTarget.setPointerCapture(e.pointerId);
              const x = e.clientX - r.left, y = e.clientY - r.top;
              setMarquee({ x0: x, y0: y, x1: x, y1: y, base });
            }}
            onPointerMove={(e) => {
              if (!marquee) return;
              const r = e.currentTarget.getBoundingClientRect();
              const m = { ...marquee, x1: e.clientX - r.left, y1: e.clientY - r.top };
              setMarquee(m);
              const [l, rt] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1)];
              const [t, b] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
              const next = new Set(m.base);
              notes.forEach((n, i) => {
                const nl = xOf(n.start), nr = nl + Math.max(3, n.duration * pps), nt = (hi - n.pitch) * ROW, nb = nt + ROW;
                if (nr >= l && nl <= rt && nb >= t && nt <= b) next.add(i);
              });
              setSel(next);
            }}
            onPointerUp={() => setMarquee(null)}
            onPointerCancel={() => setMarquee(null)}
            onDoubleClick={(e) => tool === 'pointer' && e.target === e.currentTarget && addNote(e)}
          >
            {Array.from({ length: rows }, (_, k) => (BLACK.has((hi - k) % 12) ? <div key={k} className="pr-row-black" style={{ top: k * ROW, height: ROW }} /> : null))}
            <div className="pr-outside" style={{ left: 0, width: Math.max(0, regionL) }} />
            <div className="pr-outside" style={{ left: regionR, right: 0 }} />
            {marquee && (
              <div
                className="pr-marquee" data-testid="pr-marquee"
                style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
              />
            )}
            {notes.map((n, i) => (
              <div
                key={i}
                data-testid="pr-note"
                className={`pr-note${sel.has(i) ? ' sel' : ''}`}
                title={`${midi.drum ? rowName(n.pitch) ?? n.pitch : noteName(n.pitch)} · velocity ${n.velocity}`}
                style={{
                  left: xOf(n.start), top: (hi - n.pitch) * ROW + 1, width: Math.max(3, n.duration * pps - 1), height: ROW - 2,
                }}
                onPointerDown={(e) => onNoteDown(e, i)}
                onPointerMove={onNoteMove}
                onPointerUp={onNoteUp}
                onPointerCancel={() => ((drag.current = null), setDraft(null))}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <span className="pr-vel-line" style={{ width: `${Math.round((n.velocity / 127) * 85)}%` }} />
                <span className="pr-note-end" />
              </div>
            ))}
          </div>
          <div className="pr-playhead" ref={playheadRef} style={{ height: RULER_H + rows * ROW }} />
        </div>
      </div>
    </div>
  );
}

