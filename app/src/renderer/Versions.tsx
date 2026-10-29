// B11: the Versions menu in the control bar. Save the session under a name, restore any saved
// version (one undo step), or start a new session. Auto versions (before each Muse turn, before
// New session) are listed too, the newest 20 unless "Show all".
// Read like a commit log: each version shows what changed after it (+ added, − removed,
// ~ changed; list_versions with changes), i.e. what restoring it takes away. A Muse version's
// changes are what Muse did for that request; an "After Muse" one (saved at the end of the turn)
// lists the user's own edits after it, and is hidden while there are none.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../core/session';
import { changeStat, type Change } from '../core/versionDiff';
import { isAfterMuse, loggedVersions, shownVersions, type VersionMeta } from '../core/versions';
import { Icon } from './icons';
import './Versions.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

type Row = VersionMeta & { changes: Change[] };

/** "11:54 PM" today, "Yesterday 11:54 PM", else "Oct 27 11:54 PM". */
export function whenOf(iso: string, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** Auto versions around a Muse turn are named `Before Muse: "<request>"` / `After Muse: "<request>"`. */
const museRequest = (name: string) => {
  const m = /^(Before|After) Muse: "(.*)"?$/s.exec(name);
  return m ? { when: m[1], ask: m[2].replace(/"$/, '') } : null;
};

const SIGN: Record<Change['op'], string> = { '+': '+', '-': '−', '~': '~' };
const PREVIEW = 2; // change lines shown before "N more"

export function VersionsMenu({ session, run }: { session: Session; run: Run }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Row[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    run('list_versions', { changes: true }).then(
      (r) => r.ok && setVersions(r.result.versions.map((v: any) => ({ id: v.id, name: v.name, auto: v.auto, savedAt: v.saved_at, changes: v.changes ?? [] }))),
    );
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
  const { shown, hidden } = shownVersions(loggedVersions(versions), showAll);

  return (
    <div className="versions" ref={ref}>
      <button className={`island btn${open ? ' on' : ''}`} data-testid="versions-open" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Versions: save and go back">
        <Icon name="undo" size={16} />Versions
      </button>
      {open && (
        <div className="versions-menu versions-log island" data-testid="versions-menu" role="dialog" aria-label="Versions">
          <form className="versions-save" onSubmit={(e) => (e.preventDefault(), save())}>
            <input data-testid="version-name" placeholder="Name this version" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!name.trim()}>Save</button>
          </form>
          {error && <div className="versions-error">{error}</div>}
          <ul className="versions-list">
            {!shown.length && <li className="versions-empty">No versions yet. Muse saves one before each of its turns.</li>}
            {shown.map((v) => {
              const ask = museRequest(v.name);
              const after = isAfterMuse(v) ? 'your edits after this' : 'after this';
              const stat = changeStat(v.changes);
              const more = expanded.has(v.id);
              const lines = more ? v.changes : v.changes.slice(0, PREVIEW);
              return (
                <li key={v.id} className={`version-row${v.auto ? ' auto' : ''}${ask ? ' muse' : ''}`} data-testid={`version-${v.id}`}>
                  <div className="version-head">
                    <i className="version-dot" aria-hidden />
                    <span className="version-name" title={v.name}>
                      {ask ? <>{ask.when} Muse: <q>{ask.ask}</q></> : v.name}
                    </span>
                    <small>{whenOf(v.savedAt)}</small>
                  </div>
                  <div className="version-body">
                    {v.changes.length ? (
                      <>
                        <span className="version-stat" data-testid="version-stat" aria-label={`${stat['+']} added, ${stat['-']} removed, ${stat['~']} changed ${after}`}>
                          {stat['+'] > 0 && <b className="add">+{stat['+']}</b>}
                          {stat['-'] > 0 && <b className="del">−{stat['-']}</b>}
                          {stat['~'] > 0 && <b className="mod">~{stat['~']}</b>}
                          <span>{after}</span>
                        </span>
                        <ul className="version-changes" data-testid="version-changes">
                          {lines.map((c, i) => (
                            <li key={i} className={c.op === '+' ? 'add' : c.op === '-' ? 'del' : 'mod'}>
                              <b aria-hidden>{SIGN[c.op]}</b>
                              <span>{c.text}</span>
                            </li>
                          ))}
                        </ul>
                        {v.changes.length > PREVIEW && (
                          <button
                            className="link version-more"
                            aria-expanded={more}
                            onClick={() => setExpanded((e) => (e.has(v.id) ? new Set([...e].filter((x) => x !== v.id)) : new Set([...e, v.id])))}
                          >
                            {more ? 'Less' : `${v.changes.length - PREVIEW} more`}
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="version-stat none">No changes after this</span>
                    )}
                    <button
                      className="version-restore"
                      onClick={() => act('restore_version', { version: v.id })}
                      title={v.changes.length ? 'Go back to this version: undoes the changes listed here and above (one undo step)' : 'Go back to this version (one undo step)'}
                    >
                      Restore
                    </button>
                  </div>
                </li>
              );
            })}
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
