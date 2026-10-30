// Musical Typing (Logic's Cmd-K window): while on, the letter keys play notes live (note-on at
// keydown, note-off at keyup) and a small on-screen keyboard lights the keys. The instrument is
// a sound being tried out from the Ideas column (one not on a track yet: click its card), else
// the selected audio clip played as a sampler (A = its original pitch), else the piano voice.
// Recording with a tried-out sound and no track selected puts the take on a new track.
// Key map and octave/velocity rules: core/musicalTyping.ts.
// B12: with a sample pad (kit) as the instrument, the window shows the kit's 3x3 pads instead of
// the piano: Q W E / A S D / Z X C hit them (fixed velocity), and any sound dropped on a pad (an
// Ideas card, a library item, audio files from the Finder) goes on it. Double-click a pad to
// rename it. A kit is played from its Ideas card or a clip recorded on it.
//
// Every note goes through `musicalTyping.onNote`, with transport times, so a MIDI recorder can
// subscribe to the same stream the sound comes from.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { usePlaybackAnimation } from '@waveform-playlist/browser';
import { getGlobalContext } from '@waveform-playlist/playout';
import {
  DEFAULT_BASE,
  DEFAULT_VELOCITY,
  KEY_LABELS,
  keyAction,
  pitchAt,
  rangeLabel,
  shiftOctave,
  stepVelocity,
  SAMPLE_ROOT,
  typingInstrument,
  type TypingInstrument,
  type TypingSample,
  typingKit,
} from '../core/musicalTyping';
import { PAD_VELOCITY, padForKey, padKeyLabel, type Kit } from '../core/kit';
import { noteName } from '../core/midi';
import type { Session } from '../core/session';
import { trackEffects } from '../fx/engine/live';
import { buffers } from './audio';
import { IDEA_MIME, LIBRARY_MIME } from './libraryAudio';
import { StarButton } from './Shelves'; // B17: star a pad's sound
import { kitSamples, padHit, pianoVoice, sampleVoice, type KitSamples, type Voice } from './midiSynth';
import { isTyping, setMusicalTypingKeys } from './shortcuts';
import './MusicalTyping.css';

/** time = transport seconds (the playhead) when the key went down / up. */
export interface NoteEvent {
  type: 'on' | 'off';
  pitch: number;
  velocity: number;
  time: number;
}

// ─── audio: one bus on the playlist's context, through the selected track's effects ───

const audioContext = () => getGlobalContext().rawContext as unknown as AudioContext;

class LiveKeys {
  private bus: GainNode | null = null;
  private end: DynamicsCompressorNode | null = null;
  private unroute: (() => void) | void = undefined;
  private trackId: string | null | undefined = undefined;

  private out(): AudioNode {
    if (this.bus) return this.bus;
    const ctx = audioContext();
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.8;
    this.end = ctx.createDynamicsCompressor(); // keeps chords from clipping (as renderMidi)
    this.end.threshold.value = -12;
    this.bus.connect(this.end);
    this.route(this.trackId ?? null, true);
    return this.bus;
  }

  /** Play through this track's device chain (null: straight to the output). */
  route(trackId: string | null, force = false) {
    if (trackId === this.trackId && !force) return;
    this.trackId = trackId;
    if (!this.end) return; // routed when the first note builds the bus
    this.end.disconnect();
    this.unroute?.();
    const dest = audioContext().destination;
    if (trackId) this.unroute = trackEffects(trackId)(this.end, dest, false);
    else this.end.connect(dest);
  }

  /** A note on the piano, or on `inst` (a sampler) when given. */
  play(pitch: number, velocity: number, inst: LiveInstrument | null): Voice {
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (inst) return sampleVoice(ctx, this.out(), inst.buffer, inst.sample, pitch, velocity, ctx.currentTime);
    return pianoVoice(ctx, this.out(), pitch, velocity, ctx.currentTime);
  }

  /** B12: a drum pad hit (its sound once through, or the built-in drum on an empty pad). */
  hit(pitch: number, velocity: number, kit: KitSamples): Voice {
    const ctx = audioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return padHit(ctx, this.out(), kit, pitch, velocity, ctx.currentTime);
  }
}

