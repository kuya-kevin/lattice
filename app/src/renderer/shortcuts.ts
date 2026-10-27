// Logic Pro / GarageBand-style key commands (see docs/ux-notes.md).

export type ShortcutAction = 'playStop' | 'goToStart' | 'record' | 'metronome' | 'countIn' | 'cycle' | 'barBack' | 'barForward';

export const SHORTCUTS: { keys: string; action: ShortcutAction; label: string }[] = [
  { keys: 'Space', action: 'playStop', label: 'Play / stop' },
  { keys: 'Return', action: 'goToStart', label: 'Go to beginning' },
  { keys: 'R', action: 'record', label: 'Record / stop recording' },
  { keys: 'K', action: 'metronome', label: 'Click on/off' },
  { keys: '⇧K', action: 'countIn', label: 'Count-in on/off' },
  { keys: 'C', action: 'cycle', label: 'Cycle on/off' },
  { keys: ', / .', action: 'barBack', label: 'Back / forward one bar' },
];

interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** True while the user is typing somewhere (inputs, the chat box, selects, editable text). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return null;
  switch (e.key) {
    case ' ':
      return 'playStop';
    case 'Enter':
      return 'goToStart';
    case 'r':
    case 'R':
      return 'record';
    case 'k':
      return 'metronome';
    case 'K':
      return e.shiftKey ? 'countIn' : 'metronome';
    case 'c':
    case 'C':
      return 'cycle';
    case ',':
      return 'barBack';
    case '.':
      return 'barForward';
    default:
      return null;
  }
}
