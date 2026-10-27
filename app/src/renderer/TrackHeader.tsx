// Logic-style track header: colour strip, number, name, Mute / Solo / Record-arm buttons and
// a volume slider. Clicking the header selects the track; Option/Alt-click on the slider
// resets it to 0 dB (Logic's reset gesture). Double-click the name to rename; × deletes.
// Drag the header's bottom edge to make that one track taller or shorter.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../core/session';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** Region colours, one per track in turn: equal lightness, so no lane shouts. */
export const TRACK_COLORS = ['#f08a6c', '#e9b85a', '#7fd39a', '#8fb3ff', '#c79cf0', '#6fcfc0', '#f08aa8', '#b9d36a'];
export const trackColor = (index: number) => TRACK_COLORS[index % TRACK_COLORS.length];

export function TrackHeader({ session, index, run }: { session: Session; index: number; run: Run }) {
  const t = session.tracks[index];
  const [gain, setGain] = useState(t?.gainDb ?? 0);
  useEffect(() => setGain(t?.gainDb ?? 0), [t?.gainDb]);
  const [draft, setDraft] = useState<string | null>(null); // the name being edited (double-click)
  const cancelled = useRef(false);
  if (!t) return null;
  const selected = session.selection.trackId === t.id;
  const commit = (v = gain) => v !== t.gainDb && run('set_gain', { track_id: t.id, gain_db: v });
  const select = () => !selected && run('select', { track_id: t.id }); // the playlist highlight follows the session
  // Enter or leaving the field renames; Esc cancels. Blank or unchanged names are dropped.
  const endRename = () => {
    const name = draft?.trim();
    if (!cancelled.current && name && name !== t.name) run('rename_track', { track_id: t.id, name });
    cancelled.current = false;
    setDraft(null);
  };
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
          {draft == null ? (
            <span className="track-name" title={`${t.name} (${t.id}), double-click to rename`} onDoubleClick={() => setDraft(t.name)}>{t.name}</span>
          ) : (
            <input
              className="track-name-edit" aria-label="Track name" value={draft} autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelled.current = true;
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
              }}
              onBlur={endRename}
            />
          )}
          <small className="track-id">{t.id}</small>
          <button
            className="track-delete" title="Delete track (undo brings it back)" aria-label="Delete" /* not "Delete track": tests find M, S, R by substring */
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => run('delete_track', { track_id: t.id })}
          >×</button>
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
      <LaneHeightHandle trackId={t.id} name={t.name} scale={t.heightScale ?? 1} run={run} />
    </div>
  );
}

/** Height of a lane's region header strip (waveform-playlist's CLIP_HEADER_HEIGHT). */
const CLIP_HEADER = 22;

/** Bottom edge of a track header: drag to resize this one lane (a guide line follows the
 *  pointer; the height is applied on release, since every change rebuilds the audio graph).
 *  Double-click or Enter resets; ↑/↓ nudge. Stored as a scale of the global track height. */
function LaneHeightHandle({ trackId, name, scale, run }: { trackId: string; name: string; scale: number; run: Run }) {
  const [guide, setGuide] = useState<{ y: number; left: number; width: number } | null>(null);
  const setScale = (next: number | null) => run('set_track_height', { track_id: trackId, ...(next === null ? {} : { scale: next }) });
  /** Scale for a new slot height, from the slot's current height (header strip excluded). */
  const scaleFor = (slot: HTMLElement, newSlotH: number) => {
    const wave = slot.getBoundingClientRect().height - CLIP_HEADER;
    return (scale * Math.max(12, newSlotH - CLIP_HEADER)) / Math.max(1, wave);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const slot = e.currentTarget.parentElement!;
    const { top, height } = slot.getBoundingClientRect();
    const lanes = (slot.closest('.arrange') ?? slot).getBoundingClientRect();
    const y0 = e.clientY;
    // the new bottom edge: where it was, moved by the pointer's travel
    const slotH = (y: number) => Math.max(CLIP_HEADER + 12, height + y - y0);
    const at = (y: number) => setGuide({ y: top + slotH(y), left: lanes.left, width: lanes.width });
    at(y0);
    document.documentElement.classList.add('rz-drag-y');
    const move = (ev: PointerEvent) => at(ev.clientY);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.documentElement.classList.remove('rz-drag-y');
      setGuide(null);
      if (ev.clientY !== y0) setScale(scaleFor(slot, slotH(ev.clientY)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      <div
        className="lane-h-handle" role="separator" aria-orientation="horizontal" tabIndex={0}
        aria-label={`Resize ${name} height`} title="Drag to resize this track (double-click to reset)" data-testid={`lane-h-${trackId}`}
        onPointerDown={onPointerDown}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setScale(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setScale(null);
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setScale(scale * (e.key === 'ArrowDown' ? 1.15 : 1 / 1.15));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {guide && createPortal(<div className="lane-h-guide" style={{ top: guide.y, left: guide.left, width: guide.width }} />, document.body)}
    </>
  );
}
