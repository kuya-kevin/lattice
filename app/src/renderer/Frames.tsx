// Movable frames on the canvas (core/frames.ts holds the model): the Ideas column, the
// Arrangement board and the editor area each sit in a [data-frame] box placed absolutely in the
// world. Drag a frame by its title ([data-frame-handle]) anywhere on the canvas: it snaps to the
// other frames' edges (guides show), and dropped on a band along another frame's side it docks
// there and follows that frame from then on. The Layout menu (zoom bar) offers the presets; Muse
// moves frames with set_layout. The layout is app-wide: kept in localStorage, mirrored in the
// session so Muse sees it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  clearSpot, DEFAULT_FRAMES, dependents, dockFrame, dockPreview, dockTarget, FRAME_IDS, freeFrame, GAP_X, parseFrames,
  PRESET_IDS, PRESETS, presetOf, resolveFrames, sameFrames, snapRect,
  type FrameId, type FrameLayout, type Guide, type PresetId, type Rect, type Side, type Size,
} from '../core/frames';
import type { Session } from '../core/session';
import { Icon } from './icons';
import type { LayoutSizes } from './Resizable';
import './Frames.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const KEY = 'lattice.frames.v1';
const BOARD_FILL = [720, 1500] as const; // the board's width when it fills the window (no width set)
const SIDE_EDITOR_W = 560; // the editor beside a frame, before its width is dragged
const SIDE_EDITOR_MIN = 400; // ... and how narrow it gets to leave the board room
const FREE_STRIP_W = 960; // Ideas as a strip on its own

function load(): FrameLayout {
  try {
    return parseFrames(JSON.parse(localStorage.getItem(KEY) ?? 'null')) ?? DEFAULT_FRAMES;
  } catch {
    return DEFAULT_FRAMES;
  }
}

function save(l: FrameLayout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* storage blocked: the layout lasts until the window closes */
  }
}

/** The frame layout, kept in step with session.frames: the app's own layout goes to the session
 *  when it first loads; after that, a change in the session (Muse's set_layout) is adopted, and a
 *  drag here is sent there. */
export function useFrameLayout(session: Session | null, run: Run) {
  const [frames, setState] = useState<FrameLayout>(load);
  const pending = useRef<FrameLayout | null>(null); // sent, not yet back in the session
  const pushed = useRef(false);
  const send = useCallback((l: FrameLayout) => {
    pending.current = l;
    void run('set_layout', { layout: l }).then((r) => {
      if (!r.ok && pending.current === l) pending.current = null;
    });
  }, [run]);
  const setFrames = useCallback((l: FrameLayout) => {
    setState(l);
    save(l);
    send(l);
  }, [send]);
  const loaded = !!session;
  const sf = session?.frames;
  useEffect(() => {
    if (!loaded) return;
    if (!pushed.current) {
      pushed.current = true;
      if (!sameFrames(sf, frames)) send(frames);
      return;
    }
    if (pending.current) {
      if (sameFrames(sf, pending.current)) pending.current = null;
      return;
    }
    if (sf && !sameFrames(sf, frames)) {
      setState(sf);
      save(sf);
    }
  }, [loaded, sf]); // eslint-disable-line react-hooks/exhaustive-deps
  return { frames, setFrames };
}

export interface Geo {
  rects: Record<FrameId, Rect>; // layout space
  origin: { x: number; y: number };
  padL: number; // world x of the frames' left edge (the padding, plus any centring)
  padT: number;
}

const frameEl = (world: HTMLElement, f: FrameId) => world.querySelector<HTMLElement>(`:scope > [data-frame="${f}"]`);
const sizeOf = (el: HTMLElement | null): Size => (el && el.offsetWidth > 0 && el.offsetHeight > 0 ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 0, h: 0 });
const docked = (l: FrameLayout, f: FrameId) => ('dock' in l[f] ? (l[f] as { dock: FrameId; side: Side }) : null);

/** Size and place the frames: widths first (the board fills the window unless dragged; a frame
 *  docked above or below another takes its width), then the heights they come to, then where
 *  resolveFrames() puts them. Sets the world's size so the canvas scrolls to everything. */
