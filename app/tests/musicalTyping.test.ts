import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_RANGE,
  DEFAULT_BASE,
  DEFAULT_VELOCITY,
  claimsKey,
  keyAction,
  pitchAt,
  rangeLabel,
  shiftOctave,
  stepVelocity,
  takeToNotes,
} from '../src/core/musicalTyping';
import { editShortcutFor, setMusicalTypingKeys, shortcutFor } from '../src/renderer/shortcuts';

const note = (code: string, base = DEFAULT_BASE) => {
  const a = keyAction(code);
  return a?.type === 'note' ? pitchAt(base, a.offset) : null;
};

describe('musical typing key map', () => {
  it('plays Logic\'s layout from middle C by physical key', () => {
    expect(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'].map((c) => note(c))).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77,
    ]);
    expect(['KeyW', 'KeyE', 'KeyT', 'KeyY', 'KeyU', 'KeyO', 'KeyP'].map((c) => note(c))).toEqual([61, 63, 66, 68, 70, 73, 75]);
    expect(keyAction('KeyR')).toBeNull();
    expect(keyAction('Space')).toBeNull();
    expect(rangeLabel(DEFAULT_BASE)).toBe('C4–F5');
  });

  it('shifts octaves with Z/X inside C0..C8', () => {
    expect(keyAction('KeyZ')).toEqual({ type: 'octave', delta: -1 });
    expect(keyAction('KeyX')).toEqual({ type: 'octave', delta: 1 });
    expect(note('KeyA', shiftOctave(DEFAULT_BASE, 1))).toBe(72);
    expect(note('KeyW', shiftOctave(DEFAULT_BASE, -2))).toBe(37);
    let b = DEFAULT_BASE;
    for (let i = 0; i < 20; i++) b = shiftOctave(b, -1);
    expect(b).toBe(BASE_RANGE[0]);
    for (let i = 0; i < 20; i++) b = shiftOctave(b, 1);
    expect(b).toBe(BASE_RANGE[1]);
    expect(note('Quote', b)).toBeLessThanOrEqual(127);
  });

  it('steps velocity with C/V along a ladder', () => {
    expect(keyAction('KeyC')).toEqual({ type: 'velocity', delta: -1 });
    expect(keyAction('KeyV')).toEqual({ type: 'velocity', delta: 1 });
    expect(stepVelocity(DEFAULT_VELOCITY, 1)).toBe(120);
    expect(stepVelocity(120, 1)).toBe(127);
    expect(stepVelocity(127, 1)).toBe(127);
    expect(stepVelocity(DEFAULT_VELOCITY, -1)).toBe(80);
    expect(stepVelocity(20, -1)).toBe(1);
    expect(stepVelocity(1, -1)).toBe(1);
    expect(stepVelocity(90, 1)).toBe(100);
  });

  it('claims plain letters (except R, Record), ; \' and Tab, not Space, Return, , . or Cmd combos', () => {
    const k = (code: string, key = '', mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
      code, key, metaKey: false, ctrlKey: false, altKey: false, ...mods,
    });
    for (const c of ['KeyK', 'KeyC', 'KeyO', 'KeyB', 'KeyA', 'Semicolon', 'Quote', 'Tab']) expect(claimsKey(k(c))).toBe(true);
    for (const c of ['KeyR', 'Space', 'Enter', 'Comma', 'Period', 'Delete', 'Backspace']) expect(claimsKey(k(c))).toBe(false);
    expect(claimsKey(k('KeyK', 'k', { metaKey: true }))).toBe(false);
    expect(claimsKey({ key: 'k', metaKey: false, ctrlKey: false, altKey: false })).toBe(true); // no code: falls back to key
    expect(claimsKey({ key: 'r', metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });
});

describe('shortcuts while musical typing is on', () => {
  const key = (k: string, code: string, extra: Partial<{ shiftKey: boolean; metaKey: boolean; tag: string }> = {}) => ({
    key: k,
    code,
    shiftKey: !!extra.shiftKey,
    metaKey: !!extra.metaKey,
    ctrlKey: false,
    altKey: false,
    target: extra.tag ? ({ tagName: extra.tag.toUpperCase(), isContentEditable: false } as unknown as EventTarget) : null,
  });
  afterEach(() => setMusicalTypingKeys(false));

  it('pauses single-letter commands and keeps R (record), Space, Return, bars and Cmd keys', () => {
    setMusicalTypingKeys(true);
    expect(shortcutFor(key('r', 'KeyR'))).toBe('record');
    expect(shortcutFor(key('k', 'KeyK'))).toBeNull();
    expect(shortcutFor(key('K', 'KeyK', { shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('c', 'KeyC'))).toBeNull();
    expect(editShortcutFor(key('o', 'KeyO'))).toBeNull();
    expect(editShortcutFor(key('b', 'KeyB'))).toBeNull();
    expect(shortcutFor(key(' ', 'Space'))).toBe('playStop');
    expect(shortcutFor(key('Enter', 'Enter'))).toBe('goToStart');
    expect(shortcutFor(key('.', 'Period'))).toBe('barForward');
    expect(editShortcutFor(key('z', 'KeyZ', { metaKey: true }))).toBe('undo');
    expect(editShortcutFor(key('k', 'KeyK', { metaKey: true }))).toBe('musicalTyping');
    expect(editShortcutFor(key('Backspace', 'Backspace'))).toBe('deleteClip');
  });

  it('gives the letters back when off; Cmd-K toggles either way but not while typing', () => {
    expect(shortcutFor(key('r', 'KeyR'))).toBe('record');
    expect(shortcutFor(key('c', 'KeyC'))).toBe('cycle');
    expect(editShortcutFor(key('o', 'KeyO'))).toBe('toggleLibrary');
    expect(editShortcutFor(key('k', 'KeyK', { metaKey: true }))).toBe('musicalTyping');
    expect(editShortcutFor(key('k', 'KeyK', { metaKey: true, tag: 'textarea' }))).toBeNull();
  });
});

describe('takeToNotes (for MIDI recording)', () => {
  it('makes take-relative notes, clips to the take and closes held notes', () => {
    const notes = takeToNotes(
      [
        { pitch: 60, velocity: 100, start: 1.5, end: 2 },
        { pitch: 64, velocity: 80, start: 0.5, end: 1.2 }, // starts before the take
        { pitch: 67, velocity: 90, start: 3, end: null }, // still held
        { pitch: 72, velocity: 90, start: 0, end: 0.5 }, // over before the take
      ],
      1,
      4,
    );
    expect(notes).toEqual([
      { pitch: 64, velocity: 80, start: 0, duration: 0.2 },
      { pitch: 60, velocity: 100, start: 0.5, duration: 0.5 },
      { pitch: 67, velocity: 90, start: 2, duration: 1 },
    ]);
  });
});
