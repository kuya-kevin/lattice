// B11: the Versions menu in the control bar. Save the session under a name, restore any saved
// version (one undo step), or start a new session. Auto versions (before each Muse turn, before
// New session) are listed too, the newest 20 unless "Show all".
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../core/session';
import { shownVersions, type VersionMeta } from '../core/versions';
import { Icon } from './icons';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function VersionsMenu({ session, run }: { session: Session; run: Run }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [name, setName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    run('list_versions').then((r) => r.ok && setVersions(r.result.versions.map((v: any) => ({ id: v.id, name: v.name, auto: v.auto, savedAt: v.saved_at }))));
  }, [run]);
  // refresh on open and after every change (Muse saves an auto version before its turns)
  useEffect(() => {
    if (open) refresh();
  }, [open, session, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const act = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await run(tool, args);
    setError(r.ok ? null : (r.error ?? 'failed'));
    refresh();
    return r.ok;
  };
  const save = async () => {
    if (await act('save_version', { name })) setName('');
  };
  const { shown, hidden } = shownVersions(versions, showAll);

  return (
    <div className="versions" ref={ref}>
      <button className={`island btn${open ? ' on' : ''}`} data-testid="versions-open" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Versions: save and go back">
        <Icon name="undo" size={16} />Versions
      </button>
      {open && (
        <div className="versions-menu island" data-testid="versions-menu" role="dialog" aria-label="Versions">
          <form className="versions-save" onSubmit={(e) => (e.preventDefault(), save())}>
            <input data-testid="version-name" placeholder="Name this version" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!name.trim()}>Save</button>
          </form>
          {error && <div className="versions-error">{error}</div>}
          <ul className="versions-list">
            {!shown.length && <li className="versions-empty">No versions yet. Muse saves one before each of its turns.</li>}
            {shown.map((v) => (
              <li key={v.id} className={`version-row${v.auto ? ' auto' : ''}`} data-testid={`version-${v.id}`}>
                <span className="version-name" title={v.name}>{v.name}</span>
                <small>{timeOf(v.savedAt)}</small>
                <button onClick={() => act('restore_version', { version: v.id })}>Restore</button>
              </li>
            ))}
          </ul>
          <div className="versions-foot">
            {(hidden > 0 || showAll) && (
              <button className="link" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show fewer' : `Show all (${hidden} older auto)`}</button>
            )}
            <button data-testid="new-session" onClick={() => act('new_session')} disabled={!session.tracks.length} title="Start empty; the current session is kept as a version">
              New session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
