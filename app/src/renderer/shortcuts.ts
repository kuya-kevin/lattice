// Logic Pro / GarageBand-style key commands (see docs/ux-notes.md).
import { claimsKey } from '../core/musicalTyping';

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
  code?: string; // physical key, for Musical Typing
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** Input types that don't take text: key commands still apply while one has focus. */
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** True while the user is typing somewhere (text inputs, the chat box, editable text). A
 *  focused button, slider or select is not typing: Space there plays/stops instead of
 *  pressing the button or opening the menu (e.g. "+ Add device…"). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase());
  return tag === 'textarea' || el.isContentEditable === true;
}

// While Musical Typing is on (MusicalTyping.tsx sets this) the letter keys play notes.
let musicalTyping = false;
export function setMusicalTypingKeys(on: boolean) {
  musicalTyping = on;
}

export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return null;
  if (musicalTyping && claimsKey(e)) return null;
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

export type EditAction = 'undo' | 'redo' | 'deleteClip' | 'copyClip' | 'pasteClip' | 'toggleLibrary' | 'toggleSmartControls' | 'toggleSnap' | 'musicalTyping';

export const EDIT_SHORTCUTS: { keys: string; action: EditAction; label: string }[] = [
  { keys: '⌘Z', action: 'undo', label: 'Undo' },
  { keys: '⇧⌘Z', action: 'redo', label: 'Redo' },
  { keys: 'Delete', action: 'deleteClip', label: 'Delete selected region' },
  { keys: '⌘C', action: 'copyClip', label: 'Copy selected region' },
  { keys: '⌘V', action: 'pasteClip', label: 'Paste region at the playhead on the selected track' },
  { keys: 'O', action: 'toggleLibrary', label: 'Show/hide the sound library (Loop Browser)' },
  { keys: 'B', action: 'toggleSmartControls', label: 'Show/hide Smart Controls' },
  { keys: '⌘G', action: 'toggleSnap', label: 'Snap to grid on/off (GarageBand)' },
  { keys: '⌘K', action: 'musicalTyping', label: 'Musical Typing on/off (letter keys play notes)' },
];

/** Cmd (Mac) or Ctrl (elsewhere) for undo/redo/copy/paste/snap; plain letters only without modifiers. */
export function editShortcutFor(e: KeyLike): EditAction | null {
  if (isTyping(e.target) || e.altKey) return null;
  const cmd = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (cmd) {
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y' && e.ctrlKey) return 'redo'; // Windows/Linux habit
    if (k === 'g') return 'toggleSnap';
    if (k === 'k' && !e.shiftKey) return 'musicalTyping';
    if (k === 'c' && !e.shiftKey) return 'copyClip';
    if (k === 'v' && !e.shiftKey) return 'pasteClip';
    return null;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') return 'deleteClip';
  if (musicalTyping && claimsKey(e)) return null;
  if (e.shiftKey) return null;
  if (k === 'o') return 'toggleLibrary';
  if (k === 'b') return 'toggleSmartControls';
  return null;
}
