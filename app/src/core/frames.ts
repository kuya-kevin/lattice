// Movable frames: the Ideas column, the Arrangement board and the editor area (device chain,
// region editor, mixer) are frames on the canvas, like Miro frames. Each one is either placed
// freely (x, y) or docked to a side of another frame, so it follows that frame as it grows or
// moves. Pure: the renderer measures the frames and draws them where resolveFrames() says.
// The layout is app-wide (the renderer keeps it in localStorage) and mirrored in the session so
// Muse sees it and can change it (set_layout).

export type FrameId = 'ideas' | 'board' | 'editor';
export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Place = { dock: FrameId; side: Side } | { x: number; y: number };
export type IdeasShape = 'column' | 'strip';

export interface FrameLayout {
  ideas: Place;
  board: Place;
  editor: Place;
  /** a column of cards, or a strip that scrolls sideways (above or below another frame) */
  ideasShape: IdeasShape;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }

export const FRAME_IDS: FrameId[] = ['board', 'editor', 'ideas']; // anchors first
export const GAP_X = 56; // between frames side by side (the resize handle sits in it)
export const GAP_Y = 28; // between frames stacked (the height handle sits in it)

export const PRESET_IDS = ['ideas-left', 'ideas-right', 'ideas-top', 'columns', 'editor-top'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const PRESETS: Record<PresetId, { label: string; hint: string; layout: FrameLayout }> = {
  'ideas-left': {
    label: 'Ideas left',
    hint: 'Ideas on the left, editor under the board',
    layout: { board: { x: 0, y: 0 }, ideas: { dock: 'board', side: 'left' }, editor: { dock: 'board', side: 'bottom' }, ideasShape: 'column' },
  },
  'ideas-right': {
    label: 'Ideas right',
    hint: 'Ideas on the right, next to the library',
    layout: { board: { x: 0, y: 0 }, ideas: { dock: 'board', side: 'right' }, editor: { dock: 'board', side: 'bottom' }, ideasShape: 'column' },
  },
  'ideas-top': {
    label: 'Ideas on top',
    hint: 'Ideas as a strip above the board',
    layout: { board: { x: 0, y: 0 }, ideas: { dock: 'board', side: 'top' }, editor: { dock: 'board', side: 'bottom' }, ideasShape: 'strip' },
  },
  columns: {
    label: 'Three columns',
    hint: 'Ideas, board and a tall editor side by side',
    layout: { board: { x: 0, y: 0 }, ideas: { dock: 'board', side: 'left' }, editor: { dock: 'board', side: 'right' }, ideasShape: 'column' },
  },
  'editor-top': {
    label: 'Editor on top',
    hint: 'Editor above the board, Ideas on the left',
    layout: { board: { x: 0, y: 0 }, editor: { dock: 'board', side: 'top' }, ideas: { dock: 'editor', side: 'left' }, ideasShape: 'column' },
  },
};

export const DEFAULT_FRAMES: FrameLayout = PRESETS['ideas-left'].layout;

const isDock = (p: Place): p is { dock: FrameId; side: Side } => 'dock' in p;
const overlaps = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Is `frame` docked (directly or through others) to `to`? */
export function dependsOn(l: FrameLayout, frame: FrameId, to: FrameId): boolean {
  const seen = new Set<FrameId>();
  for (let p = l[frame]; isDock(p) && !seen.has(p.dock); p = l[p.dock]) {
    if (p.dock === to) return true;
    seen.add(p.dock);
  }
  return false;
}

/** Frames that move with `frame` (docked to it, directly or through others). */
export function dependents(l: FrameLayout, frame: FrameId): FrameId[] {
  return FRAME_IDS.filter((f) => f !== frame && dependsOn(l, f, frame));
}

/** Where the frames go, given their sizes. Rects are in layout space; `origin` is the top-left
 *  of everything, so the renderer draws a frame at (r.x - origin.x, r.y - origin.y). Two frames
 *  never overlap: one docked on a taken side lines up after the frame already there, and a free
 *  frame in the way of another moves right of it. A frame with no size (hidden) takes no room. */
export function resolveFrames(l: FrameLayout, sizes: Record<FrameId, Size>): { rects: Record<FrameId, Rect>; origin: { x: number; y: number }; extent: Size } {
  const rects = {} as Record<FrameId, Rect>;
  const order: FrameId[] = [];
  const place = (f: FrameId, stack: FrameId[] = []): Rect => {
    if (rects[f]) return rects[f];
    const { w, h } = sizes[f];
    const p = l[f];
    let r: Rect;
    if (isDock(p) && !stack.includes(p.dock) && p.dock !== f) {
      const a = place(p.dock, [...stack, f]);
      const gx = w && a.w ? GAP_X : 0, gy = h && a.h ? GAP_Y : 0;
      r = p.side === 'left' ? { x: a.x - gx - w, y: a.y, w, h }
        : p.side === 'right' ? { x: a.x + a.w + gx, y: a.y, w, h }
        : p.side === 'top' ? { x: a.x, y: a.y - gy - h, w, h }
        : { x: a.x, y: a.y + a.h + gy, w, h };
    } else {
      r = isDock(p) ? { x: 0, y: 0, w, h } : { x: p.x, y: p.y, w, h };
    }
    // clear the frames placed before this one
    for (let guard = 0; guard < 8; guard++) {
      const hit = order.map((o) => rects[o]).find((o) => overlaps(r, o));
      if (!hit) break;
      if (isDock(p) && (p.side === 'left' || p.side === 'right')) r = { ...r, y: hit.y + hit.h + GAP_Y };
      else r = { ...r, x: hit.x + hit.w + GAP_X };
    }
    rects[f] = r;
    order.push(f);
    return r;
  };
  FRAME_IDS.forEach((f) => place(f));
  const shown = FRAME_IDS.map((f) => rects[f]).filter((r) => r.w > 0 && r.h > 0);
  const all = shown.length ? shown : [rects.board];
  const x0 = Math.min(...all.map((r) => r.x)), y0 = Math.min(...all.map((r) => r.y));
  const x1 = Math.max(...all.map((r) => r.x + r.w)), y1 = Math.max(...all.map((r) => r.y + r.h));
  return { rects, origin: { x: x0, y: y0 }, extent: { w: x1 - x0, h: y1 - y0 } };
}

/** Dock `frame` on `side` of `to`. A frame `to` was docked to (directly or through others) is
 *  set free where it is, so docking never makes a loop. Ideas turn into a strip above or below
 *  a frame and a column beside one. */
export function dockFrame(l: FrameLayout, frame: FrameId, to: FrameId, side: Side, rects?: Record<FrameId, Rect>): FrameLayout {
  if (frame === to) return l;
  let next: FrameLayout = { ...l, [frame]: { dock: to, side } };
  if (dependsOn(l, to, frame)) {
    const r = rects?.[to];
    next = { ...next, [to]: r ? { x: r.x, y: r.y } : { x: 0, y: 0 } };
  }
  if (frame === 'ideas') next.ideasShape = side === 'top' || side === 'bottom' ? 'strip' : 'column';
  return next;
}

/** Place `frame` freely with its top-left at (x, y) in layout space. Frames docked to it stay docked. */
export function freeFrame(l: FrameLayout, frame: FrameId, x: number, y: number): FrameLayout {
  return { ...l, [frame]: { x: Math.round(x), y: Math.round(y) } };
}

/** The dock zone under the pointer while dragging `frame`: a band along each side of every other
 *  shown frame, reaching `reach` px out and a little way in. The nearest edge wins. */
export function dockTarget(frame: FrameId, p: { x: number; y: number }, rects: Record<FrameId, Rect>, reach = 72): { to: FrameId; side: Side } | null {
  let best: { to: FrameId; side: Side; d: number } | null = null;
  const inward = 28;
  for (const to of FRAME_IDS) {
    const r = rects[to];
    if (to === frame || !r || r.w <= 0 || r.h <= 0) continue;
    const inY = p.y >= r.y && p.y <= r.y + r.h, inX = p.x >= r.x && p.x <= r.x + r.w;
    const cand: [Side, number, boolean][] = [
      ['left', r.x - p.x, inY],
      ['right', p.x - (r.x + r.w), inY],
      ['top', r.y - p.y, inX],
      ['bottom', p.y - (r.y + r.h), inX],
    ];
    for (const [side, d, along] of cand) {
      if (!along || d > reach || d < -inward) continue;
      if (!best || Math.abs(d) < best.d) best = { to, side, d: Math.abs(d) };
    }
  }
  return best && { to: best.to, side: best.side };
}

/** The rect a frame docked on `side` of `to` would take (for the drop preview). */
export function dockPreview(size: Size, to: Rect, side: Side): Rect {
  const { w, h } = size;
  return side === 'left' ? { x: to.x - GAP_X - w, y: to.y, w, h }
    : side === 'right' ? { x: to.x + to.w + GAP_X, y: to.y, w, h }
    : side === 'top' ? { x: to.x, y: to.y - GAP_Y - h, w, h }
    : { x: to.x, y: to.y + to.h + GAP_Y, w, h };
}

/** Snap a dragged rect's edges and centre to the other frames' edges and centres (within `tol`
 *  px), Figma / Miro style; returns the snapped position and the guide lines to draw. */
export function snapRect(r: Rect, others: Rect[], tol = 8): { x: number; y: number; guides: Guide[] } {
  const shown = others.filter((o) => o.w > 0 && o.h > 0);
  const axis = (pos: number, size: number, lines: number[]) => {
    let best: { d: number; at: number } | null = null;
    for (const mine of [pos, pos + size / 2, pos + size]) {
      for (const at of lines) {
        const d = at - mine;
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at };
      }
    }
    return best;
  };
  const sx = axis(r.x, r.w, shown.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w]));
  const sy = axis(r.y, r.h, shown.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]));
  const x = r.x + (sx?.d ?? 0), y = r.y + (sy?.d ?? 0);
  const guides: Guide[] = [];
  const span = (lo: number[], hi: number[]) => ({ from: Math.min(...lo), to: Math.max(...hi) });
  if (sx) guides.push({ axis: 'x', at: sx.at, ...span([y, ...shown.map((o) => o.y)], [y + r.h, ...shown.map((o) => o.y + o.h)]) });
  if (sy) guides.push({ axis: 'y', at: sy.at, ...span([x, ...shown.map((o) => o.x)], [x + r.w, ...shown.map((o) => o.x + o.w)]) });
  return { x, y, guides };
}

