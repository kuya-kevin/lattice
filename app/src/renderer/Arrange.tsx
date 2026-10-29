// Tracks-area interaction, replacing waveform-playlist's ClipInteractionProvider:
//  - clip moves in time AND across tracks (the stock provider pins moves to the horizontal
//    axis), snapped to bar/beat, with a drop indicator and a Logic-style help tag;
//    dropping below the last track makes a new track. Moves run the move_clip tool, so they
//    are undoable and logged as hand edits for Muse.
//  - clip trims are delegated to waveform-playlist's own handlers (with our snap), and are
//    committed as one trim_clip when the drag ends.
//  - library sounds and Ideas cards dragged in (HTML5 drag and drop) land on the track under
//    the pointer at the snapped time, or on a new track below the others.
//  - clicking a clip selects it (track + clip), as in Logic; double-clicking also opens it in
//    the Piano Roll (onOpenClip). Shift- or Cmd-click adds or removes a clip, and dragging
//    from empty lane space draws a marquee (Logic's rubber band); dragging any clip of a
//    multi-selection moves them all (move_clips), keeping their shape; below the last track
//    they go on new tracks.
//  - clicking or dragging in the bar ruler moves the playhead, snapped to the grid (Logic's
//    ruler). With Cycle on, the ruler's upper half stays the cycle area, as in Logic, and the
//    cycle area snaps to the grid as it is drawn or dragged.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modifier } from '@dnd-kit/abstract';
import { DragDropProvider } from '@dnd-kit/react';
import { useClipDragHandlers, useDragSensors, usePlaybackAnimation, usePlaylistControls, usePlaylistData, usePlaylistState } from '@waveform-playlist/browser';
import { formatBarsBeats, type Meter } from '../core/metronome';
import { midiSignature, type MidiData } from '../core/midi';
import { selectedClipIds, type Session } from '../core/session';
import { pxToSeconds, secondsToPx, snapCycle, snapMove, snapTime, type SnapMode } from '../core/snap';
import { IDEA_MIME, KIT_MIME, LIBRARY_MIME, libraryDrag, soundDrag } from './libraryAudio';
import { barLength } from '../core/metronome';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** Keeps the dragged clip where it is; the drop indicator shows where it will land. */
class StayPut extends Modifier<any, any> {
  apply() {
    return { x: 0, y: 0 };
  }
}

export interface DropTarget {
  trackId: string | null; // null = new track
  start: number; // seconds, snapped
}

interface Ghost {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
  isNew: boolean;
}

interface Props {
  session: Session;
  snap: SnapMode;
  run: Run;
  /** true while a trim drag is in progress (App skips per-frame tool calls) */
  trimmingRef: React.MutableRefObject<boolean>;
  /** commit the engine's current tracks as tool calls (after a trim) */
  commitTracks: () => void;
  onDropSound: (id: string, target: DropTarget) => void;
  /** an Ideas card (a source in the session) dropped on the arrangement */
  onDropIdea: (sourceId: string, target: DropTarget) => void;
  /** B12: a sample pad card dropped: an empty region on the kit */
  onDropKit: (kitId: string, target: DropTarget) => void;
  /** double-click on a clip (it is selected first) */
  onOpenClip: (clipId: string) => void;
  children: ReactNode;
}

const NEW_LANE_HEIGHT = 64;

