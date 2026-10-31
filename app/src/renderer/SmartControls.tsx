// The editor area under the arrangement board, with two tabs: the device chain (Logic's Smart
// Controls, B; the effects agent mounts its DevicePanel as this component's children, see the
// marked region in App.tsx) and the region editor (P, or double-click a region): the Piano Roll
// for a MIDI region, the Audio Editor for an audio one, as in GarageBand; and the Mixer (X), every
// track's channel strip side by side (Mixer.tsx).
import type { ReactNode } from 'react';
import type { Session } from '../core/session';

export type EditorTab = 'fx' | 'notes' | 'mix';

export function SmartControls({ session, tab, onTab, onClose, regionKind = 'midi', pianoRoll, mixer, children }: {
  session: Session;
  tab: EditorTab;
  onTab: (t: EditorTab) => void;
  onClose: () => void;
  /** what the region tab shows, which names it */
  regionKind?: 'midi' | 'audio';
  pianoRoll: ReactNode;
  mixer?: ReactNode;
  children?: ReactNode;
}) {
  const track = session.tracks.find((t) => t.id === session.selection.trackId) ?? null;
  return (
    <section className="smart-controls" aria-label="Smart Controls" data-testid="smart-controls">
      <header>
        <div className="sc-tabs" role="tablist" aria-label="Editor">
          <button role="tab" aria-selected={tab === 'fx'} className={tab === 'fx' ? 'on' : ''} onClick={() => onTab('fx')} title="Device chain (B)">Device chain</button>
          <button role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'on' : ''} onClick={() => onTab('notes')} title={`${regionKind === 'audio' ? 'Audio Editor' : 'Piano Roll'} (P, or double-click a region)`}>{regionKind === 'audio' ? 'Audio Editor' : 'Piano Roll'}</button>
          <button role="tab" aria-selected={tab === 'mix'} className={tab === 'mix' ? 'on' : ''} onClick={() => onTab('mix')} title="Mixer: every track's volume, pan and level (X)">Mixer</button>
        </div>
        {tab === 'fx' && !track && <span className="sc-track muted">No track selected</span>}
        <button className="sc-close" title="Hide editor area (B / P / X)" aria-label="Hide Smart Controls" onClick={onClose}>×</button>
      </header>
      {tab === 'fx' ? (
        <div className="sc-body" data-testid="device-panel-slot">
          {children ?? (
            <p className="hint">{track ? `Effects for ${track.name} will appear here.` : 'Select a track to see its effects chain.'}</p>
          )}
        </div>
      ) : tab === 'mix' ? (
        <div className="sc-body">{mixer}</div>
      ) : (
        <div className="sc-body">{pianoRoll}</div>
      )}
    </section>
  );
}