/** The nearest spot for `r` that overlaps none of `others` (it moves the shortest way out). */
export function clearSpot(r: Rect, others: Rect[]): { x: number; y: number } {
  const shown = others.filter((o) => o.w > 0 && o.h > 0);
  const free = (c: Rect) => !shown.some((o) => overlaps(c, o));
  if (free(r)) return { x: r.x, y: r.y };
  const cands: Rect[] = [];
  for (const o of shown) {
    cands.push({ ...r, x: o.x - GAP_X - r.w }, { ...r, x: o.x + o.w + GAP_X }, { ...r, y: o.y - GAP_Y - r.h }, { ...r, y: o.y + o.h + GAP_Y });
  }
  const ok = cands.filter(free).sort((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y));
  const c = ok[0] ?? { ...r, x: Math.max(...shown.map((o) => o.x + o.w)) + GAP_X };
  return { x: c.x, y: c.y };
}

/** A well-formed layout from untrusted input (storage, a tool call), or null. */
export function parseFrames(v: unknown): FrameLayout | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const place = (p: unknown): Place | null => {
    if (!p || typeof p !== 'object') return null;
    const q = p as Record<string, unknown>;
    if (typeof q.dock === 'string' && (FRAME_IDS as string[]).includes(q.dock) && ['left', 'right', 'top', 'bottom'].includes(q.side as string)) return { dock: q.dock as FrameId, side: q.side as Side };
    if (typeof q.x === 'number' && typeof q.y === 'number' && Number.isFinite(q.x) && Number.isFinite(q.y)) return { x: Math.round(q.x), y: Math.round(q.y) };
    return null;
  };
  const ideas = place(o.ideas), board = place(o.board), editor = place(o.editor);
  if (!ideas || !board || !editor) return null;
  const l: FrameLayout = { ideas, board, editor, ideasShape: o.ideasShape === 'strip' ? 'strip' : 'column' };
  // a loop of docks (only from hand-written input): free the board
  return FRAME_IDS.some((f) => dependsOn(l, f, f)) ? { ...l, board: { x: 0, y: 0 } } : l;
}

