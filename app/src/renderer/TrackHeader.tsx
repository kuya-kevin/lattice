// Logic-style track header: colour strip, number, name, Mute / Solo / Record-arm buttons and
// a volume slider. Clicking the header selects the track; Option/Alt-click on the slider
// resets it to 0 dB (Logic's reset gesture).
import { useEffect, useState } from 'react';
import type { Session } from '../core/session';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** Logic-ish region colours, one per track in turn. */
export const TRACK_COLORS = ['#3d8ee6', '#47b35f', '#e0b23a', '#e07a3a', '#a868e0', '#36b8c4', '#e0587d', '#8fa63a'];
export const trackColor = (index: number) => TRACK_COLORS[index % TRACK_COLORS.length];

export function TrackHeader({ session, index, run }: { session: Session; index: number; run: Run }) {
  const t = session.tracks[index];
  const [gain, setGain] = useState(t?.gainDb ?? 0);
  useEffect(() => setGain(t?.gainDb ?? 0), [t?.gainDb]);
  if (!t) return null;
  const selected = session.selection.trackId === t.id;
  const commit = (v = gain) => v !== t.gainDb && run('set_gain', { track_id: t.id, gain_db: v });
  const select = () => !selected && run('select', { track_id: t.id }); // the playlist highlight follows the session
  return (
    <div
      className={`track-controls${selected ? ' selected' : ''}${t.muted ? ' muted' : ''}`}
      data-testid={`track-${t.id}`}
      style={{ '--track-color': trackColor(index) } as React.CSSProperties}
      onMouseDown={select}
    >
      <div className="track-strip" aria-hidden />
      <div className="track-main">
        <div className="track-top">
          <span className="track-num">{index + 1}</span>
          <span className="track-name" title={`${t.name} (${t.id})`}>{t.name}</span>
          <small className="track-id">{t.id}</small>
        </div>
        <div className="track-row">
          <button className={`ms${t.muted ? ' on mute' : ''}`} title="Mute" aria-pressed={t.muted} onClick={() => run('mute', { track_id: t.id, muted: !t.muted })}>M</button>
          <button className={`ms${t.soloed ? ' on solo' : ''}`} title="Solo" aria-pressed={t.soloed} onClick={() => run('solo', { track_id: t.id, soloed: !t.soloed })}>S</button>
          <button className={`ms${t.armed ? ' on arm' : ''}`} title="Record enable" aria-label="R" aria-pressed={!!t.armed} onClick={() => run('arm_track', { track_id: t.id, armed: !t.armed })}>R</button>
        </div>
        <div className="track-row vol">
          <input
            type="range" min={-60} max={12} step={0.5} value={gain} aria-label={`${t.name} gain`}
            title="Volume (Alt-click: 0 dB)"
            onChange={(e) => setGain(Number(e.target.value))}
            onPointerDown={(e) => {
              if (!e.altKey) return;
              e.preventDefault();
              setGain(0);
              commit(0);
            }}
            onPointerUp={() => commit()} onKeyUp={() => commit()}
          />
          <span className="db">{gain > 0 ? '+' : ''}{gain.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}
