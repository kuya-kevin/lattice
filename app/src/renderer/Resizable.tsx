// Resizable canvas layout: drag handles for the Ideas column width, the Arrangement board's
// width and the board / device chain split, plus the track lane height (vertical zoom).
// Sizes persist in localStorage when it is there; the app works the same without it.
import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './icons';

export type LayoutSizes = {
  ideasW: number; // Ideas column width (px)
  boardW: number | null; // Arrangement board width (px); null = fill the space left
  boardH: number | null; // board height above the device chain (px); null = fit the tracks
  waveHeight: number; // waveform height per lane (px); the lane adds a 22 px region header
};

export const DEFAULT_SIZES: LayoutSizes = { ideasW: 264, boardW: null, boardH: null, waveHeight: 84 };
export const LIMITS = {
  ideasW: [200, 520],
  boardW: [560, 3200],
  boardH: [180, 4000],
  waveHeight: [32, 192],
} as const;
/** Lane height steps for the toolbar's − / + (Option-scroll over the lanes is continuous). */
export const WAVE_STEPS = [32, 48, 64, 84, 112, 144, 192];
const KEY = 'lattice.layout.v1';

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.round(Math.min(hi, Math.max(lo, v)));

function load(): LayoutSizes {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_SIZES;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const ideasW = num(raw.ideasW), boardW = num(raw.boardW), boardH = num(raw.boardH), wave = num(raw.waveHeight);
    return {
      ideasW: ideasW === null ? DEFAULT_SIZES.ideasW : clamp(ideasW, LIMITS.ideasW),
      boardW: boardW === null ? null : clamp(boardW, LIMITS.boardW),
      boardH: boardH === null ? null : clamp(boardH, LIMITS.boardH),
      waveHeight: wave === null ? DEFAULT_SIZES.waveHeight : clamp(wave, LIMITS.waveHeight),
    };
  } catch {
    return DEFAULT_SIZES;
  }
}

/** Layout sizes + setters. Also handles Option-scroll over the lanes (vertical zoom). */
export function useLayoutSizes() {
  const [sizes, setSizes] = useState<LayoutSizes>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sizes));
    } catch {
      /* storage blocked: sizes just don't persist */
    }
  }, [sizes]);
  const set = (patch: Partial<LayoutSizes>) => setSizes((s) => ({ ...s, ...patch }));

  // Option/Alt + wheel over the arrangement: lane height, smooth on a trackpad
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey || !(e.target as Element | null)?.closest?.('.arrange')) return;
      e.preventDefault();
      const d = e.deltaY || e.deltaX;
      setSizes((s) => ({ ...s, waveHeight: clamp(s.waveHeight * Math.exp(-d * 0.004), LIMITS.waveHeight) }));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // CSS variables for the world; the board-col reads them (styles.css, "resizable layout")
  const worldStyle = {
    '--ideas-w': `${sizes.ideasW}px`,
    ...(sizes.boardW !== null ? { '--board-w': `${sizes.boardW}px` } : {}),
    ...(sizes.boardH !== null ? { '--board-h': `${sizes.boardH}px` } : {}),
  } as CSSProperties;
  return { sizes, set, worldStyle };
}

export type Layout = ReturnType<typeof useLayoutSizes>;

/** A drag handle. `start` reads the size being changed when the drag begins; `onSize` gets the
 *  start size plus the pointer travel. Double-click calls `onReset`. Pointer events stop here,
 *  so a handle never starts a canvas pan or a region drag. */
export function ResizeHandle({ axis, label, className, testId, start, onSize, onReset }: {
  axis: 'x' | 'y';
  label: string;
  className: string;
  testId: string;
  start: (handle: HTMLElement) => number;
  onSize: (size: number, handle: HTMLElement) => void;
  onReset: () => void;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const from = start(el);
    const origin = axis === 'x' ? e.clientX : e.clientY;
    el.classList.add('active');
    document.documentElement.classList.add(`rz-drag-${axis}`);
    const move = (ev: PointerEvent) => onSize(from + (axis === 'x' ? ev.clientX : ev.clientY) - origin, el);
    const up = () => {
      el.classList.remove('active');
      document.documentElement.classList.remove(`rz-drag-${axis}`);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`rz rz-${axis} ${className}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label} (double-click to reset)`}
      data-testid={testId}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        // arrow keys nudge by 16 px (Shift: 64); Enter resets, like the double-click
        const dir = { x: { ArrowLeft: -1, ArrowRight: 1 }, y: { ArrowUp: -1, ArrowDown: 1 } }[axis][e.key as 'ArrowLeft'];
        if (e.key === 'Enter') onReset();
        else if (dir) onSize(start(e.currentTarget) + dir * (e.shiftKey ? 64 : 16), e.currentTarget);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
    />
  );
}

/** The three panel handles. Rendered inside .board-col: the Ideas and board-width handles sit
 *  on its left and right edges, the split handle between the board and the device chain. */
export function ColumnHandles({ layout, ideas }: { layout: Layout; ideas: boolean }) {
  const { set } = layout;
  return (
    <>
      {ideas && (
        <ResizeHandle
          axis="x" label="Resize ideas" className="rz-ideas" testId="rz-ideas"
          start={() => layout.sizes.ideasW}
          onSize={(w) => set({ ideasW: clamp(w, LIMITS.ideasW) })}
          onReset={() => set({ ideasW: DEFAULT_SIZES.ideasW })}
        />
      )}
      <ResizeHandle
        axis="x" label="Resize arrangement width" className="rz-board-w" testId="rz-board-w"
        start={(h) => h.parentElement!.getBoundingClientRect().width}
        onSize={(w) => set({ boardW: clamp(w, LIMITS.boardW) })}
        onReset={() => set({ boardW: null })}
      />
    </>
  );
}

/** Handle between the board and the device chain (only while the chain is showing). */
export function SplitHandle({ layout }: { layout: Layout }) {
  return (
    <ResizeHandle
      axis="y" label="Resize arrangement height" className="rz-split" testId="rz-split"
      start={(h) => (h.previousElementSibling as HTMLElement).getBoundingClientRect().height}
      onSize={(hgt) => layout.set({ boardH: clamp(hgt, LIMITS.boardH) })} // the chain below moves down; the canvas grows
      onReset={() => layout.set({ boardH: null })}
    />
  );
}

/** Toolbar control: lane height − / +, snapping to WAVE_STEPS. */
export function LaneHeightControl({ layout }: { layout: Layout }) {
  const h = layout.sizes.waveHeight;
  const down = [...WAVE_STEPS].reverse().find((s) => s < h);
  const up = WAVE_STEPS.find((s) => s > h);
  return (
    <div className="group" role="group" aria-label="Track height">
      <span className="tb-label" title="Track height (Option-scroll over the lanes)">Height</span>
      <div className="seg lane-h">
        <button aria-label="Shorter tracks" title="Shorter tracks (Option-scroll)" disabled={down === undefined} onClick={() => down !== undefined && layout.set({ waveHeight: down })}>
          <Icon name="minus" size={14} />
        </button>
        <button aria-label="Taller tracks" title="Taller tracks (Option-scroll)" disabled={up === undefined} onClick={() => up !== undefined && layout.set({ waveHeight: up })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
    </div>
  );
}
