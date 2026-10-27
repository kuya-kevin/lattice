// Bottom pane, like Logic's Smart Controls / Editors area (B / E). The effects agent mounts
// its DevicePanel as this component's children (see the marked region in App.tsx); until
// then it shows what is selected.
import type { ReactNode } from 'react';
import type { Session } from '../core/session';
import { trackColor } from './TrackHeader';

export function SmartControls({ session, onClose, children }: { session: Session; onClose: () => void; children?: ReactNode }) {
  const i = session.tracks.findIndex((t) => t.id === session.selection.trackId);
  const track = i >= 0 ? session.tracks[i] : null;
  const clip = track?.clips.find((c) => c.id === session.selection.clipId) ?? null;
  return (
    <section className="smart-controls" aria-label="Smart Controls" data-testid="smart-controls">
      <header>
        <span className="sc-title">Smart Controls</span>
        {track ? (
          <span className="sc-track">
            <i className="dot" style={{ background: trackColor(i) }} />
            {track.name}
            {clip && <span className="sc-clip"> · {clip.name} ({clip.start.toFixed(2)}–{(clip.start + clip.duration).toFixed(2)} s)</span>}
          </span>
        ) : (
          <span className="sc-track muted">No track selected</span>
        )}
        <button className="sc-close" title="Hide Smart Controls (B)" aria-label="Hide Smart Controls" onClick={onClose}>×</button>
      </header>
      <div className="sc-body" data-testid="device-panel-slot">
        {children ?? (
          <p className="hint">{track ? `Effects for ${track.name} will appear here.` : 'Select a track to see its effects chain.'}</p>
        )}
      </div>
    </section>
  );
}
