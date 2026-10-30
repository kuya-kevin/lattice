// B16: names for the track colour palette, so Muse can say and hear "the blue track". One name
// per slot of TRACK_COLORS in renderer/TrackHeader.tsx, same order (tests/editTools.test.ts
// checks the counts match).
export const TRACK_COLOR_NAMES = ['coral', 'yellow', 'green', 'blue', 'purple', 'teal', 'pink', 'lime'] as const;

const ALIASES: Record<string, string> = {
  red: 'coral', orange: 'coral', salmon: 'coral', amber: 'yellow', gold: 'yellow', violet: 'purple',
  lavender: 'purple', cyan: 'teal', turquoise: 'teal', rose: 'pink', olive: 'lime',
};

/** Palette slot for a colour name (or alias), or -1. */
export function colorSlot(name: string): number {
  const n = name.trim().toLowerCase();
  return (TRACK_COLOR_NAMES as readonly string[]).indexOf(ALIASES[n] ?? n);
}

/** The colour name of a track with palette slot `color` at position `index` (no slot = its position). */
export const colorName = (color: number | undefined, index: number) => TRACK_COLOR_NAMES[(color ?? index) % TRACK_COLOR_NAMES.length];
