// Tracks-area interaction, replacing waveform-playlist's ClipInteractionProvider:
//  - clip moves in time AND across tracks (the stock provider pins moves to the horizontal
//    axis), snapped to bar/beat, with a drop indicator and a Logic-style help tag;
//    dropping below the last track makes a new track. Moves run the move_clip tool, so they
//    are undoable and logged as hand edits for Muse.
//  - clip trims are delegated to waveform-playlist's own handlers (with our snap), and are
//    committed as one trim_clip when the drag ends.
//  - library sounds dragged in (HTML5 drag and drop) land on the track under the pointer at
//    the snapped time, or on a new track below the others.
//  - clicking a clip selects it (track + clip), as in Logic.
//  - clicking or dragging in the bar ruler moves the playhead, snapped to the grid (Logic's
//    ruler). With Cycle on, the ruler's upper half stays the cycle area, as in Logic.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modifier } from '@dnd-kit/abstract';
import { DragDropProvider } from '@dnd-kit/react';
import { useClipDragHandlers, useDragSensors, usePlaylistData, usePlaylistState } from '@waveform-playlist/browser';
import { formatBarsBeats, type Meter } from '../core/metronome';
import type { Session } from '../core/session';
import { pxToSeconds, secondsToPx, snapMove, snapTime, type SnapMode } from '../core/snap';
import { LIBRARY_MIME, libraryDrag } from './libraryAudio';

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
  children: ReactNode;
}

const NEW_LANE_HEIGHT = 64;

export function ArrangeInteraction({ session, snap, run, trimmingRef, commitTracks, onDropSound, children }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { tracks, samplesPerPixel, sampleRate, playoutRef, isDraggingRef, onTracksChange } = usePlaylistData();
  const { isLoopEnabled } = usePlaylistState();
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const meter: Meter = useMemo(() => ({ tempo: session.tempo, timeSignature: session.timeSignature }), [session.tempo, session.timeSignature]);
  const latest = useRef({ session, snap, meter, samplesPerPixel, sampleRate });
  latest.current = { session, snap, meter, samplesPerPixel, sampleRate };

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
        setGhost({ left: r.left + 8, top: r.top + 8, width: r.width - 16, height: Math.min(r.height - 16, 120), label: `${name} at 1 1 1`, isNew: true });
      } else {
        setGhost({ left: h.x0 + secondsToPx(start, spp, sr), top: h.top, width: Math.max(6, secondsToPx(duration, spp, sr)), height: h.height, label, isNew: !h.trackId });
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
      const el = event.operation.source.element ?? null;
      el?.setAttribute('data-lt-drag-source', '');
      move.current = { clipId: clip.id, fromTrack, start: clip.start, duration: clip.duration, x0: event.operation.position.initial.x, el, target: null };
      run('select', { track_id: fromTrack, clip_id: clip.id });
    },
    [tracks, session.tracks, trim, trimmingRef, run],
  );

  const onDragMove = useCallback(
    (event: any) => {
      const data = event.operation?.source?.data;
      if (data?.boundary) return trim.onDragMove(event);
      const m = move.current;
      if (!m) return;
      const p = event.to ?? event.operation.position.current;
      const { samplesPerPixel: spp, sampleRate: sr, snap: sn, meter: mt } = latest.current;
      const start = snapMove(m.start, pxToSeconds(p.x - m.x0, spp, sr), sn, mt);
      const h = showGhost(p.x, p.y, start, m.duration);
      m.target = { trackId: h.trackId, start };
    },
    [trim, showGhost],
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
      const m = move.current;
      move.current = null;
      setGhost(null);
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

  // ---- click a clip to select it ----
  const onPointerDownCapture = (e: React.PointerEvent) => {
    const ruler = (e.target as HTMLElement).closest<HTMLElement>('[data-lt-ruler]');
    if (ruler) return onRulerDown(e, ruler);
    if ((e.target as HTMLElement).closest('.track-controls')) return;
    const h = hitTest(e.clientX, e.clientY);
    if (!h.trackId || h.x0 == null || e.clientX < h.x0) return;
    const t = session.tracks.find((x) => x.id === h.trackId);
    const clip = t?.clips.find((c) => h.seconds >= c.start && h.seconds <= c.start + c.duration);
    if (clip && session.selection.clipId !== clip.id) run('select', { track_id: h.trackId, clip_id: clip.id });
    else if (!clip && session.selection.clipId) run('select', { track_id: h.trackId });
  };

  // Decorate the library's clip DOM (attributes only; styled in styles.css): mark the selected
  // clip, and label each region header with the clip's own name (the library prints the
  // track name, which is wrong once a clip has moved to another track).
  const selClip = session.selection.clipId;
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
        if (c.id === selClip) node.setAttribute('data-lt-selected', '');
        else node.removeAttribute('data-lt-selected');
        const header = node.firstElementChild;
        if (header && c.name && header.getAttribute('data-lt-name') !== c.name) header.setAttribute('data-lt-name', c.name);
      });
    }
  });

  // ---- library drops ----
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(LIBRARY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const h = hitTest(e.clientX, e.clientY);
    const { snap: sn, meter: mt } = latest.current;
    showGhost(e.clientX, e.clientY, snapTime(h.seconds, sn, mt), libraryDrag.item?.duration ?? 1);
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(LIBRARY_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    setGhost(null);
    const h = hitTest(e.clientX, e.clientY);
    const { snap: sn, meter: mt } = latest.current;
    onDropSound(id, { trackId: h.trackId, start: h.x0 == null ? 0 : snapTime(h.seconds, sn, mt) });
  };

  return (
    <div
      ref={wrapRef}
      className="arrange-interaction"
      onPointerDownCapture={onPointerDownCapture}
      onDragOver={onDragOver}
      onDragLeave={(e) => !wrapRef.current?.contains(e.relatedTarget as Node) && setGhost(null)}
      onDrop={onDrop}
    >
      <DragDropProvider sensors={sensors} modifiers={[StayPut]} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}>
        {children}
      </DragDropProvider>
      {ghost && (
        <div className={`drop-ghost${ghost.isNew ? ' new' : ''}`} data-testid="drop-indicator" style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}>
          <span className="help-tag">{ghost.label}</span>
        </div>
      )}
    </div>
  );
}
