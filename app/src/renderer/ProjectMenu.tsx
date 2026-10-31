// Oct 30: the Lattice pill (top left) opens the project menu: Save (⌘S), New Project, the other
// projects to open (newest first), and the setups Lattice learned. Saving is when Lattice learns:
// once a kind of track (vocals, guitars, ...) has been set up the same way in enough projects, the
// notice offers to keep it (core/setups.ts); in a later project, a bare track of that kind gets the
// offer to use it (apply_setup).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../core/session';
import { bareTracks, type SetupOffer } from '../core/setups';
import { Icon } from './icons';
import { notify } from './Shelves';
import { whenOf } from './Versions';
import './ProjectMenu.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

interface ProjectRow {
  id: string;
  name: string;
  open: boolean;
  tracks: number;
  opened_at: string;
}
type SetupTrackView = SetupOffer['tracks'][number];
interface SetupRow {
  name: string;
  family: string;
  tracks: SetupTrackView[];
  learned_in?: string;
}

/** "Vocal centre · Vocal L 40% L · Vocal R 40% R, with Channel EQ, Compressor" */
export function setupText(tracks: SetupTrackView[]) {
  const devices = [...new Set(tracks.flatMap((t) => t.devices))];
  return tracks.map((t) => `${t.name} ${t.pan}`).join(' · ') + (devices.length ? `, with ${devices.join(', ')}` : '');
}

export const PROJECT_OPENED = 'lattice-project-opened'; // ChatPanel clears its conversation

