// The device chain under the arrangement board (Logic's Smart Controls, B). The effects agent
// mounts its DevicePanel as this component's children (see the marked region in App.tsx).
import type { ReactNode } from 'react';
import type { Session } from '../core/session';

export function SmartControls({ session, onClose, children }: { session: Session; onClose: () => void; children?: ReactNode }) {
  const track = session.tracks.find((t) => t.id === session.selection.trackId) ?? null;
  return (
    <section className="smart-controls" aria-label="Smart Controls" data-testid="smart-controls">
      <header>
        <span className="sc-title">Device chain</span>
        {!track && <span className="sc-track muted">No track selected</span>}
        <button className="sc-close" title="Hide device chain (B)" aria-label="Hide Smart Controls" onClick={onClose}>×</button>
      </header>
      <div className="sc-body" data-testid="device-panel-slot">
        {children ?? (
          <p className="hint">{track ? `Effects for ${track.name} will appear here.` : 'Select a track to see its effects chain.'}</p>
        )}
      </div>
    </section>
  );
}
