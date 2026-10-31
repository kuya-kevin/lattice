// Resizable canvas layout: drag handles for the Ideas column (or strip) width, the Arrangement
// board's width and height, the editor area's width and the region editor's height (its bottom
// edge), plus the track lane height (vertical zoom). Where the frames sit is Frames.tsx.
// Sizes persist in localStorage when it is there; the app works the same without it.
import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './icons';
import './Resizable.css';

export type LayoutSizes = {
  ideasW: number; // Ideas column width (px)
  boardW: number | null; // Arrangement board width (px); null = fill the space left
  boardH: number | null; // board height above the device chain (px); null = fit the tracks
  editorH: number | null; // Piano Roll / Audio Editor height (px); null = their own default
  editorW: number | null; // editor area width (px); null = the width of the frame it sits above or below
  ideasStripW: number | null; // Ideas as a strip (px); null = the width of the frame it sits above or below
  waveHeight: number; // waveform height per lane (px); the lane adds a 22 px region header
};

export const DEFAULT_SIZES: LayoutSizes = { ideasW: 264, boardW: null, boardH: null, editorH: null, editorW: null, ideasStripW: null, waveHeight: 84 };
export const LIMITS = {
  ideasW: [200, 520],
  boardW: [560, 3200],
  boardH: [180, 4000],
  editorH: [160, 1600],
  editorW: [360, 3200],
  ideasStripW: [400, 3200],
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
    const ideasW = num(raw.ideasW), boardW = num(raw.boardW), boardH = num(raw.boardH), editorH = num(raw.editorH), wave = num(raw.waveHeight);
    const editorW = num(raw.editorW), ideasStripW = num(raw.ideasStripW);
    return {
      ideasW: ideasW === null ? DEFAULT_SIZES.ideasW : clamp(ideasW, LIMITS.ideasW),
      boardW: boardW === null ? null : clamp(boardW, LIMITS.boardW),
      boardH: boardH === null ? null : clamp(boardH, LIMITS.boardH),
      editorH: editorH === null ? null : clamp(editorH, LIMITS.editorH),
      editorW: editorW === null ? null : clamp(editorW, LIMITS.editorW),
      ideasStripW: ideasStripW === null ? null : clamp(ideasStripW, LIMITS.ideasStripW),
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
    ...(sizes.editorH !== null ? { '--editor-h': `${sizes.editorH}px` } : {}),
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

/** Width handle on the Ideas frame's right edge: the column width, or the strip's. */
export function IdeasHandle({ layout, strip }: { layout: Layout; strip: boolean }) {
  const { set } = layout;
  return strip ? (
    <ResizeHandle
      axis="x" label="Resize ideas" className="rz-frame-w" testId="rz-ideas"
      start={(h) => h.parentElement!.getBoundingClientRect().width}
      onSize={(w) => set({ ideasStripW: clamp(w, LIMITS.ideasStripW) })}
      onReset={() => set({ ideasStripW: null })}
    />
  ) : (
    <ResizeHandle
      axis="x" label="Resize ideas" className="rz-frame-w" testId="rz-ideas"
      start={() => layout.sizes.ideasW}
      onSize={(w) => set({ ideasW: clamp(w, LIMITS.ideasW) })}
      onReset={() => set({ ideasW: DEFAULT_SIZES.ideasW })}
    />
  );
}

/** Width handle on the board frame's right edge. */
export function BoardWidthHandle({ layout }: { layout: Layout }) {
  return (
    <ResizeHandle
      axis="x" label="Resize arrangement width" className="rz-frame-w" testId="rz-board-w"
      start={(h) => h.parentElement!.getBoundingClientRect().width}
      onSize={(w) => layout.set({ boardW: clamp(w, LIMITS.boardW) })}
      onReset={() => layout.set({ boardW: null })}
    />
  );
}

/** Height handle under the board (in the gap below it): a set height scrolls the lanes. */
export function SplitHandle({ layout }: { layout: Layout }) {
  return (
    <ResizeHandle
      axis="y" label="Resize arrangement height" className="rz-frame-h" testId="rz-split"
      start={(h) => h.parentElement!.querySelector('.board')!.getBoundingClientRect().height}
      onSize={(hgt) => layout.set({ boardH: clamp(hgt, LIMITS.boardH) })} // a frame docked below moves down; the canvas grows
      onReset={() => layout.set({ boardH: null })}
    />
  );
}

/** Width handle on the editor frame's right edge. */
export function EditorWidthHandle({ layout }: { layout: Layout }) {
  return (
    <ResizeHandle
      axis="x" label="Resize editor width" className="rz-frame-w" testId="rz-editor-w"
      start={(h) => h.parentElement!.getBoundingClientRect().width}
      onSize={(w) => layout.set({ editorW: clamp(w, LIMITS.editorW) })}
      onReset={() => layout.set({ editorW: null })}
    />
  );
}

/** Handle on the region editor's bottom edge (Piano Roll or Audio Editor showing): drag it to
 *  make the editor taller or shorter, like the board above it. */
export function EditorHandle({ layout }: { layout: Layout }) {
  const editor = (h: HTMLElement) => h.parentElement?.querySelector<HTMLElement>('.piano-roll, .audio-editor');
  return (
    <ResizeHandle
      axis="y" label="Resize editor height" className="rz-frame-h" testId="rz-editor"
      start={(h) => editor(h)?.getBoundingClientRect().height ?? 320}
      onSize={(hgt) => layout.set({ editorH: clamp(hgt, LIMITS.editorH) })}
      onReset={() => layout.set({ editorH: null })}
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