function layoutFrames(world: HTMLElement, canvas: HTMLElement, l: FrameLayout, sizes: LayoutSizes): Geo {
  const cs = getComputedStyle(world);
  const padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0;
  const padR = parseFloat(cs.paddingRight) || 0, padB = parseFloat(cs.paddingBottom) || 0;
  const el = Object.fromEntries(FRAME_IDS.map((f) => [f, frameEl(world, f)])) as Record<FrameId, HTMLElement | null>;
  const has = (f: FrameId) => !!el[f]?.firstElementChild;
  const strip = l.ideasShape === 'strip';

  // widths
  const ideasColW = has('ideas') && !strip ? sizes.ideasW : 0;
  const editorD = docked(l, 'editor'), ideasD = docked(l, 'ideas');
  // the board's column: the board and frames stacked on it (the editor above it, say)
  const inColumn = (f: FrameId, seen: FrameId[] = []): boolean => {
    const d = docked(l, f);
    return f === 'board' || (!!d && (d.side === 'top' || d.side === 'bottom') && !seen.includes(d.dock) && inColumn(d.dock, [...seen, f]));
  };
  // a frame beside that column takes width from the board
  const beside = (f: FrameId) => {
    const d = docked(l, f);
    return !!d && (d.side === 'left' || d.side === 'right') && f !== 'board' && inColumn(d.dock) && has(f);
  };
  let avail = canvas.clientWidth - padL - padR;
  if (beside('ideas')) avail -= (strip ? sizes.ideasStripW ?? FREE_STRIP_W : ideasColW) + GAP_X;
  // beside the board, the editor gives up width (down to SIDE_EDITOR_MIN) before the board does
  const editorSideW = sizes.editorW ?? Math.max(SIDE_EDITOR_MIN, Math.min(SIDE_EDITOR_W, avail - GAP_X - BOARD_FILL[0]));
  let boardW = sizes.boardW;
  if (boardW === null) {
    if (beside('editor')) avail -= editorSideW + GAP_X;
    boardW = Math.round(Math.min(BOARD_FILL[1], Math.max(BOARD_FILL[0], avail)));
  }
  const stacked = (d: { dock: FrameId; side: Side } | null) => !!d && (d.side === 'top' || d.side === 'bottom');
  const widthOf = (f: FrameId): number => (f === 'board' ? boardW! : f === 'ideas' ? (strip ? stripW : ideasColW) : editorW);
  let editorW = sizes.editorW ?? (stacked(editorD) && editorD!.dock === 'board' ? boardW : editorSideW);
  let stripW = sizes.ideasStripW ?? (stacked(ideasD) && ideasD!.dock !== 'ideas' ? widthOf(ideasD!.dock) : FREE_STRIP_W);
  if (sizes.editorW === null && stacked(editorD) && editorD!.dock === 'ideas') editorW = widthOf('ideas') || boardW;
  if (sizes.ideasStripW === null && stacked(ideasD) && ideasD!.dock === 'editor') stripW = editorW;
  if (el.board) el.board.style.width = `${boardW}px`;
  if (el.editor) el.editor.style.width = `${editorW}px`;
  if (el.ideas) {
    el.ideas.style.width = strip ? `${stripW}px` : '';
    el.ideas.classList.toggle('ideas-strip', strip);
  }

  // the editor beside the board grows to the board's height (the mixer and the roll get room)
  if (el.editor) {
    const tall = beside('editor') && sizes.editorH === null;
    const bh = el.board?.offsetHeight ?? 0;
    el.editor.classList.toggle('tall', tall);
    if (tall && bh) {
      el.editor.style.setProperty('--editor-h', `${Math.max(260, bh - 64)}px`);
      el.editor.style.minHeight = `${bh}px`;
    } else {
      el.editor.style.removeProperty('--editor-h');
      el.editor.style.minHeight = '';
    }
  }

  const sizesNow = Object.fromEntries(FRAME_IDS.map((f) => [f, has(f) ? sizeOf(el[f]) : { w: 0, h: 0 }])) as Record<FrameId, Size>;
  const { rects, origin, extent } = resolveFrames(l, sizesNow);
  // centred in the window when there's room, but clear of the Muse panel (padL) and the tool rail (padR)
  const W = canvas.clientWidth;
  const left = Math.round(Math.max(padL, Math.min((W - extent.w) / 2, W - padR - extent.w)));
  for (const f of FRAME_IDS) {
    const e = el[f];
    if (!e) continue;
    e.style.left = `${left + rects[f].x - origin.x}px`;
    e.style.top = `${padT + rects[f].y - origin.y}px`;
  }
  world.style.minWidth = `${Math.ceil(left + extent.w + padR)}px`;
  world.style.minHeight = `${Math.ceil(padT + extent.h + padB)}px`;
  return { rects, origin, padL: left, padT }; // padL: where layout x = origin.x lands in the world
}

/** Keeps the frames placed: after every render, when a frame or the window changes size, and
 *  when the layout or sizes change. Fires `framesmoved` on the world when anything moved (the
 *  idea wires listen). */