/** B12: a kit whose loaded pad sounds are ready to play. */
interface LiveKit {
  id: string;
  name: string;
  notes: number[]; // per pad
  samples: KitSamples;
}

// ─── state shared by the button, the keyboard and the key handler ───

/** A sampler whose audio is loaded. */
export interface LiveInstrument extends TypingSample {
  buffer: AudioBuffer;
}
interface Snapshot {
  on: boolean;
  instrument: string; // "Piano" or the sampled clip's name
  base: number;
  velocity: number;
  sustain: boolean;
  active: number[]; // sounding pitches
  audition: string | null; // source id tried out from the Ideas column (overrides the selection)
  kitTry: string | null; // B12: kit id played from its Ideas card (overrides the selection)
  kit: string | null; // B12: the kit being played now (tried, or the selected clip's), else null
}
declare global {
  interface Window {
    __musicalTypingLog?: NoteEvent[]; // set by e2e tests to see note events
  }
}

class MusicalTypingStore {
  private snap: Snapshot = { on: false, instrument: 'Piano', base: DEFAULT_BASE, velocity: DEFAULT_VELOCITY, sustain: false, active: [], audition: null, kitTry: null, kit: null };
  private listeners = new Set<() => void>();
  private noteListeners = new Set<(e: NoteEvent) => void>();
  private held = new Map<string, number>(); // key code (or "pointer") -> pitch
  private sounding = new Map<number, { voice: Voice; velocity: number }>();
  readonly keys = new LiveKeys();
  private inst: LiveInstrument | null = null;
  private liveKit: LiveKit | null = null;
  /** Transport position now; set by the mounted keyboard from usePlaybackAnimation. */
  clock: () => number = () => 0;

