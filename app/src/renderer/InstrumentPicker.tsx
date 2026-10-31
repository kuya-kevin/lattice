// Oct 30: what a MIDI region plays on, changed in place (set_region_instrument): the piano, the
// built-in drums, an Ideas sound as a sampler, or a sample pad. Library sounds go through Ideas
// first (or Muse's library_id). Shown in the Piano Roll toolbar and the region menu.
import type { Clip, Session } from '../core/session';
import { ideaSources } from './Ideas';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** The picker's value for a region: "piano", "drums", "src:<id>" or "kit:<id>". */
export function instrumentValue(clip: Clip): string {
  const m = clip.midi!;
  if (m.kit) return `kit:${m.kit}`;
  if (m.sample) return `src:${m.sample.sourceId}`;
  return m.drum ? 'drums' : 'piano';
}

export function InstrumentPicker({ session, clip, run, onPicked }: { session: Session; clip: Clip; run: Run; onPicked?: () => void }) {
  const value = instrumentValue(clip);
  const sounds = ideaSources(session);
  const kits = Object.values(session.kits ?? {});
  // a sampler region on a sound that isn't an Ideas card (e.g. a clip's part) still shows its name
  const own = clip.midi?.sample && !sounds.some((s) => s.id === clip.midi!.sample!.sourceId);
  const pick = (v: string) => {
    onPicked?.();
    if (v === value) return;
    const [kind, id] = v.split(/:(.*)/);
    run('set_region_instrument', { clip_id: clip.id, ...(kind === 'src' ? { source_id: id } : kind === 'kit' ? { kit_id: id } : { instrument: v }) });
  };
  return (
    <select aria-label="Region instrument" data-testid="region-instrument" value={value} onChange={(e) => pick(e.target.value)} title="What this region's notes play on">
      <option value="piano">Piano</option>
      <option value="drums">Drums (built-in)</option>
      {own && <option value={value}>{clip.midi!.instrument}</option>}
      {sounds.length > 0 && (
        <optgroup label="Ideas sounds">
          {sounds.map((s) => <option key={s.id} value={`src:${s.id}`}>{s.name}</option>)}
        </optgroup>
      )}
      {kits.length > 0 && (
        <optgroup label="Sample pads">
          {kits.map((k) => <option key={k.id} value={`kit:${k.id}`}>{k.name}</option>)}
        </optgroup>
      )}
    </select>
  );
}