export function ArrangeInteraction({ session, snap, run, trimmingRef, commitTracks, onDropSound, onDropIdea, onDropKit, onOpenClip, children }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { tracks, samplesPerPixel, sampleRate, playoutRef, isDraggingRef, onTracksChange } = usePlaylistData();
  const { isLoopEnabled, loopStart, loopEnd } = usePlaylistState();
  const { setLoopRegion, setSelection, setCurrentTime } = usePlaylistControls();
  const { isPlaying, currentTimeRef } = usePlaybackAnimation();
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const meter: Meter = useMemo(() => ({ tempo: session.tempo, timeSignature: session.timeSignature }), [session.tempo, session.timeSignature]);
  const latest = useRef({ session, snap, meter, samplesPerPixel, sampleRate });
  latest.current = { session, snap, meter, samplesPerPixel, sampleRate };

  // the library draws and drags the cycle area in raw pixels: put each change on the grid
  // (its drags measure from where they started, so snapping as they go doesn't fight them)
  useEffect(() => {
    if (!isLoopEnabled) return;
    const r = snapCycle(loopStart, loopEnd, snap, meter);
    if (r) setLoopRegion(r.start, r.end);
  }, [isLoopEnabled, loopStart, loopEnd, snap, meter, setLoopRegion]);

  /** Lane rows in track order, with their screen rects. */
  const laneRects = () =>
    [...(wrapRef.current?.querySelectorAll<HTMLElement>('[data-track-row][data-track-id]') ?? [])].map((r) => ({ id: r.dataset.trackId!, rect: r.getBoundingClientRect() }));

  /** Track lane under a viewport point (null trackId = the empty space below the tracks). */
  const hitTest = useCallback((x: number, y: number) => {
    const rows = [...(wrapRef.current?.querySelectorAll<HTMLElement>('[data-track-row][data-track-id]') ?? [])];
    const { samplesPerPixel: spp, sampleRate: sr } = latest.current;
    if (!rows.length) return { trackId: null, x0: null as number | null, top: 0, height: NEW_LANE_HEIGHT, seconds: 0 };
    const rects = rows.map((r) => r.getBoundingClientRect());
    const x0 = rects[0].left;
    const seconds = Math.max(0, pxToSeconds(x - x0, spp, sr));
    let i = rects.findIndex((r) => y >= r.top && y < r.bottom);
    if (i < 0 && y < rects[0].top) i = 0;
    if (i < 0) {
      const last = rects[rects.length - 1];
      return { trackId: null, x0, top: last.bottom, height: NEW_LANE_HEIGHT, seconds };
    }
    return { trackId: rows[i].dataset.trackId ?? null, x0, top: rects[i].top, height: rects[i].height, seconds };
  }, []);

  const showGhost = useCallback(
    (x: number, y: number, start: number, duration: number) => {
      const h = hitTest(x, y);
      const { samplesPerPixel: spp, sampleRate: sr, session: s, meter: m } = latest.current;
      const name = h.trackId ? s.tracks.find((t) => t.id === h.trackId)?.name ?? h.trackId : 'New track';
      const label = `${formatBarsBeats(start, m)} · ${name}`;
      if (h.x0 == null) {
        const r = wrapRef.current!.getBoundingClientRect();
        setGhosts([{ left: r.left + 8, top: r.top + 8, width: r.width - 16, height: Math.min(r.height - 16, 120), label: `${name} at 1 1 1`, isNew: true }]);
      } else {
        setGhosts([{ left: h.x0 + secondsToPx(start, spp, sr), top: h.top, width: Math.max(6, secondsToPx(duration, spp, sr)), height: h.height, label, isNew: !h.trackId }]);
      }
      return h;
    },
    [hitTest],
  );

  // ---- clip moves and trims (dnd-kit, the same library waveform-playlist uses) ----
  const snapSamplePosition = useMemo(
    () => (snap === 'off' ? undefined : (samples: number) => Math.round(snapTime(samples / sampleRate, snap, meter) * sampleRate)),
    [snap, meter, sampleRate],
  );
  const trim = useClipDragHandlers({ tracks, onTracksChange: onTracksChange ?? (() => {}), samplesPerPixel, engineRef: playoutRef, isDraggingRef, snapSamplePosition });
  const sensors = useDragSensors({});
  const move = useRef<{ clipId: string; fromTrack: string; start: number; duration: number; x0: number; el: Element | null; target: DropTarget | null } | null>(null);
  /** a drag of a multi-selection: every clip moves by the same time and lane offset */
  const group = useRef<{ ids: string[]; x0: number; start: number; fromIndex: number; delta: number; offset: number } | null>(null);
  const dragged = useRef(false); // a clip drag started since the last pointerdown

  const onDragStart = useCallback(
    (event: any) => {
      const data = event.operation?.source?.data;
      if (!data) return;
      const fromTrack = tracks[data.trackIndex]?.id;
      if (data.boundary) {
        trimmingRef.current = true;
        trim.onDragStart(event);
        return;
      }
      const clip = session.tracks.flatMap((t) => t.clips).find((c) => c.id === data.clipId);
      if (!clip || !fromTrack) return;
      dragged.current = true;
      const ids = selectedClipIds(session);
      if (ids.length > 1 && ids.includes(clip.id)) {
        const fromIndex = session.tracks.findIndex((t) => t.id === fromTrack);
        group.current = { ids, x0: event.operation.position.initial.x, start: clip.start, fromIndex, delta: 0, offset: 0 };
        return;
      }
      const el = event.operation.source.element ?? null;
      el?.setAttribute('data-lt-drag-source', '');
      move.current = { clipId: clip.id, fromTrack, start: clip.start, duration: clip.duration, x0: event.operation.position.initial.x, el, target: null };
      run('select', { track_id: fromTrack, clip_id: clip.id });
    },
    [tracks, session.tracks, trim, trimmingRef, run],
  );

  /** Ghosts for a multi-selection drag, clamped as move_clips clamps (no clip before 0 or above
   *  the first track), so what you see is where they land. Below the last lane they show on new
   *  tracks, as move_clips makes them. */
  const moveGroup = useCallback((p: { x: number; y: number }) => {
    const g = group.current!;
    const { session: s, samplesPerPixel: spp, sampleRate: sr, snap: sn, meter: mt } = latest.current;
    const clips = g.ids.flatMap((id) => s.tracks.flatMap((t, i) => t.clips.filter((c) => c.id === id).map((c) => ({ c, i }))));
    const lanes = laneRects();
    if (!clips.length || !lanes.length) return;
    const minStart = Math.min(...clips.map((x) => x.c.start));
    g.delta = Math.max(snapMove(g.start, pxToSeconds(p.x - g.x0, spp, sr), sn, mt) - g.start, -minStart);
    let at = lanes.findIndex((l) => p.y >= l.rect.top && p.y < l.rect.bottom);
    if (at < 0) at = p.y < lanes[0].rect.top ? 0 : lanes.length; // below the lanes: new tracks
    const idx = clips.map((x) => x.i);
    g.offset = Math.max(-Math.min(...idx), Math.min(lanes.length - Math.min(...idx), at - g.fromIndex));
    const x0 = lanes[0].rect.left;
    const last = lanes[lanes.length - 1].rect;
    setGhosts(
      clips.map(({ c, i }, n) => {
        const row = i + g.offset;
        const lane = row < lanes.length ? lanes[row].rect : { top: last.bottom + (row - lanes.length) * last.height, height: last.height };
        const label = n === 0 ? `${formatBarsBeats(c.start + g.delta, mt)} · ${clips.length} regions` : '';
        return { left: x0 + secondsToPx(c.start + g.delta, spp, sr), top: lane.top, width: Math.max(6, secondsToPx(c.duration, spp, sr)), height: lane.height, label, isNew: row >= lanes.length };
      }),
    );
  }, []);

  const onDragMove = useCallback(
    (event: any) => {
      const data = event.operation?.source?.data;
      if (data?.boundary) return trim.onDragMove(event);
      if (group.current) return moveGroup(event.to ?? event.operation.position.current);
      const m = move.current;
      if (!m) return;
      const p = event.to ?? event.operation.position.current;
      const { samplesPerPixel: spp, sampleRate: sr, snap: sn, meter: mt } = latest.current;
      const start = snapMove(m.start, pxToSeconds(p.x - m.x0, spp, sr), sn, mt);
      const h = showGhost(p.x, p.y, start, m.duration);
      m.target = { trackId: h.trackId, start };
    },
    [trim, showGhost, moveGroup],
  );

  const onDragEnd = useCallback(
    async (event: any) => {
      const data = event.operation?.source?.data;
      if (data?.boundary) {
        trimmingRef.current = false;
        trim.onDragEnd(event);
        requestAnimationFrame(commitTracks);
        return;
      }
      const g = group.current;
      group.current = null;
      if (g) {
        setGhosts([]);
        if (!event.canceled && (Math.abs(g.delta) > 0.0005 || g.offset)) await run('move_clips', { clip_ids: g.ids, delta: g.delta, track_offset: g.offset });
        return;
      }
      const m = move.current;
      move.current = null;
      setGhosts([]);
      m?.el?.removeAttribute('data-lt-drag-source');
      if (!m || event.canceled || !m.target) return;
      let { trackId } = m.target;
      const { start } = m.target;
      if (!trackId) {
        const src = latest.current.session.tracks.find((t) => t.id === m.fromTrack);
        trackId = (await run('add_track', { name: src ? `${src.name} 2` : undefined })).result?.track_id ?? null;
        if (!trackId) return;
      }
      if (trackId === m.fromTrack && Math.abs(start - m.start) < 0.001) return;
      await run('move_clip', { clip_id: m.clipId, start, ...(trackId !== m.fromTrack ? { track_id: trackId } : {}) });
    },
    [trim, trimmingRef, commitTracks, run],
  );

  // ---- click / drag in the ruler to move the playhead ----
  const onRulerDown = (e: React.PointerEvent, ruler: HTMLElement) => {
    const r = ruler.getBoundingClientRect();
    if (isLoopEnabled && (e.clientY < r.top + r.height / 2 || (e.target as HTMLElement).closest('[data-loop-marker-handle]'))) return;
    e.preventDefault(); // also keeps the library's cycle-drag (mousedown) from starting
    e.stopPropagation();
    let last = -1;
    const locate = (x: number) => {
      const { samplesPerPixel: spp, sampleRate: sr, snap: sn, meter: mt } = latest.current;
      const t = snapTime(pxToSeconds(x - ruler.getBoundingClientRect().left, spp, sr), sn, mt);
      if (t !== last) run('go_to', { position: (last = t) });
    };
    locate(e.clientX);
    // scrub only while the button is held: a lost pointerup must not leave the ruler following the mouse
    const move = (ev: PointerEvent) => (ev.buttons & 1 ? locate(ev.clientX) : up());
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ---- click a clip to select it; Shift/Cmd-click toggles it; drag on empty space: marquee ----
  const onPointerDownCapture = (e: React.PointerEvent) => {
    const ruler = (e.target as HTMLElement).closest<HTMLElement>('[data-lt-ruler]');
    if (ruler) return onRulerDown(e, ruler);
    if ((e.target as HTMLElement).closest('.track-controls')) return;
    if (e.button !== 0) return;
    dragged.current = false;
    const h = hitTest(e.clientX, e.clientY);
    if (h.x0 == null || e.clientX < h.x0) return;
    const additive = e.shiftKey || e.metaKey;
    const ids = selectedClipIds(session);
    const t = session.tracks.find((x) => x.id === h.trackId);
    const clip = t?.clips.find((c) => h.seconds >= c.start && h.seconds <= c.start + c.duration);
    if (clip && additive) {
      const next = ids.includes(clip.id) ? ids.filter((c) => c !== clip.id) : [...ids, clip.id];
      run('select', { track_id: h.trackId, ...(next.includes(clip.id) ? { clip_id: clip.id } : {}), clip_ids: next });
    } else if (clip && ids.length > 1 && ids.includes(clip.id)) {
      // a click on one of several selected clips keeps them all for a drag; without a drag it
      // selects just that one, as in Logic
      const up = () => {
        window.removeEventListener('pointerup', up);
        if (!dragged.current) run('select', { track_id: h.trackId, clip_id: clip.id });
      };
      window.addEventListener('pointerup', up);
    } else if (clip && session.selection.clipId !== clip.id) run('select', { track_id: h.trackId, clip_id: clip.id });
    else if (!clip) {
      if (h.trackId && ids.length && !additive) run('select', { track_id: h.trackId });
      startMarquee(e.clientX, e.clientY, additive ? ids : []);
    }
  };

  /** Rubber-band selection from empty lane space: every clip the box touches is selected
   *  (added to `keep` with Shift/Cmd). Starts after a few pixels so a click stays a click. */
  const startMarquee = (x0: number, y0: number, keep: string[]) => {
    let on = false;
    const playhead = currentTimeRef.current ?? 0; // read before the library's mousedown moves it
    let last = '';
    const move = (ev: PointerEvent) => {
      if (!(ev.buttons & 1) || dragged.current) return up();
      if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      on = true;
      const left = Math.min(x0, ev.clientX), right = Math.max(x0, ev.clientX);
      const top = Math.min(y0, ev.clientY), bottom = Math.max(y0, ev.clientY);
      setMarquee({ left, top, width: right - left, height: bottom - top });
      const { session: s, samplesPerPixel: spp, sampleRate: sr } = latest.current;
      const lanes = laneRects();
      if (!lanes.length) return;
      const t0 = pxToSeconds(left - lanes[0].rect.left, spp, sr), t1 = pxToSeconds(right - lanes[0].rect.left, spp, sr);
      const hit = lanes
        .filter((l) => l.rect.bottom > top && l.rect.top < bottom)
        .flatMap((l) => (s.tracks.find((t) => t.id === l.id)?.clips ?? []).filter((c) => c.start < t1 && c.start + c.duration > t0).map((c) => ({ c, track: l.id })));
      const ids = [...new Set([...keep, ...hit.map((x) => x.c.id)])];
      const key = ids.join();
      if (key === last) return;
      last = key;
      const primary = hit[0];
      run('select', { track_id: primary?.track ?? s.selection.trackId ?? undefined, ...(primary ? { clip_id: primary.c.id } : {}), clip_ids: ids });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setMarquee(null);
      // the library also treats the drag as a time selection and a click-to-locate: undo both
      // once its own mouseup has run
      if (on && !isPlaying)
        setTimeout(() => {
          setSelection(0, 0);
          setCurrentTime(playhead);
        });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.track-controls, [data-lt-ruler]')) return;
    const h = hitTest(e.clientX, e.clientY);
    if (!h.trackId || h.x0 == null || e.clientX < h.x0) return;
    const clip = session.tracks.find((x) => x.id === h.trackId)?.clips.find((c) => h.seconds >= c.start && h.seconds <= c.start + c.duration);
    if (!clip) return;
    if (session.selection.clipId !== clip.id) run('select', { track_id: h.trackId, clip_id: clip.id });
    onOpenClip(clip.id);
  };

  // Decorate the library's clip DOM (styled in styles.css): mark the selected clip, label each
  // region header with the clip's own name (the library prints the track name, which is wrong
  // once a clip has moved to another track), and draw a MIDI region's notes over its body in
  // place of the rendered audio's waveform, as Logic, GarageBand and BandLab do.
  const selClips = new Set(selectedClipIds(session));
  const midiById = new Map(session.tracks.flatMap((t) => t.clips.filter((c) => c.midi).map((c) => [c.id, c] as const)));
  useLayoutEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    // the ruler is the first child of the scrolling timeline (waveform-playlist's TimescaleWrapper)
    root.querySelector('[data-scroll-container]')?.firstElementChild?.firstElementChild?.setAttribute('data-lt-ruler', '');
    for (const t of tracks) {
      const row = root.querySelector(`[data-track-row][data-track-id="${CSS.escape(t.id)}"]`);
      const nodes = row ? [...row.querySelectorAll('[data-clip-container]')] : [];
      t.clips.forEach((c, i) => {
        const node = nodes[i];
        if (!node) return;
        if (selClips.has(c.id)) node.setAttribute('data-lt-selected', '');
        else node.removeAttribute('data-lt-selected');
        const header = node.firstElementChild;
        if (header && c.name && header.getAttribute('data-lt-name') !== c.name) header.setAttribute('data-lt-name', c.name);
        const mc = midiById.get(c.id);
        const body = node.children[1] as HTMLElement | undefined;
        if (body) drawRegionNotes(node, body, mc?.midi, mc?.offset ?? 0, mc?.duration ?? 0);
      });
    }
  });

  // ---- library and Ideas drops ----
  const onDragOver = (e: React.DragEvent) => {
    const idea = e.dataTransfer.types.includes(IDEA_MIME);
    const kit = e.dataTransfer.types.includes(KIT_MIME);
    if (!idea && !kit && !e.dataTransfer.types.includes(LIBRARY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const h = hitTest(e.clientX, e.clientY);
    const { snap: sn, meter: mt } = latest.current;
    const len = kit ? 2 * barLength(mt) : idea ? soundDrag.idea?.duration : libraryDrag.item?.duration; // place_kit: 2 bars
    showGhost(e.clientX, e.clientY, snapTime(h.seconds, sn, mt), len ?? 1);
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(LIBRARY_MIME);
    const idea = e.dataTransfer.getData(IDEA_MIME);
    const kit = e.dataTransfer.getData(KIT_MIME);
    if (!id && !idea && !kit) return;
    e.preventDefault();
    e.stopPropagation();
    setGhosts([]);
    const h = hitTest(e.clientX, e.clientY);
    const { snap: sn, meter: mt } = latest.current;
    const target = { trackId: h.trackId, start: h.x0 == null ? 0 : snapTime(h.seconds, sn, mt) };
    if (kit) onDropKit(kit, target);
    else if (idea) onDropIdea(idea, target);
    else onDropSound(id, target);
  };

  return (
    <div
      ref={wrapRef}
      className="arrange-interaction"
      onPointerDownCapture={onPointerDownCapture}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDragLeave={(e) => !wrapRef.current?.contains(e.relatedTarget as Node) && setGhosts([])}
      onDrop={onDrop}
    >
      <DragDropProvider sensors={sensors} modifiers={[StayPut]} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}>
        {children}
      </DragDropProvider>
      {ghosts.map((g, i) => (
        <div key={i} className={`drop-ghost${g.isNew ? ' new' : ''}`} data-testid="drop-indicator" style={{ left: g.left, top: g.top, width: g.width, height: g.height }}>
          {g.label && <span className="help-tag">{g.label}</span>}
        </div>
      ))}
      {marquee && <div className="marquee" data-testid="marquee" style={marquee} />}
    </div>
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Draw (or clear) a MIDI region's notes as dashes over its body: time runs across the clip's
 *  audible window, pitch fills the height (at least 16 rows, so a few notes don't turn into
 *  bars). One SVG, rebuilt only when the notes or the trim change. */
export function drawRegionNotes(node: Element, body: HTMLElement, midi: MidiData | undefined, offset: number, duration: number) {
  let svg = body.querySelector<SVGSVGElement>(':scope > svg.lt-notes');
  if (!midi || !(duration > 0)) {
    node.removeAttribute('data-lt-midi');
    svg?.remove();
    return;
  }
  node.setAttribute('data-lt-midi', '');
  const sig = `${midiSignature(midi, duration)}@${offset}`;
  if (svg?.dataset.sig === sig) return;
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('lt-notes');
    svg.setAttribute('preserveAspectRatio', 'none');
    body.appendChild(svg);
  }
  svg.dataset.sig = sig;
  const ps = midi.notes.map((n) => n.pitch);
  const lo0 = ps.length ? Math.min(...ps) : 60;
  const hi0 = ps.length ? Math.max(...ps) : 60;
  const rows = Math.max(16, hi0 - lo0 + 3);
  const hi = Math.round((lo0 + hi0) / 2 + rows / 2);
  svg.setAttribute('viewBox', `0 0 ${duration} ${rows}`);
  svg.replaceChildren(
    ...midi.notes
      .filter((n) => n.start + n.duration > offset && n.start < offset + duration)
      .map((n) => {
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', String(n.start - offset));
        r.setAttribute('y', String(hi - n.pitch + 0.15));
        r.setAttribute('width', String(Math.max(duration / 400, n.duration)));
        r.setAttribute('height', '0.7');
        r.setAttribute('opacity', String(0.55 + 0.45 * (n.velocity / 127)));
        return r;
      }),
  );
}