  get = () => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  /** Subscribe to note-on/off (e.g. a MIDI recorder). Returns the unsubscribe function. */
  onNote(fn: (e: NoteEvent) => void) {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch, active: [...this.sounding.keys()].sort((a, b) => a - b) };
    for (const fn of this.listeners) fn();
  }
  private emit(e: NoteEvent) {
    window.__musicalTypingLog?.push(e);
    for (const fn of this.noteListeners) fn(e);
  }

  /** Play the piano (null) or a loaded sample. Set by the mounted keyboard from the selection. */
  setInstrument(inst: LiveInstrument | null) {
    const same = inst === this.inst || (inst && this.inst && inst.buffer === this.inst.buffer && inst.name === this.inst.name &&
      JSON.stringify(inst.sample) === JSON.stringify(this.inst.sample));
    if (same) return;
    this.inst = inst;
    if (!this.liveKit) this.set({ instrument: inst?.name ?? 'Piano' });
  }
  /** B12: play a kit (null: back to the piano or sampler). Set by the mounted keyboard. */
  setKit(kit: LiveKit | null) {
    const k = this.liveKit;
    if (kit === k || (kit && k && kit.id === k.id && kit.name === k.name && kit.samples === k.samples)) return;
    if (!kit || kit.id !== k?.id) this.releaseAll();
    this.liveKit = kit;
    this.set({ kit: kit?.id ?? null, instrument: kit?.name ?? this.inst?.name ?? 'Piano' });
  }
  /** What notes play on right now (null: the piano); a MIDI take records it. */
  instrument(): TypingInstrument | null {
    if (this.liveKit) return { kit: this.liveKit.id, name: this.liveKit.name };
    return this.inst && { name: this.inst.name, sample: this.inst.sample };
  }

  /** Try out a sound from the Ideas column (null: back to the selection's instrument). */
  audition = (sourceId: string | null) => {
    if (sourceId !== this.snap.audition) this.set({ audition: sourceId, ...(sourceId ? { kitTry: null } : {}) });
  };
  /** B12: play a kit from its Ideas card (null: back to the selection's instrument). */
  tryKit = (kitId: string | null) => {
    if (kitId !== this.snap.kitTry) this.set({ kitTry: kitId, ...(kitId ? { audition: null } : {}) });
  };

  toggle = (on = !this.snap.on) => {
    if (!on) this.releaseAll();
    setMusicalTypingKeys(on);
    this.set({ on });
  };
  octave = (delta: number) => this.set({ base: shiftOctave(this.snap.base, delta) });
  velocityStep = (delta: number) => this.set({ velocity: stepVelocity(this.snap.velocity, delta) });

  noteOn(holder: string, offset: number) {
    const pitch = pitchAt(this.snap.base, offset);
    if (pitch == null || this.held.has(holder)) return;
    this.held.set(holder, pitch);
    if (this.sounding.has(pitch)) this.stop(pitch); // re-strike (sustained, or held by another holder)
    const velocity = this.snap.velocity;
    this.sounding.set(pitch, { voice: this.keys.play(pitch, velocity, this.inst), velocity });
    this.emit({ type: 'on', pitch, velocity, time: this.clock() });
    this.set({});
  }
  /** B12: hit pad `index` of the kit being played. */
  padOn(holder: string, index: number) {
    const k = this.liveKit;
    const pitch = k?.notes[index];
    if (!k || pitch == null || this.held.has(holder)) return;
    this.held.set(holder, pitch);
    if (this.sounding.has(pitch)) this.stop(pitch);
    this.sounding.set(pitch, { voice: this.keys.hit(pitch, PAD_VELOCITY, k.samples), velocity: PAD_VELOCITY });
    this.emit({ type: 'on', pitch, velocity: PAD_VELOCITY, time: this.clock() });
    this.set({});
  }
  noteOff(holder: string) {
    const pitch = this.held.get(holder);
    if (pitch == null) return;
    this.held.delete(holder);
    if (this.snap.sustain || [...this.held.values()].includes(pitch)) return;
    this.stop(pitch);
    this.set({});
  }
  setSustain(sustain: boolean) {
    if (sustain === this.snap.sustain) return;
    if (!sustain) {
      const keep = new Set(this.held.values());
      for (const p of [...this.sounding.keys()]) if (!keep.has(p)) this.stop(p);
    }
    this.set({ sustain });
  }
  releaseAll() {
    this.held.clear();
    for (const p of [...this.sounding.keys()]) this.stop(p);
    this.set({ sustain: false });
  }
  private stop(pitch: number) {
    const v = this.sounding.get(pitch);
    if (!v) return;
    this.sounding.delete(pitch);
    v.voice.release(audioContext().currentTime);
    this.emit({ type: 'off', pitch, velocity: v.velocity, time: this.clock() });
  }
}

export const musicalTyping = new MusicalTypingStore();

const useMusicalTyping = () => useSyncExternalStore(musicalTyping.subscribe, musicalTyping.get);

// ─── UI ───

/** On/off toggle (⌘K); place it in any toolbar. */
export function MusicalTypingButton({ className = '', children = '⌨ Keys' }: { className?: string; children?: ReactNode }) {
  const { on } = useMusicalTyping();
  return (
    <button className={[className, on && 'on'].filter(Boolean).join(' ')} aria-pressed={on} aria-label="Musical Typing" title="Musical Typing: play notes with the letter keys (⌘K)" onClick={() => musicalTyping.toggle()}>
      {children}
    </button>
  );
}

const WHITE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17];

// The keyboard window can be dragged by its title bar (Logic's Musical Typing is a floating
// window); where it was left is remembered. Double-click the title bar to put it back.
const POS_KEY = 'lattice.musicalTypingPos';
type Pos = { x: number; y: number };
function loadPos(): Pos | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null');
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch {
    return null;
  }
}
function savePos(p: Pos | null) {
  try {
    if (p) localStorage.setItem(POS_KEY, JSON.stringify(p));
    else localStorage.removeItem(POS_KEY);
  } catch {
    // not remembered
  }
}
/** Keep at least the title bar on screen. */
const clampPos = (p: Pos, w: number): Pos => ({
  x: Math.min(Math.max(p.x, 8 - w + 80), window.innerWidth - 80),
  y: Math.min(Math.max(p.y, 8), window.innerHeight - 40),
});
const BLACK = [1, 3, 6, 8, 10, 13, 15];

