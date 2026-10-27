import { describe, expect, it } from 'vitest';
import { shortcutFor } from '../src/renderer/shortcuts';

const key = (k: string, extra: Partial<{ shiftKey: boolean; metaKey: boolean; tag: string }> = {}) => ({
  key: k,
  shiftKey: !!extra.shiftKey,
  metaKey: !!extra.metaKey,
  ctrlKey: false,
  altKey: false,
  target: extra.tag ? ({ tagName: extra.tag.toUpperCase(), isContentEditable: false } as unknown as EventTarget) : null,
});

describe('key commands', () => {
  it('maps Logic/GarageBand keys', () => {
    expect(shortcutFor(key(' '))).toBe('playStop');
    expect(shortcutFor(key('Enter'))).toBe('goToStart');
    expect(shortcutFor(key('r'))).toBe('record');
    expect(shortcutFor(key('k'))).toBe('metronome');
    expect(shortcutFor(key('K', { shiftKey: true }))).toBe('countIn');
    expect(shortcutFor(key('c'))).toBe('cycle');
    expect(shortcutFor(key(','))).toBe('barBack');
    expect(shortcutFor(key('x'))).toBeNull();
  });

  it('ignores typing and modifier combos', () => {
    expect(shortcutFor(key(' ', { tag: 'textarea' }))).toBeNull();
    expect(shortcutFor(key('Enter', { tag: 'input' }))).toBeNull();
    expect(shortcutFor(key('k', { tag: 'select' }))).toBeNull();
    expect(shortcutFor(key('r', { metaKey: true }))).toBeNull();
    expect(shortcutFor(key(' ', { tag: 'button' }))).toBe('playStop');
  });
});
