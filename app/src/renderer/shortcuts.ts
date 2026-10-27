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

// ---- edit and window key commands (handled in App; Logic Pro defaults unless noted) ----

export type EditAction = 'undo' | 'redo' | 'deleteClip' | 'toggleLibrary' | 'toggleSmartControls' | 'toggleSnap';

export const EDIT_SHORTCUTS: { keys: string; action: EditAction; label: string }[] = [
  { keys: '⌘Z', action: 'undo', label: 'Undo' },
  { keys: '⇧⌘Z', action: 'redo', label: 'Redo' },
  { keys: 'Delete', action: 'deleteClip', label: 'Delete selected region' },
  { keys: 'O', action: 'toggleLibrary', label: 'Show/hide the sound library (Loop Browser)' },
  { keys: 'B', action: 'toggleSmartControls', label: 'Show/hide Smart Controls' },
  { keys: '⌘G', action: 'toggleSnap', label: 'Snap to grid on/off (GarageBand)' },
];

/** Cmd (Mac) or Ctrl (elsewhere) for undo/redo/snap; plain letters only without modifiers. */
export function editShortcutFor(e: KeyLike): EditAction | null {
  if (isTyping(e.target) || e.altKey) return null;
  const cmd = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (cmd) {
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y' && e.ctrlKey) return 'redo'; // Windows/Linux habit
    if (k === 'g') return 'toggleSnap';
    return null;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') return 'deleteClip';
  if (e.shiftKey) return null;
  if (k === 'o') return 'toggleLibrary';
  if (k === 'b') return 'toggleSmartControls';
  return null;
}
