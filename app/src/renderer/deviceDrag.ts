// Drag a device card by its title bar to reorder the chain. The card stays put and dims while a
// line shows where it will land (as region moves do); release commits one move_device.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

type Box = { left: number; right: number; top: number; bottom: number };
type Line = { left: number; top: number; width: number; height: number };
type Run = (tool: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Half of .fx-chain's 14 px gap: the line sits midway between two cards. */
const LINE_OFFSET = 7;
const LINE_WIDTH = 3;
/** Pointer travel before a press on the title bar counts as a drag. */
const DRAG_START_PX = 4;

/** The gap (0 = before the first card) under a pointer, and the line to draw for it. Cards wrap,
 *  so the row is chosen first: the last one starting above the pointer. A narrow panel stacks them
 *  in one column, where only above or below means anything. */
export function dropTarget(cards: Box[], x: number, y: number): { gap: number; line: Line } {
  const rows: number[][] = [];
  cards.forEach((c, i) => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cards[row[0]].top - c.top) < 1) row.push(i);
    else rows.push([i]);
  });
  const row = [...rows].reverse().find((r) => cards[r[0]].top <= y) ?? rows[0];
  if (rows.length > 1 && rows.every((r) => r.length === 1)) {
    const card = cards[row[0]];
    const gap = y < (card.top + card.bottom) / 2 ? row[0] : row[0] + 1;
    const lineY = gap === row[0] ? card.top - LINE_OFFSET : card.bottom + LINE_OFFSET;
    return { gap, line: { left: card.left, top: lineY - LINE_WIDTH / 2, width: card.right - card.left, height: LINE_WIDTH } };
  }
  const before = row.find((i) => x < (cards[i].left + cards[i].right) / 2);
  const gap = before ?? row[row.length - 1] + 1;
  const lineX = before === row[0] ? cards[gap].left - LINE_OFFSET : cards[gap - 1].right + LINE_OFFSET;
  const top = cards[row[0]].top;
  return { gap, line: { left: lineX - LINE_WIDTH / 2, top, width: LINE_WIDTH, height: Math.max(...row.map((i) => cards[i].bottom)) - top } };
}

/** move_device's index for dropping card `from` into `gap`; null if it would not move. */
export function movePosition(from: number, gap: number): number | null {
  const position = gap > from ? gap - 1 : gap;
  return position === from ? null : position;
}

export function useDeviceDrag(chainRef: RefObject<HTMLDivElement | null>, trackId: string, run: Run) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onHeadPointerDown = (e: ReactPointerEvent, deviceId: string, index: number) => {
    const chain = chainRef.current;
    if (!chain || e.button !== 0 || (e.target as HTMLElement).closest('button, input, label, select')) return;
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    let position: number | null = null;

    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START_PX) return;
      if (!active) setDragging(deviceId);
      active = true;
      const cards = [...chain.querySelectorAll<HTMLElement>(':scope > .fx-device')].map((el) => el.getBoundingClientRect());
      const t = dropTarget(cards, ev.clientX, ev.clientY);
      position = movePosition(index, t.gap);
      const origin = chain.getBoundingClientRect();
      setLine(position === null ? null : { ...t.line, left: t.line.left - origin.left, top: t.line.top - origin.top });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', key, true);
      stop.current = null;
      setDragging(null);
      setLine(null);
    };
    const up = () => {
      end();
      if (position !== null) run('move_device', { track_id: trackId, device_id: deviceId, position });
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !active) return;
      ev.stopPropagation();
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', key, true);
    stop.current = end;
  };

  return { dragging, line, onHeadPointerDown };
}
