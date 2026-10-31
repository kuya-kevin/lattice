import { useEffect, useLayoutEffect } from 'react';
import './Chrome.css';

/* Draggable chrome pills. Drag the transport, the tool rail, the project pill, the file actions or
 * the zoom bar by its empty background (the project pill is one button: drag the button) and it
 * stays there. Each pill keeps its CSS place and moves by a `translate` offset, kept per window in
 * localStorage (a view preference, not session state). A pill stays inside its zone, so it never
 * sits where the canvas content starts: the top pills in the top band (--top-h), the rail in the
 * right gutter (--gutter-r), the zoom bar below the top band. Dropped within 8 px of the window's
 * centre, a pill snaps there and stays centred when the window resizes. Double-click a pill's
 * background, or Layout > Reset pills, to put pills back. */

type Zone = 'top' | 'rail' | 'free';
type Pill = { id: string; sel: string; zone: Zone; grip?: string };
type Offset = { x: number; y: number; centre?: boolean };

const PILLS: Pill[] = [
  { id: 'project', sel: '.project-menu-wrap', zone: 'top', grip: '.session-pill' },
  { id: 'transport', sel: '.controlbar .transport', zone: 'top' },
  { id: 'actions', sel: '.controlbar .actions', zone: 'top' },
  { id: 'rail', sel: 'nav.rail', zone: 'rail' },
  { id: 'zoom', sel: '.zoombar', zone: 'free' },
];
/** Where a press starts that thing's own action, not a drag. */
const INTERACTIVE = 'button, input, select, textarea, a, label, [contenteditable], [role="menu"], [role="dialog"], [role="listbox"], .versions-menu';
const KEY = 'lattice.pills.v1';
const MARGIN = 4;
const SNAP = 8;

let offsets: Record<string, Offset> = load();
const applied = new Map<string, { x: number; y: number }>(); // the clamped offset on screen

function load(): Record<string, Offset> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {}; // storage blocked or garbled: pills where CSS puts them
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(offsets));
  } catch {
    // not remembered
  }
}

const px = (el: Element, name: string, fallback: number) => parseFloat(getComputedStyle(el).getPropertyValue(name)) || fallback;

/** The box a pill may occupy, in viewport px. */
function bounds(zone: Zone) {
  const W = innerWidth;
  const H = innerHeight;
  const topH = px(document.documentElement, '--top-h', 62);
  const lib = document.querySelector('.library-float:not([hidden])')?.getBoundingClientRect();
  const r = (lib ? lib.left : W) - MARGIN;
  if (zone === 'top') return { l: MARGIN, t: MARGIN, r: W - MARGIN, b: topH + 8 };
  const world = document.querySelector('.world');
  const gutter = world ? px(world, '--gutter-r', 104) : 104;
  if (zone === 'rail') return { l: W - gutter, t: topH, r, b: H - MARGIN };
  return { l: MARGIN, t: topH, r, b: H - MARGIN };
}

const clamp = (d: number, lo: number, hi: number) => (lo > hi ? 0 : Math.min(Math.max(d, lo), hi));

/** Where the pill sits with no offset. */
function baseRect(el: Element, id: string) {
  const r = el.getBoundingClientRect();
  const a = applied.get(id) ?? { x: 0, y: 0 };
  return { left: r.left - a.x, top: r.top - a.y, right: r.right - a.x, bottom: r.bottom - a.y, width: r.width };
}

function place(el: HTMLElement, pill: Pill, want: Offset) {
  const base = baseRect(el, pill.id);
  // the zone always holds the pill's own CSS spot (a narrow window wraps the top bar to two rows)
  const b = bounds(pill.zone);
  const z = { l: Math.min(b.l, base.left), t: Math.min(b.t, base.top), r: Math.max(b.r, base.right), b: Math.max(b.b, base.bottom) };
  const wx = want.centre ? innerWidth / 2 - (base.left + base.width / 2) : want.x;
  const x = Math.round(clamp(wx, z.l - base.left, z.r - base.right));
  const y = Math.round(clamp(want.y, z.t - base.top, z.b - base.bottom));
  el.style.translate = x || y ? `${x}px ${y}px` : '';
  applied.set(pill.id, { x, y });
}

const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => placeAll());
const watched = new WeakSet<Element>();

function placeAll() {
  for (const pill of PILLS) {
    const el = document.querySelector<HTMLElement>(pill.sel);
    if (!el) continue;
    if (observer && !watched.has(el)) (observer.observe(el), watched.add(el));
    place(el, pill, offsets[pill.id] ?? { x: 0, y: 0 });
  }
}

/** Layout > Reset pills. */
export function resetPills() {
  offsets = {};
  save();
  placeAll();
}

function pillAt(t: Element) {
  for (const pill of PILLS) {
    const el = t.closest<HTMLElement>(pill.sel);
    if (el) return { pill, el };
  }
  return null;
}

/** Mount once in App: keeps pills in place on every render and resize, and handles the drags. */
export function usePillDrag() {
  useLayoutEffect(placeAll);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      const hit = pillAt(t);
      if (!hit) return;
      const { pill, el } = hit;
      const grip = !!pill.grip && !!t.closest(pill.grip);
      if (!grip && t.closest(INTERACTIVE)) return;
      if (!grip) e.preventDefault(); // no text selection
      const start = { x: e.clientX, y: e.clientY };
      const from = applied.get(pill.id) ?? { x: 0, y: 0 };
      let want: Offset | null = null;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!want && Math.hypot(dx, dy) < 4) return;
        el.classList.add('pill-dragging');
        want = { x: from.x + dx, y: from.y + dy };
        const base = baseRect(el, pill.id);
        if (Math.abs(base.left + base.width / 2 + want.x - innerWidth / 2) <= SNAP) want.centre = true;
        place(el, pill, want);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('pill-dragging');
        if (!want) return;
        const a = applied.get(pill.id)!;
        offsets = { ...offsets, [pill.id]: { ...a, ...(want.centre ? { centre: true } : {}) } };
        save();
        if (grip) {
          // the drag ends on the button: its click must not open the menu
          const eat = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
          window.addEventListener('click', eat, true);
          setTimeout(() => window.removeEventListener('click', eat, true), 0);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    const onDouble = (e: MouseEvent) => {
      const t = e.target as Element;
      const hit = pillAt(t);
      if (!hit || t.closest(INTERACTIVE)) return;
      const { [hit.pill.id]: _, ...rest } = offsets;
      offsets = rest;
      save();
      place(hit.el, hit.pill, { x: 0, y: 0 });
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('dblclick', onDouble);
    window.addEventListener('resize', placeAll);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('dblclick', onDouble);
      window.removeEventListener('resize', placeAll);
    };
  }, []);
}
