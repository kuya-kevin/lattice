// Stroke icons for the canvas chrome (24px grid, currentColor).
import type { ReactElement, SVGProps } from 'react';

const P: Record<string, ReactElement> = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />,
  rec: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  start: <><path d="M6 5v14" /><path d="M18 6v12l-9-6z" fill="currentColor" stroke="none" /></>,
  cycle: <><path d="M17 3l3 3-3 3" /><path d="M4 12V9a3 3 0 0 1 3-3h13" /><path d="M7 21l-3-3 3-3" /><path d="M20 12v3a3 3 0 0 1-3 3H4" /></>,
  metro: <><path d="M9 3h6l4 18H5z" /><path d="M12 15l5-8" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>,
  library: <path d="M5 4v16M10 4v16M15 5l4 15" />,
  knob: <><circle cx="12" cy="12" r="7" /><path d="M12 12l3-4" /></>,
  spark: <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" fill="currentColor" stroke="none" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>,
  speaker: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" /></>,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  import: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></>,
  magnet: <><path d="M6 4v8a6 6 0 0 0 12 0V4" /><path d="M6 8h4M14 8h4" /></>,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chev: <path d="M6 9l6 6 6-6" />,
  roll: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h4M10 13h5M13 17h4" /></>,
  mixer: <><path d="M6 4v16M12 4v16M18 4v16" /><path d="M4 14h4M10 8h4M16 12h4" /></>,
  keys: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M8 6v7M12 6v7M16 6v7" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {P[name]}
    </svg>
  );
}