export function ProjectMenu({ session, run }: { session: Session; run: Run }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [setups, setSetups] = useState<SetupRow[]>([]);
  const [learnAfter, setLearnAfter] = useState(2);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const switching = useRef(false); // the session may arrive before the project list says which one it is
  const offered = useRef(new Set<string>()); // "<project> <kind>" already asked about using a setup
  const current = projects.find((p) => p.open);

  const refresh = useCallback(async () => {
    const [p, s] = await Promise.all([run('list_projects'), run('list_setups')]);
    if (p.ok) setProjects(p.result.projects);
    if (s.ok) (setSetups(s.result.setups), setLearnAfter(s.result.learn_after));
  }, [run]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => void (open && refresh()), [open, refresh]);

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

  // one offer at a time in the notice; the next shows once the user answers
  const ask = useCallback(
    (offers: SetupOffer[]) => {
      const [offer, ...rest] = offers;
      if (!offer) return;
      const kind = offer.name.replace(/\s*setup$/i, '').toLowerCase();
      const seen = offer.projects > 1 ? `You've set up ${kind} tracks this way in ${offer.projects} projects: ` : '';
      const question = offer.replaces ? `Update your ${offer.name.toLowerCase()} to this?` : `Keep it as your ${offer.name.toLowerCase()} for new projects?`;
      notify({
        text: `${seen || (offer.replaces ? '' : 'New setup: ')}${setupText(offer.tracks)}. ${question}`,
        actions: [
          {
            label: offer.replaces ? 'Update setup' : `Save ${offer.name.toLowerCase()}`,
            onClick: async () => {
              const r = await run('save_setup', { name: offer.name, track_ids: offer.track_ids });
              if (current) offered.current.add(`${current.id} ${offer.family}`); // just taught it here: don't offer it back
              await refresh();
              notify({ text: r.ok ? `Saved your ${offer.name.toLowerCase()}${r.result.chain_saved ? ` (its chain too, as "${r.result.chain_saved}")` : ''}. New projects will offer it.` : `Not saved: ${r.error}` });
              if (rest.length) setTimeout(() => ask(rest), 2500);
            },
          },
          {
            label: 'Not now',
            onClick: () => {
              run('decline_setup', { family: offer.family, shape: offer.shape, projects: offer.projects });
              ask(rest);
            },
          },
        ],
      });
    },
    [run, refresh, current],
  );

  const save = useCallback(async () => {
    const r = await run('save_project');
    if (!r.ok) return notify({ text: `Not saved: ${r.error}` });
    const offers: SetupOffer[] = r.result.setup_offers ?? [];
    if (!offers.length) return notify({ text: `Saved (in Versions as "${r.result.name}")` });
    ask(offers);
  }, [run, ask]);

  // ⌘S / Ctrl+S anywhere, even while typing (it never types an "s")
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!e.repeat) saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const switchProject = async (tool: 'new_project' | 'open_project', args: Record<string, unknown>) => {
    switching.current = true;
    const r = await run(tool, args);
    setError(r.ok ? null : (r.error ?? 'failed'));
    if (r.ok && !r.result.already_open) window.dispatchEvent(new CustomEvent(PROJECT_OPENED));
    await refresh();
    switching.current = false;
    if (r.ok) setOpen(false);
  };
  const act = async (tool: string, args: Record<string, unknown>) => {
    const r = await run(tool, args);
    setError(r.ok ? null : (r.error ?? 'failed'));
    await refresh();
    return r.ok;
  };

  // a later project: a track of a setup's kind with no effects yet gets the offer, once per project
  useEffect(() => {
    if (!current || switching.current) return;
    const x = setups.find((y) => !offered.current.has(`${current.id} ${y.family}`) && bareTracks(session, y.family).length);
    if (!x) return;
    offered.current.add(`${current.id} ${x.family}`);
    notify({
      text: `Use your ${x.name.toLowerCase()} here? ${setupText(x.tracks)}`,
      actions: [
        { label: 'Use it', onClick: () => void run('apply_setup', { name: x.name }) },
        { label: 'Not now', onClick: () => {} },
      ],
    });
  }, [session, setups, current, run]);

  const others = projects.filter((p) => !p.open);
  return (
    <div className="project-menu-wrap" ref={ref}>
      <button className="island pill session-pill" data-testid="project-menu-open" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} title="Projects: save, new, open">
        <span className="logo" aria-hidden><Icon name="spark" size={14} /></span>
        <b>Lattice</b>
        <small data-testid="project-name">{current?.name ?? (session.tracks.length ? `${session.tracks.length} tracks` : 'new session')}</small>
        <span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="project-menu island" data-testid="project-menu" role="dialog" aria-label="Projects">
          <div className="pm-current">
            {renaming !== null ? (
              <form onSubmit={(e) => (e.preventDefault(), act('rename_project', { name: renaming }).then((ok) => ok && setRenaming(null)))}>
                <input autoFocus aria-label="Project name" data-testid="project-rename" value={renaming} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))} />
                <button type="submit" disabled={!renaming.trim()}>Rename</button>
              </form>
            ) : (
              <>
                <b title="Double-click to rename" onDoubleClick={() => setRenaming(current?.name ?? '')}>{current?.name}</b>
                <button className="link" onClick={() => setRenaming(current?.name ?? '')}>Rename</button>
              </>
            )}
          </div>
          <div className="pm-actions">
            <button data-testid="project-save" onClick={() => (setOpen(false), save())} title="Save a version to go back to; Lattice also learns your vocal setup here">
              Save <kbd>⌘S</kbd>
            </button>
            <button data-testid="project-new" onClick={() => switchProject('new_project', {})} title="Start an empty project; this one stays in the list">
              New Project
            </button>
          </div>
          {error && <div className="pm-error">{error}</div>}

          <h4>Open</h4>
          <ul className="pm-list">
            {!others.length && <li className="pm-empty">No other projects yet.</li>}
            {others.map((p) => (
              <li key={p.id} className="pm-row" data-testid={`project-${p.id}`}>
                <button className="pm-open" onClick={() => switchProject('open_project', { project: p.id })} title={`Open "${p.name}"`}>
                  <span>{p.name}</span>
                  <small>{p.tracks} track{p.tracks === 1 ? '' : 's'} · {whenOf(p.opened_at)}</small>
                </button>
                {confirmDelete === p.id ? (
                  <button className="pm-del sure" onClick={() => act('delete_project', { project: p.id }).then(() => setConfirmDelete(null))} onBlur={() => setConfirmDelete(null)}>
                    Delete?
                  </button>
                ) : (
                  <button className="pm-del" aria-label={`Delete ${p.name}`} title="Delete this project" onClick={() => setConfirmDelete(p.id)}>×</button>
                )}
              </li>
            ))}
          </ul>

          <h4>Your setups</h4>
          <ul className="pm-list pm-setups">
            {!setups.length && (
              <li className="pm-empty">None yet. Set tracks up the way you like (e.g. vocals: pans, effects) and Save; once you've done it in {learnAfter === 1 ? 'a project' : `${learnAfter} projects`}, Lattice offers to keep it.</li>
            )}
            {setups.map((x) => (
              <li key={x.name} className="pm-setup" data-testid="setup-row">
                <div>
                  <span>{x.name}</span>
                  {x.learned_in && <small> · from {x.learned_in}</small>}
                </div>
                <small className="pm-setup-tracks">{setupText(x.tracks)}</small>
                <div className="pm-setup-actions">
                  <button onClick={() => act('apply_setup', { name: x.name }).then((ok) => ok && setOpen(false))}>Add to project</button>
                  <button className="link" onClick={() => act('forget_setup', { name: x.name })}>Forget</button>
                </div>
              </li>
            ))}
          </ul>
          <label className="pm-learn">
            Offer a setup once I've used it in
            <select data-testid="learn-after" value={learnAfter} onChange={(e) => act('set_setup_learning', { after: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n} project{n > 1 ? 's' : ''}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
