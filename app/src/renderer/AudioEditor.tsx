// Audio editor: the selected audio region up close, in the editor area under the board
// (GarageBand's audio editor, Logic's Audio Track Editor; double-click a region or press P).
// The whole recording is drawn on the bar grid, dimmed outside the region, so you can see
// what a trim would bring back. Drag the region's edges to trim, drag its body to move it
// (both snap to the grid; hold Option to move freely), and click or drag in the ruler to
// scrub: short grains of the audio play under the pointer and the playhead lands where you
// let go. Each gesture commits once as trim_clip / move_clip (one undo step, a hand edit
// Muse sees).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePlaybackAnimation } from '@waveform-playlist/browser';
import { getGlobalContext } from '@waveform-playlist/playout';
import type { Bridge } from '../core/bridge';
import { barLength, beatLength, type Meter } from '../core/metronome';
import { GRIDS } from '../core/midi';
import type { Session } from '../core/session';
import { buffers } from './audio';
import { ExtractMidiControl } from './ExtractMidi';
import { trackColor } from './TrackHeader';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const RULER_H = 22;
const BASE_PX_PER_BEAT = 56;
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const GRID_OPTIONS = ['1/4', '1/8', '1/16', '1/32', '1/8T', '1/16T', 'off'];
const MIN_LEN = 0.02; // s: the shortest a trim leaves a region
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The region while a drag is in progress (timeline seconds, like Clip). */
interface Box {
  start: number;
  offset: number;
  duration: number;
}

interface Drag {
  kind: 'move' | 'trim-l' | 'trim-r';
  x0: number;
  orig: Box;
  moved: boolean;
}

/** Play ~70 ms of `b` from `at` seconds: what you hear while scrubbing. */
function grain(b: AudioBuffer, at: number) {
  try {
    const ctx = getGlobalContext().rawContext as unknown as AudioContext;
    if (ctx.state === 'suspended') void ctx.resume();
    if (at < 0 || at >= b.duration) return;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + 0.07);
    src.buffer = b;
    src.connect(g).connect(ctx.destination);
    src.start(t, at, 0.075);
  } catch {
    // no audio context yet: scrub audio is a nicety
  }
}

