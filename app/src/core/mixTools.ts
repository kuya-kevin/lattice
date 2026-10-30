// B18 dry / wet: an A/B listening switch that bypasses every effect (devices unchanged), and a
// hand-off export of stems, one WAV per track, as a dry set and a wet set.
import { matchingGainDb, stemName, type MixMode, type MixView } from './mixView';
import * as S from './session';
import type { ToolDef } from './tools';

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

export const MIX_TOOLS: ToolDef[] = [
  {
    name: 'set_mix_view',
    description:
      'A/B listening: "dry" bypasses every effect device on every track without changing them (gain and pan stay, so the balance holds); "wet" plays the effects again. ' +
      'The dry mix is loudness-matched to the wet mix by default, so the louder one doesn\'t win. Use it when the user asks to hear the mix with or without the effects.',
    parameters: obj(
      {
        mode: { type: 'string', enum: ['dry', 'wet'], description: '"dry" = effects bypassed, "wet" = as mixed' },
        match_loudness: { type: 'boolean', description: 'Match the dry mix to the wet mix\'s loudness (default true)' },
      },
      ['mode'],
    ),
    quiet: true, // a listening setting: no undo step, not a hand edit
    run: async (ctx, a) => {
      const mode = a.mode as MixMode;
      const matchLoudness = a.match_loudness ?? ctx.store.get().mixView?.matchLoudness ?? true;
      let dryGainDb = 0;
      let measured: { wetDb: number; dryDb: number } | null = null;
      if (mode === 'dry' && matchLoudness && ctx.store.get().tracks.length) {
        if (ctx.render) {
          try {
            measured = await ctx.render(ctx.store.get(), { kind: 'loudness' });
            dryGainDb = matchingGainDb(measured);
          } catch (e) {
            measured = null; // audio not loaded yet: listen unmatched rather than fail
            console.warn('[mix view] loudness match failed', e);
          }
        }
      }
      const v: MixView = { mode, matchLoudness, dryGainDb };
      ctx.store.set({ ...ctx.store.get(), mixView: v });
      return {
        mode,
        match_loudness: matchLoudness,
        ...(mode === 'dry' ? { dry_gain_db: dryGainDb } : {}),
        ...(measured ? { wet_loudness_db: measured.wetDb, dry_loudness_db: measured.dryDb } : mode === 'dry' && matchLoudness ? { note: 'loudness not measured (no audio rendered here); dry plays unmatched' } : {}),
        devices_changed: false,
      };
    },
  },
  {
    name: 'export_stems',
    description:
      'Export stems for a hand-off: one WAV per track, all from the session start so they line up, as a dry set (effects bypassed, gain and pan kept) and/or a wet set (as mixed, with effect tails). ' +
      'The user picks the folder (a save dialog in the app, downloads in the browser).',
    parameters: obj({
      sets: { type: 'array', items: { type: 'string', enum: ['dry', 'wet'] }, description: 'Which sets (default both)' },
    }),
    run: async (ctx, a) => {
      const s = ctx.store.get();
      if (!s.tracks.some((t) => t.clips.length)) throw new S.SessionError('no regions to export');
      if (!ctx.render) throw new S.SessionError('no audio here to render (the app window renders stems)');
      if (!ctx.saveFiles) throw new S.SessionError('stems cannot be saved here');
      const sets = [...new Set<MixMode>(a.sets?.length ? a.sets : ['dry', 'wet'])];
      const files: { set: MixMode; name: string; bytes: Uint8Array }[] = [];
      const lengths: Record<string, number> = {};
      for (const set of sets) {
        const r = await ctx.render(s, { kind: 'stems', set });
        lengths[set] = Math.round(r.duration * 1000) / 1000;
        r.stems.forEach((st) => files.push({ set, name: `${stemName(s.tracks.findIndex((t) => t.id === st.trackId), st.name)}.wav`, bytes: st.wav }));
      }
      const saved = await ctx.saveFiles(files, 'Lattice stems');
      if (!saved) return { cancelled: true, note: 'the user closed the folder dialog; nothing was saved' };
      return { saved_to: saved.savedTo, sets, tracks: s.tracks.length, files: saved.files, seconds: lengths };
    },
    logText: (_a, r) => (r.cancelled ? 'export stems: cancelled' : `exported ${r.files.length} stems (${r.sets.join(' + ')}) to ${r.saved_to}`),
  },
];
