// B18 control-bar controls: the Dry A/B toggle (set_mix_view; devices stay as they are, the dry
// mix is loudness-matched) and Stems export (export_stems: a dry and a wet set, one WAV per track).
import { useState } from 'react';
import type { Session } from '../core/session';
import { Icon } from './icons';
import './Shelves.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** In the transport island, beside the click and count-in: pressed = hear the mix dry. */
export function DryWetToggle({ session, run }: { session: Session; run: Run }) {
  const v = session.mixView;
  const dry = v?.mode === 'dry';
  const [busy, setBusy] = useState(false);
  const match = dry && v?.matchLoudness ? ` (loudness-matched: ${v.dryGainDb >= 0 ? '+' : ''}${v.dryGainDb} dB on the dry mix)` : '';
  return (
    <button
      className={`count-in mix-toggle${dry ? ' dry' : ''}`}
      aria-label="Dry"
      aria-pressed={dry}
      data-testid="mix-dry"
      data-match-db={dry && v?.matchLoudness ? v.dryGainDb : undefined}
      disabled={busy}
      title={dry
        ? `Dry: every effect bypassed, devices unchanged${match}. Click for the wet mix.`
        : 'A/B: hear the mix dry, every effect bypassed (gain and pan stay; loudness-matched to the wet mix)'}
      onClick={async () => {
        setBusy(true);
        try {
          await run('set_mix_view', { mode: dry ? 'wet' : 'dry' });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : 'Dry'}
    </button>
  );
}

/** In the file actions: export stems (a dry and a wet set) to a folder the user picks. */
export function StemsButton({ session, run }: { session: Session; run: Run }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="island btn stems-btn"
      data-testid="export-stems"
      aria-label={busy ? 'Exporting stems' : 'Export stems'}
      disabled={busy || !session.tracks.some((t) => t.clips.length)}
      title="Export stems: one WAV per track, a dry set (effects bypassed) and a wet set"
      onClick={async () => {
        setBusy(true);
        try {
          await run('export_stems', {});
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="import" size={16} />
    </button>
  );
}
