// "Ideas" column on the canvas: one card per recorded / imported sound (voice notes, takes,
// library sounds), wired to the tracks that use it. Clicking a card selects its first clip.
// The × (or Delete/Backspace on a focused card) deletes the sound; if clips use it, it asks first.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Session, Source } from '../core/session';
import { buffers } from './audio';
import { trackColor } from './TrackHeader';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const ORIGIN: Record<string, string> = { record: 'Recorded', import: 'Imported', freesound: 'Library' };
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Sources worth a card: real audio, not the placeholders MIDI clips carry. */
export function ideaSources(s: Session): Source[] {
  return Object.values(s.sources).filter((src) => src.origin !== 'generated');
}

/** Colour of the first track that uses a source (cards and wires take the track's colour). */
function usage(s: Session, sourceId: string) {
  const uses = s.tracks.flatMap((t, i) => t.clips.filter((c) => c.sourceId === sourceId).map((c) => ({ t, i, c })));
  return { uses, color: uses.length ? trackColor(uses[0].i) : 'var(--faint)' };
}

export function Ideas({ session, run, audioVersion }: { session: Session; run: Run; audioVersion: number }) {
  const sources = ideaSources(session);
  const [confirm, setConfirm] = useState<string | null>(null); // source id awaiting "Delete?"
  if (!sources.length) return null;
  const remove = (id: string) => {
    setConfirm(null);
    run('delete_sound', { source_id: id });
  };
  const askRemove = (id: string) => (usage(session, id).uses.length ? setConfirm(id) : remove(id));
  return (
    <section className="ideas" aria-label="Ideas">
      <div className="frame-title"><b>Ideas</b> {sources.length} sound{sources.length > 1 ? 's' : ''}</div>
      {sources.map((src) => {
        const { uses, color } = usage(session, src.id);
        const first = uses[0];
        const selected = !!first && uses.some((u) => u.c.id === session.selection.clipId);
        return (
          <div key={src.id} className="idea" data-idea={src.id} style={{ '--c': color } as React.CSSProperties}>
            <button
              className={`idea-card${selected ? ' sel' : ''}`}
              onClick={() => first && run('select', { track_id: first.t.id, clip_id: first.c.id })}
              onKeyDown={(e) => {
                if (e.key !== 'Backspace' && e.key !== 'Delete') return;
                e.preventDefault();
                e.stopPropagation(); // the sound, not the selected clip (App's Delete key command)
                askRemove(src.id);
              }}
              title={first ? `Select it on ${first.t.name}` : 'Not on a track'}
            >
              <span className="idea-head">
                <i className="dot" />
                <span className="idea-name">{src.name}</span>
                <span className="idea-dur">{fmtDur(src.duration)}</span>
              </span>
              <MiniWave sourceId={src.id} version={audioVersion} />
              <span className="idea-meta">
                {ORIGIN[src.origin] ?? src.origin}
                {uses.length ? ` · on ${[...new Set(uses.map((u) => u.t.name))].join(', ')}` : ' · not on a track'}
              </span>
              {src.credit && <span className="idea-credit" title={src.credit}>{src.credit}</span>}
            </button>
            <button className="idea-del" aria-label="Delete sound" title="Delete this sound (⌫)" onClick={() => askRemove(src.id)}>×</button>
            {confirm === src.id && (
              <div className="idea-confirm" data-testid="idea-confirm" role="alertdialog" aria-label={`Delete ${src.name}?`} onKeyDown={(e) => e.key === 'Escape' && setConfirm(null)}>
                <span>Delete “{src.name}”? Also removes {uses.length} clip{uses.length > 1 ? 's' : ''} from the arrangement.</span>
                <span className="idea-confirm-actions">
                  <button onClick={() => setConfirm(null)}>Cancel</button>
                  <button className="danger" autoFocus onClick={() => remove(src.id)}>Delete</button>
                </span>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Bar-style peak overview of a source, drawn once per buffer. */
function MiniWave({ sourceId, version }: { sourceId: string; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const b = buffers.get(sourceId);
    if (!c || !b) return;
    const draw = () => {
      const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
      c.width = w * dpr;
      c.height = h * dpr;
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);
      g.fillStyle = getComputedStyle(c).color;
      const data = b.getChannelData(0);
      const bars = Math.floor(w / 3);
      const per = Math.max(1, Math.floor(data.length / bars));
      let max = 1e-6;
      const peaks = Array.from({ length: bars }, (_, i) => {
        let p = 0;
        for (let j = i * per; j < Math.min(data.length, (i + 1) * per); j += 8) p = Math.max(p, Math.abs(data[j]));
        max = Math.max(max, p);
        return p;
      });
      peaks.forEach((p, i) => {
        const a = Math.max(1, (p / max) * (h / 2 - 1));
        g.fillRect(i * 3, h / 2 - a, 2, a * 2);
      });
    };
    draw();
    const ro = new ResizeObserver(draw); // redraw when the Ideas column is resized
    ro.observe(c);
    return () => ro.disconnect();
  }, [sourceId, version]);
  return <canvas ref={ref} className="idea-wave" aria-hidden />;
}

/** Bezier wires from each idea card to the track headers of the tracks that use it. Positions
 *  are measured in the world's coordinates, so the wires scroll with the canvas. */
export function IdeaWires({ session, worldRef }: { session: Session; worldRef: RefObject<HTMLDivElement | null> }) {
  const [paths, setPaths] = useState<{ d: string; color: string; x0: number; y0: number; x1: number; y1: number }[]>([]);
  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const measure = () => {
      const wr = world.getBoundingClientRect();
      const out: typeof paths = [];
      for (const src of ideaSources(session)) {
        const card = world.querySelector(`[data-idea="${src.id}"]`);
        if (!card) continue;
        const cr = card.getBoundingClientRect();
        const { uses } = usage(session, src.id);
        for (const id of new Set(uses.map((u) => u.t.id))) {
          const i = session.tracks.findIndex((t) => t.id === id);
          const head = world.querySelector(`[data-testid="track-${id}"]`);
          if (!head) continue;
          const hr = head.getBoundingClientRect();
          // a header scrolled out of a short board: end the wire at the board's visible edge
          const ar = head.closest('.arrange')?.getBoundingClientRect();
          const hy = hr.top + hr.height / 2;
          const y = ar ? Math.min(ar.bottom - 6, Math.max(ar.top + 6, hy)) : hy;
          const x0 = cr.right - wr.left, y0 = cr.top + cr.height / 2 - wr.top;
          const x1 = hr.left - wr.left, y1 = y - wr.top;
          const dx = Math.max(30, (x1 - x0) / 2);
          out.push({ d: `M${x0} ${y0} C${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}`, color: trackColor(i), x0, y0, x1, y1 });
        }
      }
      setPaths(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(world);
    // resizing the Ideas column, the board or the lanes moves the ends without resizing the world
    world.querySelectorAll('.ideas, .board, .board-col, .arrange-interaction').forEach((el) => ro.observe(el));
    let raf = 0;
    const onScroll = (e: Event) => {
      if (!(e.target as Element).closest?.('.arrange')) return; // the board scrolling its lanes
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    world.addEventListener('scroll', onScroll, true);
    const t = setTimeout(measure, 300); // the playlist lays its rows out a moment after the session changes
    return () => {
      ro.disconnect();
      world.removeEventListener('scroll', onScroll, true);
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [session, worldRef]);
  return (
    <svg className="wires" aria-hidden>
      {paths.map((p, i) => (
        <g key={i} stroke={p.color} fill="none">
          <path d={p.d} strokeWidth={2} opacity={0.8} />
          <circle cx={p.x0} cy={p.y0} r={4} fill={p.color} stroke="none" />
          <circle cx={p.x1} cy={p.y1} r={4} fill="var(--ground)" strokeWidth={2} />
        </g>
      ))}
    </svg>
  );
}
