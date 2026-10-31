// Movable frames (core/frames.ts): where docked and free frames land, docking without loops,
// snapping, dock zones, and set_layout (the tool the app and Muse both use).
import { describe, expect, it } from 'vitest';
import {
  clearSpot, DEFAULT_FRAMES, dockFrame, dockTarget, dependents, framesLine, freeFrame, GAP_X, GAP_Y, parseFrames,
  PRESETS, presetOf, resolveFrames, snapRect, type FrameId, type Size,
} from '../src/core/frames';
import { SessionStore } from '../src/core/store';
import { StubSidecar } from '../src/core/sidecar';
import { museSummary, museToolSpecs, runTool, type ToolContext } from '../src/core/tools';
import { MemoryChainLibrary } from '../src/fx/savedChains';

const sizes: Record<FrameId, Size> = { ideas: { w: 264, h: 600 }, board: { w: 900, h: 400 }, editor: { w: 900, h: 300 } };

describe('resolveFrames', () => {
  it('ideas-left: Ideas left of the board, editor under it, origin at the Ideas column', () => {
    const { rects, origin, extent } = resolveFrames(DEFAULT_FRAMES, sizes);
    expect(rects.board).toEqual({ x: 0, y: 0, w: 900, h: 400 });
    expect(rects.ideas).toEqual({ x: -264 - GAP_X, y: 0, w: 264, h: 600 });
    expect(rects.editor).toEqual({ x: 0, y: 400 + GAP_Y, w: 900, h: 300 });
    expect(origin).toEqual({ x: -264 - GAP_X, y: 0 });
    expect(extent).toEqual({ w: 264 + GAP_X + 900, h: 400 + GAP_Y + 300 });
  });

  it('every preset lays the three frames out without overlaps', () => {
    for (const { layout } of Object.values(PRESETS)) {
      const { rects } = resolveFrames(layout, sizes);
      const list = Object.values(rects);
      for (const a of list) for (const b of list) {
        if (a === b) continue;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });

  it('columns: the editor sits right of the board; editor-top: the editor above it, Ideas beside the editor', () => {
    const c = resolveFrames(PRESETS.columns.layout, sizes).rects;
    expect(c.editor).toMatchObject({ x: 900 + GAP_X, y: 0 });
    const e = resolveFrames(PRESETS['editor-top'].layout, sizes).rects;
    expect(e.editor).toMatchObject({ x: 0, y: -300 - GAP_Y });
    expect(e.ideas).toMatchObject({ x: -264 - GAP_X, y: -300 - GAP_Y });
  });

  it('a docked frame follows its anchor as the anchor grows', () => {
    const taller = resolveFrames(DEFAULT_FRAMES, { ...sizes, board: { w: 900, h: 700 } }).rects;
    expect(taller.editor.y).toBe(700 + GAP_Y);
  });

  it('two frames docked on the same side line up instead of overlapping', () => {
    const l = { ...DEFAULT_FRAMES, editor: { dock: 'board' as const, side: 'left' as const } };
    const { rects } = resolveFrames(l, { ...sizes, editor: { w: 264, h: 300 } });
    expect(rects.editor.x).toBe(-264 - GAP_X);
    expect(rects.ideas.y).toBe(300 + GAP_Y); // after the editor, which was placed first
  });

  it('a free frame in the way of another moves right of it', () => {
    const l = freeFrame(DEFAULT_FRAMES, 'editor', 100, 100);
    const { rects } = resolveFrames(l, sizes);
    expect(rects.editor.x).toBe(900 + GAP_X);
  });

  it('a hidden frame (no size) takes no room and no gap', () => {
    const { rects, origin } = resolveFrames(DEFAULT_FRAMES, { ...sizes, ideas: { w: 0, h: 0 }, editor: { w: 0, h: 0 } });
    expect(origin).toEqual({ x: 0, y: 0 });
    expect(rects.board.x).toBe(0);
  });
});

describe('docking', () => {
  it('ideas docked above or below a frame become a strip; beside one, a column', () => {
    expect(dockFrame(DEFAULT_FRAMES, 'ideas', 'board', 'top').ideasShape).toBe('strip');
    expect(dockFrame(PRESETS['ideas-top'].layout, 'ideas', 'board', 'right').ideasShape).toBe('column');
  });

  it('docking onto a frame that hangs off you frees that frame where it is, so no loop forms', () => {
    const { rects } = resolveFrames(DEFAULT_FRAMES, sizes);
    // the board docks below the editor, which was docked below the board
    const l = dockFrame(DEFAULT_FRAMES, 'board', 'editor', 'bottom', rects);
    expect(l.board).toEqual({ dock: 'editor', side: 'bottom' });
    expect(l.editor).toEqual({ x: 0, y: 400 + GAP_Y });
    const r = resolveFrames(l, sizes).rects;
    expect(r.board.y).toBe(r.editor.y + 300 + GAP_Y);
  });

  it('dependents move with their anchor', () => {
    expect(dependents(DEFAULT_FRAMES, 'board').sort()).toEqual(['editor', 'ideas']);
    expect(dependents(PRESETS['editor-top'].layout, 'editor')).toEqual(['ideas']);
  });

  it('dockTarget finds the nearest side band of another frame, never the dragged one', () => {
    const { rects } = resolveFrames(DEFAULT_FRAMES, sizes);
    expect(dockTarget('ideas', { x: 900 + 30, y: 200 }, rects)).toEqual({ to: 'board', side: 'right' });
    expect(dockTarget('ideas', { x: 400, y: -20 }, rects)).toEqual({ to: 'board', side: 'top' });
    expect(dockTarget('ideas', { x: 3000, y: 3000 }, rects)).toBeNull();
    expect(dockTarget('board', { x: 450, y: 200 }, rects)).toBeNull(); // inside itself
  });
});

describe('snapping and free drops', () => {
  it('snaps an edge within tolerance and returns a guide', () => {
    const s = snapRect({ x: 905, y: 500, w: 200, h: 100 }, [{ x: 0, y: 0, w: 900, h: 400 }]);
    expect(s.x).toBe(900);
    expect(s.guides.some((g) => g.axis === 'x' && g.at === 900)).toBe(true);
    const none = snapRect({ x: 930, y: 500, w: 200, h: 100 }, [{ x: 0, y: 0, w: 900, h: 400 }]);
    expect(none.x).toBe(930);
  });

  it('clearSpot moves an overlapping drop the shortest way out', () => {
    const board = { x: 0, y: 0, w: 900, h: 400 };
    expect(clearSpot({ x: 800, y: 50, w: 200, h: 100 }, [board])).toEqual({ x: 900 + GAP_X, y: 50 });
    expect(clearSpot({ x: 1200, y: 50, w: 200, h: 100 }, [board])).toEqual({ x: 1200, y: 50 });
  });
});

describe('parse, presets, summary', () => {
  it('parseFrames keeps good input, rejects bad, breaks loops', () => {
    expect(parseFrames(PRESETS.columns.layout)).toEqual(PRESETS.columns.layout);
    expect(parseFrames({ ideas: { x: 'a' } })).toBeNull();
    const loop = parseFrames({ board: { dock: 'editor', side: 'top' }, editor: { dock: 'board', side: 'top' }, ideas: { x: 0, y: 0 } });
    expect(loop?.board).toEqual({ x: 0, y: 0 });
  });

  it('presetOf names a preset layout; framesLine describes it for Muse', () => {
    expect(presetOf(PRESETS['ideas-right'].layout)).toBe('ideas-right');
    expect(presetOf(freeFrame(DEFAULT_FRAMES, 'ideas', 5, 5))).toBeNull();
    const line = framesLine(PRESETS['ideas-top'].layout);
    expect(line).toContain('"ideas-top"');
    expect(line).toContain('Ideas above the Arrangement board (strip)');
    expect(framesLine(undefined)).toBe('');
  });
});

describe('set_layout', () => {
  const ctx = (): ToolContext => ({ store: new SessionStore(), sidecar: new StubSidecar(), searchFreesound: async () => ({ count: 0, results: [] }), chains: new MemoryChainLibrary() });

  it('Muse sees it, and can apply a preset or put one frame next to another', async () => {
    const c = ctx();
    expect(museToolSpecs().some((t: any) => (t.function?.name ?? t.name) === 'set_layout')).toBe(true);
    let r = await runTool(c, 'set_layout', { preset: 'columns' }, 'muse');
    expect(r.ok).toBe(true);
    expect(c.store.get().frames).toEqual(PRESETS.columns.layout);
    expect(museSummary(c)).toContain('Screen layout "columns"');
    r = await runTool(c, 'set_layout', { frame: 'ideas', next_to: 'board', side: 'top' }, 'muse');
    expect(c.store.get().frames).toMatchObject({ ideas: { dock: 'board', side: 'top' }, ideasShape: 'strip' });
  });

  it('the app sends the whole layout; bad input is refused; no undo step and no hand edit', async () => {
    const c = ctx();
    const free = freeFrame(DEFAULT_FRAMES, 'editor', 1200, 40);
    const r = await runTool(c, 'set_layout', { layout: free }, 'user');
    expect(r.ok).toBe(true);
    expect(c.store.get().frames).toEqual(free);
    expect(c.store.takeUserEdits()).toEqual([]);
    expect((await runTool(c, 'set_layout', { layout: { ideas: 1 } }, 'user')).ok).toBe(false);
    expect((await runTool(c, 'set_layout', { frame: 'ideas' }, 'muse')).ok).toBe(false);
    expect((await runTool(c, 'set_layout', {}, 'muse')).ok).toBe(false);
  });

  it('undo keeps the layout (a view setting)', async () => {
    const c = ctx();
    await runTool(c, 'import_audio', { source_id: 'a', name: 'Vox', duration: 4 }, 'user');
    await runTool(c, 'set_layout', { preset: 'ideas-right' }, 'muse');
    await runTool(c, 'undo', {}, 'user');
    expect(c.store.get().tracks).toHaveLength(0);
    expect(c.store.get().frames).toEqual(PRESETS['ideas-right'].layout);
  });
});

describe('sameFrames', () => {
  it('ignores key order (storage, the session and presets build objects in different orders)', async () => {
    const { sameFrames } = await import('../src/core/frames');
    const a = PRESETS['ideas-right'].layout;
    const b = { editor: { side: 'bottom' as const, dock: 'board' as const }, ideasShape: 'column' as const, ideas: { side: 'right' as const, dock: 'board' as const }, board: { y: 0, x: 0 } };
    expect(sameFrames(a, b)).toBe(true);
    expect(sameFrames(a, PRESETS.columns.layout)).toBe(false);
    expect(sameFrames(undefined, undefined)).toBe(true);
  });
});