export function useFrameGeometry(worldRef: RefObject<HTMLDivElement | null>, canvasRef: RefObject<HTMLDivElement | null>, frames: FrameLayout, sizes: LayoutSizes, ready: boolean) {
  const geo = useRef<Geo | null>(null);
  const args = useRef({ frames, sizes });
  args.current = { frames, sizes };
  const update = useCallback(() => {
    const world = worldRef.current, canvas = canvasRef.current;
    if (!world || !canvas) return;
    const g = layoutFrames(world, canvas, args.current.frames, args.current.sizes);
    const key = (x: Geo | null) => (x ? JSON.stringify([x.rects, x.origin, x.padL, x.padT]) : '');
    const moved = key(g) !== key(geo.current);
    geo.current = g;
    if (moved) world.dispatchEvent(new Event('framesmoved'));
  }, [worldRef, canvasRef]);
  useLayoutEffect(update); // every render: cheap reads, and content may have changed
  useEffect(() => {
    const world = worldRef.current, canvas = canvasRef.current;
    if (!world || !canvas) return;
    let raf = 0;
    const later = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    const ro = new ResizeObserver(later);
    ro.observe(canvas);
    const watch = () => {
      ro.disconnect();
      ro.observe(canvas);
      FRAME_IDS.forEach((f) => {
        const e = frameEl(world, f);
        if (e) ro.observe(e);
      });
    };
    watch();
    const mo = new MutationObserver(() => {
      watch(); // a frame came or went (the editor closes, the first idea arrives)
      later();
    });
    mo.observe(world, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [worldRef, canvasRef, update, ready]); // ready: the world mounts once the session loads
  return geo;
}

export interface DragOverlay {
  preview: Rect | null; // where a dock would put the frame (world px)
  guides: Guide[]; // alignment guides (world px)
}

/** Drag a frame by its title. Returns the world's pointerdown handler and what to draw. */
export function useFrameDrag(worldRef: RefObject<HTMLDivElement | null>, geo: RefObject<Geo | null>, frames: FrameLayout, setFrames: (l: FrameLayout) => void, sizes: LayoutSizes) {
  const [overlay, setOverlay] = useState<DragOverlay | null>(null);
  const latest = useRef({ frames, setFrames, sizes });
  latest.current = { frames, setFrames, sizes };
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    const world = worldRef.current, g = geo.current;
    if (e.button !== 0 || !world || !g) return;
    const handle = t.closest('[data-frame-handle]');
    if (!handle || t.closest('button, input, select, textarea, a, [contenteditable="true"], .rz')) return;
    const box = handle.closest<HTMLElement>('[data-frame]');
    const f = box?.dataset.frame as FrameId | undefined;
    if (!box || !f || !FRAME_IDS.includes(f)) return;
    e.preventDefault();
    e.stopPropagation();
    const { frames: l, setFrames: commit, sizes: sz } = latest.current;
    const moving = [f, ...dependents(l, f)];
    const els = moving.map((m) => world.querySelector<HTMLElement>(`:scope > [data-frame="${m}"]`)).filter((x): x is HTMLElement => !!x);
    const r0 = g.rects[f];
    const others = Object.fromEntries(FRAME_IDS.filter((o) => !moving.includes(o)).map((o) => [o, g.rects[o]])) as Record<FrameId, Rect>;
    const otherList = Object.values(others).filter((r) => r.w > 0 && r.h > 0);
    const toWorld = (r: Rect): Rect => ({ ...r, x: g.padL + r.x - g.origin.x, y: g.padT + r.y - g.origin.y });
    const toLayout = (cx: number, cy: number) => {
      const wr = world.getBoundingClientRect();
      return { x: cx - wr.left - g.padL + g.origin.x, y: cy - wr.top - g.padT + g.origin.y };
    };
    const start = { x: e.clientX, y: e.clientY };
    let result: { dock: { to: FrameId; side: Side } } | { at: { x: number; y: number } } | null = null;
    box.classList.add('frame-dragging');
    document.documentElement.classList.add('frame-drag');

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!result && Math.hypot(dx, dy) < 4) return;
      const cand = { ...r0, x: r0.x + dx, y: r0.y + dy };
      const target = dockTarget(f, toLayout(ev.clientX, ev.clientY), others);
      let pos = { x: cand.x, y: cand.y };
      let next: DragOverlay;
      if (target) {
        const a = others[target.to];
        const stack = target.side === 'top' || target.side === 'bottom';
        // the size it will take there: Ideas turn into a strip or a column, others match widths
        const size = f === 'ideas'
          ? (stack ? { w: sz.ideasStripW ?? a.w, h: 200 } : { w: sz.ideasW, h: Math.max(r0.h, 240) })
          : f === 'editor' && stack && sz.editorW === null ? { w: a.w, h: r0.h } : { w: r0.w, h: r0.h };
        next = { preview: toWorld(dockPreview(size, a, target.side)), guides: [] };
        result = { dock: target };
      } else {
        const s = snapRect(cand, otherList);
        pos = { x: s.x, y: s.y };
        next = {
          preview: null,
          guides: s.guides.map((gd) => (gd.axis === 'x'
            ? { ...gd, at: g.padL + gd.at - g.origin.x, from: g.padT + gd.from - g.origin.y, to: g.padT + gd.to - g.origin.y }
            : { ...gd, at: g.padT + gd.at - g.origin.y, from: g.padL + gd.from - g.origin.x, to: g.padL + gd.to - g.origin.x })),
        };
        result = { at: pos };
      }
      for (const x of els) x.style.transform = `translate(${pos.x - r0.x}px, ${pos.y - r0.y}px)`;
      setOverlay(next);
    };
    const end = (apply: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      for (const x of els) x.style.transform = '';
      box.classList.remove('frame-dragging');
      document.documentElement.classList.remove('frame-drag');
      setOverlay(null);
      if (!apply || !result) return;
      if ('dock' in result) return commit(dockFrame(l, f, result.dock.to, result.dock.side, g.rects));
      const spot = clearSpot({ ...r0, ...result.at }, otherList);
      commit(freeFrame(l, f, spot.x, spot.y));
    };
    const up = () => end(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
  }, [worldRef, geo]);
  return { onPointerDown, overlay };
}