export function AudioEditor({ session, run, bridge }: { session: Session; run: Run; bridge: Bridge }) {
  const trackIndex = session.tracks.findIndex((t) => t.clips.some((c) => c.id === session.selection.clipId));
  const track = session.tracks[trackIndex];
  const clip = track?.clips.find((c) => c.id === session.selection.clipId);

  const [grid, setGrid] = useState('1/16');
  const [zoom, setZoom] = useState(4);
  const [draft, setDraft] = useState<Box | null>(null);
  const [scrollX, setScrollX] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 }); // visible lane size
  const [, setLoads] = useState(0);
  const drag = useRef<Drag | null>(null);
  const scrub = useRef<{ t: number; last: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const { currentTimeRef } = usePlaybackAnimation();
  useEffect(() => buffers.subscribe(() => setLoads((n) => n + 1)), []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const lane = laneRef.current;
    if (!el || !lane) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: lane.clientHeight }));
    ro.observe(el);
    ro.observe(lane);
    return () => ro.disconnect();
  }, [clip ? 1 : 0]);

  const buffer = clip ? buffers.get(clip.sourceId) : undefined;
  const box: Box | null = draft ?? (clip ? { start: clip.start, offset: clip.offset, duration: clip.duration } : null);
  const srcDur = clip ? session.sources[clip.sourceId]?.duration ?? buffer?.duration ?? clip.offset + clip.duration : 0;
  const meter: Meter = { tempo: session.tempo, timeSignature: session.timeSignature };
  const beat = beatLength(meter);
  const bar = barLength(meter);
  const pps = (BASE_PX_PER_BEAT * ZOOMS[zoom]) / beat; // px per second
  const step = grid === 'off' ? 0 : (60 / session.tempo) * GRIDS[grid]; // GRIDS are in quarter notes

  // the view runs from the bar holding the recording's start to a bar past its end, and on to fill the panel
  const sourceStart = box ? box.start - box.offset : 0; // where source time 0 sits on the timeline
  const committedSourceStart = clip ? clip.start - clip.offset : 0;
  const viewStart = Math.floor(Math.max(0, Math.min(committedSourceStart, clip?.start ?? 0)) / bar + 1e-6) * bar;
  const lastT = Math.max(committedSourceStart + srcDur, sourceStart + srcDur, box ? box.start + box.duration : 0) + bar;
  const viewEnd = viewStart + Math.ceil(Math.max(lastT - viewStart, size.w / pps) / bar) * bar;
  const width = Math.ceil((viewEnd - viewStart) * pps);
  const xOf = (tl: number) => (tl - viewStart) * pps;
  const color = trackColor(Math.max(0, trackIndex));

  // a new region: drop any draft and scroll it into view
  const clipId = clip?.id;
  useEffect(() => setDraft(null), [clipId]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && clip) el.scrollLeft = Math.max(0, xOf(clip.start) - 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  // waveform: drawn for the visible slice only (a whole long take at close zoom would be wider than a canvas can be)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(size.w, width));
    const h = Math.max(1, size.h);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!buffer) return;
    const data = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
    const sr = buffer.sampleRate;
    const mid = h / 2;
    const amp = (h / 2) * 0.92;
    const inA = box.offset;
    const inB = box.offset + box.duration;
    for (let x = 0; x < w; x++) {
      const st = viewStart + (scrollX + x) / pps - sourceStart; // source seconds under this column
      const st2 = st + 1 / pps;
      if (st2 <= 0 || st >= buffer.duration) continue;
      const i0 = Math.max(0, Math.floor(st * sr));
      const i1 = Math.min(buffer.length, Math.max(i0 + 1, Math.ceil(st2 * sr)));
      let lo = 0;
      let hi = 0;
      const stride = Math.max(1, Math.floor((i1 - i0) / 256));
      for (const d of data) {
        for (let i = i0; i < i1; i += stride) {
          const v = d[i];
          if (v < lo) lo = v;
          else if (v > hi) hi = v;
        }
      }
      const inside = st + 0.5 / pps >= inA && st + 0.5 / pps <= inB;
      g.fillStyle = inside ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.28)';
      const y0 = mid - hi * amp;
      g.fillRect(x, y0, 1, Math.max(1, mid - lo * amp - y0));
    }
  }, [buffer, box?.start, box?.offset, box?.duration, scrollX, size.w, size.h, pps, viewStart, width, sourceStart]);

  // playhead: the scrub point while scrubbing, else playback, else the transport position
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = scrub.current?.t ?? currentTimeRef.current ?? session.transport.position;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${(t - viewStart) * pps}px)`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [currentTimeRef, session.transport.position, viewStart, pps]);

  if (!clip || !track || !box) {
    return (
      <div className="audio-editor empty" data-testid="audio-editor">
        <p className="hint">Double-click a region to edit it (P).</p>
      </div>
    );
  }

  const timeAt = (clientX: number) => {
    const r = laneRef.current!.getBoundingClientRect();
    return viewStart + (clientX - r.left) / pps;
  };
  const snap = (t: number, free: boolean) => (step && !free ? Math.round(t / step) * step : t);

  // ---- scrub (ruler, or the lane outside the region) ----
  const scrubTo = (clientX: number) => {
    const t = Math.max(0, timeAt(clientX));
    const now = performance.now();
    const s = scrub.current;
    if (s) s.t = t;
    if (buffer && (!s || now - s.last > 45)) {
      grain(buffer, t - (clip.start - clip.offset));
      if (s) s.last = now;
    }
  };
  const onScrubDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrub.current = { t: 0, last: 0 };
    scrubTo(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent) => scrub.current && scrubTo(e.clientX);
  const onScrubUp = () => {
    const s = scrub.current;
    scrub.current = null;
    if (s) run('go_to', { position: r3(s.t) });
  };

  // ---- trim and move (the region) ----
  const onRegionDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const cls = (e.target as HTMLElement).classList;
    const kind = cls.contains('l') ? 'trim-l' : cls.contains('r') ? 'trim-r' : 'move';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x0: e.clientX, orig: { start: clip.start, offset: clip.offset, duration: clip.duration }, moved: false };
  };
  const onRegionMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const dt = (e.clientX - d.x0) / pps;
    const o = d.orig;
    const ss = o.start - o.offset; // the recording doesn't move while trimming
    if (d.kind === 'move') {
      const start = Math.max(0, snap(o.start + dt, e.altKey));
      setDraft({ ...o, start });
    } else if (d.kind === 'trim-l') {
      const end = o.start + o.duration;
      const start = Math.min(end - MIN_LEN, Math.max(ss, 0, snap(o.start + dt, e.altKey)));
      setDraft({ start, offset: start - ss, duration: end - start });
    } else {
      const end = Math.max(o.start + MIN_LEN, Math.min(ss + srcDur, snap(o.start + o.duration + dt, e.altKey)));
      setDraft({ ...o, duration: end - o.start });
    }
  };
  const onRegionUp = async () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || !draft) return setDraft(null);
    const b = draft;
    if (d.kind === 'move') {
      if (Math.abs(b.start - d.orig.start) > 1e-4) await run('move_clip', { clip_id: clip.id, start: r3(b.start) });
    } else {
      await run('trim_clip', { clip_id: clip.id, start: r3(b.start), end: r3(b.start + b.duration) });
    }
    setDraft(null);
  };

  const snapStart = () => {
    if (!step) return;
    const s = Math.max(0, Math.round(clip.start / step) * step);
    if (Math.abs(s - clip.start) > 1e-4) run('move_clip', { clip_id: clip.id, start: r3(s) });
  };

  const beatPx = beat * pps;
  const barPx = bar * pps;
  const bars = Array.from({ length: Math.ceil((viewEnd - viewStart) / bar) }, (_, k) => Math.round((viewStart + k * bar) / bar) + 1);
  const regionL = xOf(box.start);
  const regionW = box.duration * pps;
  const recL = xOf(sourceStart);
  const recW = srcDur * pps;
  const showSteps = step && step * pps >= 8;

  return (
    <div className="audio-editor" data-testid="audio-editor" style={{ ['--note' as string]: color }}>
      <div className="pr-toolbar" role="toolbar" aria-label="Audio editor">
        <span className="pr-title" style={{ color }}>{track.name}</span>
        <span className="pr-sub">{clip.name !== track.name ? `${clip.name} · ` : ''}{box.duration.toFixed(2)} s{buffer ? '' : ' · no audio loaded'}</span>
        <label className="tb-label">
          Grid{' '}
          <select aria-label="Audio editor grid" value={grid} onChange={(e) => setGrid(e.target.value)}>
            {GRID_OPTIONS.map((g) => (
              <option key={g} value={g}>{g === 'off' ? 'Off' : g}</option>
            ))}
          </select>
        </label>
        <button disabled={!step} onClick={snapStart} title="Move the region so its start sits on the nearest grid line">Snap start to grid</button>
        <ExtractMidiControl session={session} bridge={bridge} run={run} />
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Audio editor zoom">
          <button aria-label="Zoom out audio" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>−</button>
          <button aria-label="Zoom in audio" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
        </div>
      </div>

      <div className="ae-scroll" ref={scrollRef} onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
        <div className="ae-canvas" style={{ width }}>
          <div className="pr-ruler ae-ruler" data-testid="ae-ruler"
            style={{ height: RULER_H, backgroundImage: 'linear-gradient(90deg, var(--line-strong) 1px, transparent 1px)', backgroundSize: `${beatPx}px 6px`, backgroundPosition: 'left bottom', backgroundRepeat: 'repeat-x' }} onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={() => (scrub.current = null)} title="Click or drag to scrub">
            {bars.map((b, k) => (
              <span key={b} style={{ left: k * barPx }}>{b}</span>
            ))}
          </div>
          <div
            className="ae-lane" ref={laneRef} data-testid="ae-lane" data-pps={pps}
            style={{
              backgroundImage: [
                `linear-gradient(90deg, var(--line-strong) 1px, transparent 1px)`,
                `linear-gradient(90deg, var(--line) 1px, transparent 1px)`,
                ...(showSteps ? [`linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)`] : []),
              ].join(','),
              backgroundSize: [`${barPx}px 100%`, `${beatPx}px 100%`, ...(showSteps ? [`${step * pps}px 100%`] : [])].join(','),
            }}
            onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={() => (scrub.current = null)}
          >
            <div className="ae-rec" style={{ left: recL, width: recW }} />
            <div
              className="ae-region" data-testid="ae-region" style={{ left: regionL, width: Math.max(4, regionW) }}
              onPointerDown={onRegionDown} onPointerMove={onRegionMove} onPointerUp={onRegionUp}
              onPointerCancel={() => ((drag.current = null), setDraft(null))}
              title={`${clip.name}: drag to move, drag an edge to trim (Option: off the grid)`}
            >
              <div className="ae-region-name">{clip.name}</div>
              <span className="ae-trim l" />
              <span className="ae-trim r" />
            </div>
            <canvas className="ae-wave" data-testid="ae-wave" ref={canvasRef} style={{ left: scrollX }} />
          </div>
          <div className="pr-playhead" ref={playheadRef} style={{ height: '100%' }} />
        </div>
      </div>
    </div>
  );
}
