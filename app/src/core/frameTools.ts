// set_layout: move the Ideas, Arrangement and editor frames on the canvas (core/frames.ts). The
// app runs it with the whole layout after the producer drags a frame, so the session mirrors the
// screen; Muse runs it with a preset or "put this frame next to that one".
import { dockFrame, FRAME_IDS, parseFrames, PRESET_IDS, PRESETS, DEFAULT_FRAMES, type FrameId, type PresetId, type Side } from './frames';
import * as S from './session';
import type { ToolDef } from './tools';

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

export const FRAME_TOOLS: ToolDef[] = [
  {
    name: 'set_layout',
    description:
      'Move the three frames on the producer\'s screen: "ideas" (the sound cards), "board" (the arrangement) and "editor" (device chain, Piano Roll / Audio Editor and Mixer share it). ' +
      'Either pick a preset (ideas-left: the default; ideas-right; ideas-top: Ideas as a strip above the board; columns: Ideas, board and a tall editor side by side; editor-top) ' +
      'or put one frame on a side of another (frame + next_to + side), e.g. "put the mixer on the right" = frame editor, next_to board, side right. ' +
      'It changes only the view, not the music; use it when the producer asks to rearrange the screen.',
    parameters: obj({
      preset: { type: 'string', enum: [...PRESET_IDS], description: 'A whole layout' },
      frame: { type: 'string', enum: FRAME_IDS, description: 'The frame to move' },
      next_to: { type: 'string', enum: FRAME_IDS, description: 'The frame to put it next to' },
      side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], description: 'Which side of next_to' },
      layout: { type: 'object', description: 'The whole layout as the app stores it (the app sends this after a drag; Muse uses preset or frame / next_to / side)' },
    }),
    quiet: true, // a view setting: no undo step
    run: (ctx, a) => {
      const s = ctx.store.get();
      const cur = s.frames ?? DEFAULT_FRAMES;
      let next = cur;
      if (a.layout !== undefined) {
        const l = parseFrames(a.layout);
        if (!l) throw new S.SessionError('layout is not a valid frame layout');
        next = l;
      } else if (a.preset) {
        if (!PRESET_IDS.includes(a.preset)) throw new S.SessionError(`unknown preset ${a.preset}`);
        next = PRESETS[a.preset as PresetId].layout;
      } else if (a.frame || a.next_to || a.side) {
        if (!a.frame || !a.next_to || !a.side) throw new S.SessionError('give frame, next_to and side together');
        if (a.frame === a.next_to) throw new S.SessionError('a frame cannot go next to itself');
        next = dockFrame(cur, a.frame as FrameId, a.next_to as FrameId, a.side as Side);
      } else {
        throw new S.SessionError('give a preset, or frame + next_to + side');
      }
      ctx.store.set({ ...s, frames: next });
      return { layout: next, view_only: true };
    },
    logText: (a) => (a.preset ? `layout: ${a.preset}` : a.frame ? `layout: ${a.frame} ${a.side} of ${a.next_to}` : 'layout: moved a frame'),
  },
];
