import { describe, expect, it } from 'vitest';
import { dropTarget, movePosition } from '../src/renderer/deviceDrag';

const card = (left: number, top: number, height = 100) => ({ left, right: left + 300, top, bottom: top + height });

describe('dropTarget', () => {
  // two rows, cards of different heights, as a wrapped chain looks
  const cards = [card(0, 0, 400), card(314, 0, 200), card(628, 0, 300), card(0, 414), card(314, 414)];

  it('picks the gap by which half of a card the pointer is over', () => {
    expect(dropTarget(cards, 100, 50).gap).toBe(0);
    expect(dropTarget(cards, 200, 50).gap).toBe(1);
    expect(dropTarget(cards, 500, 50).gap).toBe(2);
  });

  it('uses the row under the pointer, even below a short card', () => {
    expect(dropTarget(cards, 500, 350).gap).toBe(2);
    expect(dropTarget(cards, 100, 450).gap).toBe(3);
  });

  it('past the end of a row lands after that row, drawn on that row', () => {
    const t = dropTarget(cards, 1100, 50);
    expect(t.gap).toBe(3);
    expect(t.line.left).toBeGreaterThan(928);
    expect(t.line.top).toBe(0);
    expect(t.line.height).toBe(400);
    const end = dropTarget(cards, 900, 450);
    expect(end.gap).toBe(5);
    expect(end.line.top).toBe(414);
  });

  it('above the chain counts as the first row, below it as the last', () => {
    expect(dropTarget(cards, 100, -50).gap).toBe(0);
    expect(dropTarget(cards, 100, 9000).gap).toBe(3);
  });

  it('draws the line in the gap between cards, and beside the card at a row start', () => {
    expect(dropTarget(cards, 200, 50).line.left).toBe(305.5);
    expect(dropTarget(cards, 100, 50).line.left).toBeLessThan(0);
  });

  it('a single column (narrow panel) goes by above or below, with a level line', () => {
    const column = [card(0, 0), card(0, 114), card(0, 228)];
    expect(dropTarget(column, 290, 20).gap).toBe(0);
    expect(dropTarget(column, 10, 200).gap).toBe(2);
    expect(dropTarget(column, 10, 300).gap).toBe(3);
    const { line } = dropTarget(column, 10, 130);
    expect(line).toEqual({ left: 0, top: 105.5, width: 300, height: 3 });
  });
});

describe('movePosition', () => {
  it('maps a gap to move_device\'s index (counted with the card taken out)', () => {
    expect(movePosition(2, 0)).toBe(0);
    expect(movePosition(0, 3)).toBe(2);
    expect(movePosition(0, 2)).toBe(1);
  });

  it('is null when the card would land where it already is', () => {
    expect(movePosition(1, 1)).toBeNull();
    expect(movePosition(1, 2)).toBeNull();
  });
});