/** The dock preview and alignment guides, drawn in the world while a frame is dragged. */
export function FrameOverlay({ overlay }: { overlay: DragOverlay | null }) {
  if (!overlay) return null;
  return (
    <>
      {overlay.preview && (
        <div className="frame-dock-preview" data-testid="frame-dock-preview" style={{ left: overlay.preview.x, top: overlay.preview.y, width: overlay.preview.w, height: overlay.preview.h }} />
      )}
      {overlay.guides.map((gd, i) => (
        <div
          key={i} className={`frame-guide ${gd.axis}`}
          style={gd.axis === 'x' ? { left: gd.at, top: gd.from, height: gd.to - gd.from } : { top: gd.at, left: gd.from, width: gd.to - gd.from }}
        />
      ))}
    </>
  );
}

/** A tiny picture of a preset: Ideas (teal), board, editor. */
function PresetThumb({ id }: { id: PresetId }) {
  const b: Record<PresetId, [string, number, number, number, number][]> = {
    'ideas-left': [['i', 1, 1, 7, 18], ['b', 10, 1, 21, 8], ['e', 10, 11, 21, 8]],
    'ideas-right': [['b', 1, 1, 21, 8], ['e', 1, 11, 21, 8], ['i', 24, 1, 7, 18]],
    'ideas-top': [['i', 1, 1, 30, 4], ['b', 1, 7, 30, 6], ['e', 1, 15, 30, 4]],
    columns: [['i', 1, 1, 6, 18], ['b', 9, 1, 13, 18], ['e', 24, 1, 7, 18]],
    'editor-top': [['i', 1, 1, 7, 18], ['e', 10, 1, 21, 8], ['b', 10, 11, 21, 8]],
  };
  return (
    <svg className="preset-thumb" viewBox="0 0 32 20" aria-hidden>
      {b[id].map(([k, x, y, w, h], i) => <rect key={i} className={k} x={x} y={y} width={w} height={h} rx={1.5} />)}
    </svg>
  );
}

/** Zoom-bar button: pick a preset layout (and how to move frames by hand). */
export function LayoutMenu({ frames, setFrames }: { frames: FrameLayout; setFrames: (l: FrameLayout) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = presetOf(frames);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="layout-menu" ref={ref}>
      <button className={`ibtn${open ? ' on' : ''}`} title="Layout: arrange Ideas, the board and the editor" aria-label="Layout" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="layout" />
      </button>
      {open && (
        <div className="layout-pop island" role="menu" aria-label="Layouts">
          {PRESET_IDS.map((id) => (
            <button
              key={id} role="menuitemradio" aria-checked={cur === id} className={cur === id ? 'on' : ''} title={PRESETS[id].hint}
              onClick={() => {
                setFrames(PRESETS[id].layout);
                setOpen(false);
              }}
            >
              <PresetThumb id={id} />
              <span>{PRESETS[id].label}</span>
            </button>
          ))}
          <p className="layout-tip">Drag a frame by its title to move it. Drop it on another frame's edge to dock it there.</p>
        </div>
      )}
    </div>
  );
}