const frameKey = (l: FrameLayout | undefined) => (l ? JSON.stringify([...FRAME_IDS.map((f) => l[f]), l.ideasShape], ['dock', 'side', 'x', 'y']) : 'null');
export const sameFrames = (a: FrameLayout | undefined, b: FrameLayout | undefined) => frameKey(a) === frameKey(b);

/** Which preset a layout is, if any. */
export function presetOf(l: FrameLayout): PresetId | null {
  return PRESET_IDS.find((id) => sameFrames(PRESETS[id].layout, l)) ?? null;
}

const NAMES: Record<FrameId, string> = { ideas: 'Ideas', board: 'Arrangement board', editor: 'editor area (device chain / region editor / mixer)' };
const SIDE: Record<Side, string> = { left: 'left of', right: 'right of', top: 'above', bottom: 'below' };

/** The line Muse sees: where each frame is on screen. */
export function framesLine(l: FrameLayout | undefined): string {
  if (!l) return '';
  const where = (f: FrameId) => {
    const p = l[f];
    return isDock(p) ? `${SIDE[p.side]} the ${NAMES[p.dock].split(' (')[0]}` : 'placed freely';
  };
  const preset = presetOf(l);
  const parts = (['ideas', 'editor', 'board'] as FrameId[])
    .filter((f) => f !== 'board' || isDock(l.board))
    .map((f) => `${NAMES[f]} ${where(f)}${f === 'ideas' ? ` (${l.ideasShape})` : ''}`);
  return `Screen layout${preset ? ` "${preset}"` : ''}: ${parts.join('; ')}. set_layout moves them.`;
}