/** The key handler plus the floating keyboard (shown while on). Mount once, inside the
 *  playlist provider. Notes play through the selected track's effects. */
type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

export function MusicalTypingKeyboard({ session, run, onLibraryToPad, onFilesToPad }: {
  session: Session;
  run: Run;
  /** B12: a library sound dropped on a pad (App loads it into the session first) */
  onLibraryToPad: (libraryId: string, kitId: string, pad: number) => void;
  /** B12: audio files dropped on a pad: the first goes on it, the rest on the pads after it */
  onFilesToPad: (files: File[], kitId: string, pad: number) => void;
}) {
  const s = useMusicalTyping();
  const { currentTimeRef } = usePlaybackAnimation();
  musicalTyping.clock = () => currentTimeRef.current ?? 0;
  // a tried-out idea plays dry unless a track is selected (it is on none yet)
  const trackId = session.selection.trackId ?? (s.audition || s.kitTry ? null : session.tracks[0]?.id ?? null);
  useEffect(() => musicalTyping.keys.route(trackId), [trackId]);
  // selecting a clip (or deleting the sound or kit) ends the try-out
  const selClip = session.selection.clipId;
  useEffect(() => {
    if (!selClip) return;
    musicalTyping.audition(null);
    musicalTyping.tryKit(null);
  }, [selClip]);
  const tried = s.audition ? session.sources[s.audition] : undefined;
  useEffect(() => {
    if (musicalTyping.get().audition && !tried) musicalTyping.audition(null);
  }, [tried]);
  // B12: the kit: one tried from Ideas, else the selected clip's (unless a sound is tried out)
  const triedKit = s.kitTry ? session.kits?.[s.kitTry] : undefined;
  useEffect(() => {
    if (musicalTyping.get().kitTry && !triedKit) musicalTyping.tryKit(null);
  }, [triedKit]);
  const kit: Kit | undefined = triedKit ?? (tried ? undefined : session.kits?.[typingKit(session) ?? '']);
  const [pos, setPos] = useState<Pos | null>(loadPos);
  const boxRef = useRef<HTMLElement>(null);
  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    let last: Pos = { x: r.left, y: r.top };
    const move = (ev: PointerEvent) => setPos((last = clampPos({ x: ev.clientX - dx, y: ev.clientY - dy }, r.width)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      savePos(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  // the instrument: the selected audio clip as a sampler once its audio is loaded, else the piano
  const [loads, setLoads] = useState(0);
  useEffect(() => buffers.subscribe(() => setLoads((n) => n + 1)), []);
  const wanted: TypingSample | null = tried
    ? { name: tried.name, sample: { sourceId: tried.id, offset: 0, duration: tried.duration, root: SAMPLE_ROOT } }
    : typingInstrument(session);
  const sampleBuffer = wanted ? buffers.get(wanted.sample.sourceId) : undefined;
  useEffect(() => {
    musicalTyping.setInstrument(wanted && sampleBuffer ? { ...wanted, buffer: sampleBuffer } : null);
  }, [wanted?.name, wanted?.sample.sourceId, wanted?.sample.offset, wanted?.sample.duration, wanted?.sample.root, sampleBuffer, loads]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!kit) return musicalTyping.setKit(null);
    musicalTyping.setKit({ id: kit.id, name: kit.name, notes: kit.pads.map((p) => p.note), samples: kitSamples(kit).samples });
  }, [kit, loads]);
  useEffect(() => () => musicalTyping.setKit(null), []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!musicalTyping.get().on || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (musicalTyping.get().kit) {
        // B12: the pad keys hit pads; the piano's other keys do nothing (letters stay claimed)
        const pad = padForKey(e.code);
        if (pad < 0) return;
        e.preventDefault();
        if (!e.repeat) musicalTyping.padOn(e.code, pad);
        return;
      }
      const a = keyAction(e.code);
      if (!a) return;
      e.preventDefault(); // Tab would move focus
      if (e.repeat) return;
      if (a.type === 'note') musicalTyping.noteOn(e.code, a.offset);
      else if (a.type === 'octave') musicalTyping.octave(a.delta);
      else if (a.type === 'velocity') musicalTyping.velocityStep(a.delta);
      else musicalTyping.setSustain(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Tab') musicalTyping.setSustain(false);
      else musicalTyping.noteOff(e.code);
    };
    const blur = () => musicalTyping.releaseAll();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
      musicalTyping.releaseAll();
    };
  }, []);

  if (!s.on) return null;
  const key = (off: number, black: boolean) => {
    const pitch = s.base + off;
    const active = s.active.includes(pitch);
    return (
      <div
        key={off}
        className={`mt-key ${black ? 'black' : 'white'}`}
        style={black ? { left: `calc(${(WHITE.indexOf(off - 1) + 1) * (100 / WHITE.length)}% - 11px)` } : undefined}
        data-key={KEY_LABELS[off]}
        data-pitch={pitch}
        data-active={active}
        title={noteName(pitch)}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          musicalTyping.noteOn('pointer', off);
        }}
        onPointerUp={() => musicalTyping.noteOff('pointer')}
        onPointerCancel={() => musicalTyping.noteOff('pointer')}
      >
        <span>{KEY_LABELS[off]}</span>
      </div>
    );
  };
  return (
    <section
      ref={boxRef}
      className={`musical-typing${pos ? ' moved' : ''}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      data-testid="musical-typing" data-voices={s.active.length} data-instrument={s.instrument} data-kit={kit?.id} aria-label="Musical Typing"
    >
      <header
        onPointerDown={onTitleDown}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && (setPos(null), savePos(null))}
        title="Drag to move; double-click to put it back"
      >
        <strong>{kit ? 'Sample Pad' : 'Musical Typing'}</strong>
        <span
          className="mt-info mt-instrument"
          data-testid="mt-instrument"
          title={s.instrument === 'Piano' ? 'Piano (select an audio clip, or click a sound in Ideas, to play it as a sampler)' : `Sampler: "${s.instrument}" (A plays it at its own pitch)`}
        >
          {s.instrument}
        </span>
        {kit ? (
          <>
            <span className="mt-info" title="Pads play at a fixed velocity for now">vel <b>{PAD_VELOCITY}</b></span>
            {s.kitTry && (
              <button className="mt-mode" title="Back to the piano keyboard" onClick={() => musicalTyping.tryKit(null)}>Keys</button>
            )}
          </>
        ) : (
          <>
            <span className="mt-info" title="Z / X: octave down / up">
              <kbd>Z</kbd> {rangeLabel(s.base)} <kbd>X</kbd>
            </span>
            <span className="mt-info" title="C / V: velocity down / up">
              <kbd>C</kbd> vel <b data-testid="mt-velocity">{s.velocity}</b> <kbd>V</kbd>
            </span>
            <span className={`mt-info${s.sustain ? ' on' : ''}`} title="Hold Tab to sustain">
              <kbd>⇥</kbd> sustain
            </span>
            <button className="mt-mode" data-testid="mt-drum-pad" title="Play a sample pad: any sounds on Q W E / A S D / Z X C" onClick={() => openDrumPad(session, run)}>
              Pads
            </button>
          </>
        )}
        <button className="mt-close" aria-label="Close Musical Typing" title="Close (⌘K)" onClick={() => musicalTyping.toggle(false)}>×</button>
      </header>
      {kit ? (
        <KitPads kit={kit} session={session} active={s.active} run={run} onLibraryToPad={onLibraryToPad} onFilesToPad={onFilesToPad} />
      ) : (
        <div className="mt-keys">
          {WHITE.map((o) => key(o, false))}
          {BLACK.map((o) => key(o, true))}
        </div>
      )}
    </section>
  );
}

/** B12: play a kit on the keyboard window: the given one, else the newest, else a new one. */
export async function openDrumPad(session: Session, run: Run, kitId?: string) {
  let id = kitId ?? Object.keys(session.kits ?? {}).pop();
  if (!id) {
    const r = await run('create_kit', {});
    if (!r.ok) return;
    id = r.result.kit_id as string;
  }
  musicalTyping.tryKit(id);
  musicalTyping.toggle(true);
  if (session.selection.trackId || session.selection.clipId) run('select', {}); // a take then goes on a new track
}

/** B12: the kit's 3x3 pads. Click or press a pad's key to hit it; drop a sound (an Ideas card, a
 *  library item or audio files) on a pad to put it there; × takes it off; double-click it to
 *  rename it. */
function KitPads({ kit, session, active, run, onLibraryToPad, onFilesToPad }: {
  kit: Kit;
  session: Session;
  active: number[];
  run: Run;
  onLibraryToPad: (libraryId: string, kitId: string, pad: number) => void;
  onFilesToPad: (files: File[], kitId: string, pad: number) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const accepts = (e: React.DragEvent) => ['Files', IDEA_MIME, LIBRARY_MIME].some((t) => e.dataTransfer.types.includes(t));
  const rename = (i: number, label: string) => {
    setRenaming(null);
    if (label.trim() && label.trim() !== kit.pads[i].label) run('rename_pad', { kit_id: kit.id, pad: i, label });
  };
  return (
    <div className="mt-pads" data-testid="kit-pads">
      {kit.pads.map((p, i) => {
        const src = p.sample ? session.sources[p.sample.sourceId] : undefined;
        return (
          <div
            key={i}
            className={`mt-pad${src ? '' : ' vacant'}${over === i ? ' drop' : ''}`}
            data-pad={i}
            data-key={padKeyLabel(i)}
            data-active={active.includes(p.note)}
            data-source={src?.id}
            title={`${p.label} (${padKeyLabel(i)}): ${src ? src.name : 'empty, plays the built-in drum'}. Drop any sound here to put it on this pad; double-click to rename it.`}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button, input')) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              musicalTyping.padOn('pointer', i);
            }}
            onPointerUp={() => musicalTyping.noteOff('pointer')}
            onDoubleClick={(e) => !(e.target as HTMLElement).closest('button, input') && setRenaming(i)} // the pad holds the pointer, so the whole pad
            onPointerCancel={() => musicalTyping.noteOff('pointer')}
            onDragOver={(e) => {
              if (!accepts(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setOver(i);
            }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => {
              setOver(null);
              const idea = e.dataTransfer.getData(IDEA_MIME);
              const lib = e.dataTransfer.getData(LIBRARY_MIME);
              const files = [...e.dataTransfer.files];
              if (!idea && !lib && !files.length) return;
              e.preventDefault();
              e.stopPropagation(); // not onto the arrangement as well
              if (idea) run('set_pad', { kit_id: kit.id, pad: i, source_id: idea });
              else if (lib) onLibraryToPad(lib, kit.id, i);
              else onFilesToPad(files, kit.id, i);
            }}
          >
            {renaming === i ? (
              <input
                className="mt-pad-rename"
                data-testid="pad-rename"
                aria-label={`Rename pad ${padKeyLabel(i)}`}
                defaultValue={p.label}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  e.stopPropagation(); // typing a name doesn't hit pads
                  if (e.key === 'Enter') rename(i, e.currentTarget.value);
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={(e) => renaming === i && rename(i, e.currentTarget.value)}
              />
            ) : (
              <span className="mt-pad-label">{p.label}</span>
            )}
            <kbd>{padKeyLabel(i)}</kbd>
            <span className="mt-pad-sound">{over === i ? 'Release to assign' : src ? (src.name === p.label ? `${src.duration.toFixed(1)} s` : src.name) : 'Drop any sound'}</span>
            {src && <StarButton run={run} args={{ kit_id: kit.id, pad: i }} sourceId={src.id} name={p.label} />}
            {src && (
              <button className="mt-pad-clear" aria-label={`Clear ${p.label}`} title="Take the sound off this pad" onClick={() => run('clear_pad', { kit_id: kit.id, pad: i })}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
