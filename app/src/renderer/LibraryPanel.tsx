// Sound library, modelled on Logic's Loop Browser: a search field, keyword buttons (chips,
// combined with AND), a category browser, a result list where a click previews the sound,
// drag a row onto a track (or below the tracks for a new one) or press its + to add it to
// Ideas (on no track, to try out on Musical Typing first), and an info area at the bottom with
// the credit line CC-BY sounds need. "Fits project" keeps sounds in the project's key (and
// phrases at its tempo); Recent lists sounds used lately; in the result list ↑/↓ audition the
// next sound, Enter adds it to Ideas and Esc stops (Space stays play/stop).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bridge } from '../core/bridge';
import {
  CHIPS, SET_LABELS, attribution, categoriesBySet, categoryLabel, filterLibrary, fitsProject, needsAttribution, phraseBpm,
  type LibraryEntry, type LibrarySet, type ProjectFit,
} from '../core/library';
import { useRecents } from './libraryRecents';
import { useShowSounds, type ShowSounds } from './libraryShow';
import { LIBRARY_MIME, libraryDrag, preview, stopPreview } from './libraryAudio';
import { ShelfList, StarButton, useShelfItems, useShowShelf } from './Shelves'; // B17 sound shelves
import { SHELF_LABELS, type ShelfName } from '../core/shelf';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;
type Scope = LibrarySet | 'all' | 'recent' | ShelfName;
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'freesound', label: 'Instruments' },
  { id: 'voice_notes', label: 'Voice notes' },
  { id: 'recent', label: 'Recent' },
  { id: 'starred', label: '★ Starred' }, // B17: shelves that span projects
  { id: 'mine', label: 'My Sounds' },
];
const isShelf = (s: Scope): s is ShelfName => s === 'starred' || s === 'mine';

const fmtDur = (s: number) => (s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const licenseBadge = (l: string) => (/^CC0/i.test(l) ? 'CC0' : /^CC-BY/i.test(l) ? 'CC BY' : l === 'own recording' ? 'Own' : l);

export function LibraryPanel({ bridge, open, onAddIdea, run, project }: {
  bridge: Bridge;
  open: boolean;
  onAddIdea: (id: string) => void;
  run: Run;
  /** the project's key and tempo, for "Fits project" */
  project: ProjectFit;
}) {
  const [items, setItems] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [category, setCategory] = useState<string | null>(null);
  // B17: the Export notice's Show opens a shelf; the footer counts the shelf, not the library
  useShowShelf(useCallback((shelf: ShelfName) => { setScope(shelf); setCategory(null); }, []));
  const shelfItems = useShelfItems();
  const shelfCount = isShelf(scope) ? shelfItems.filter((i) => i.shelf === scope).length : 0;
  const [chips, setChips] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [lastPlayed, setLastPlayed] = useState<string | null>(null); // outlives a short preview (tests read it)
  const [fitsOn, setFitsOn] = useState(false);
  const recentIds = useRecents();
  const listRef = useRef<HTMLUListElement>(null);
  // sounds sent from elsewhere (Muse's reply links), listed until you go back to All
  const [picked, setPicked] = useState<ShowSounds | null>(null);

  useEffect(() => {
    bridge.listLibrary().then(setItems, (e) => setError(String(e)));
    return () => stopPreview();
  }, [bridge]);

  // the panel only hides when closed (it keeps its search), so stop the preview here
  useEffect(() => {
    if (open) return;
    stopPreview();
    setPlaying(null);
  }, [open]);

  // the "producer material" set (stand-in voice notes for testing source prep) is hidden for now (Oct 30)
  const all = useMemo(() => (items ?? []).filter((i) => i.set !== 'material'), [items]);
  const set = isShelf(scope) || scope === 'recent' ? 'all' : scope;
  // "Fits project" needs a key; tempo alone only matters for phrases
  const fits = fitsOn && project.key ? project : null;
  const results = useMemo(() => {
    const byId = (ids: string[]) => ids.flatMap((id) => all.find((i) => i.id === id) ?? []);
    if (picked) return filterLibrary(byId(picked.ids), { text });
    const pool = scope === 'recent' ? byId(recentIds) : all;
    return filterLibrary(pool, { text, set, category, chips, fits });
  }, [all, picked, scope, recentIds, text, set, category, chips, fits]);
  const browsing = !picked && scope !== 'recent' && !text.trim() && !category && chips.length === 0;
  const groups = useMemo(
    () => categoriesBySet(set === 'all' ? all : all.filter((i) => i.set === set), fits ? (i) => fitsProject(i, fits) : undefined),
    [all, set, fits],
  );
  const sel = all.find((i) => i.id === selected) ?? null;

  const toggleChip = (id: string) => {
    setPicked(null);
    setChips((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };
  const stop = () => {
    stopPreview();
    setPlaying(null);
  };
  const audition = (id: string) => {
    setSelected(id);
    setPlaying(id);
    setLastPlayed(id);
    preview(bridge, id, () => setPlaying((p) => (p === id ? null : p))).catch((e) => {
      setPlaying(null);
      setError(`Preview failed: ${e instanceof Error ? e.message : e}`);
    });
  };
  const play = (id: string) => (playing === id ? (setSelected(id), stop()) : audition(id));
  const addIdea = (id: string) => {
    stop();
    onAddIdea(id);
  };

  // keyboard auditioning (Logic's Loop Browser, Ableton's browser): ↑/↓ play the next sound
  const step = (d: 1 | -1) => {
    if (!results.length) return;
    const at = results.findIndex((i) => i.id === selected);
    const next = results[at < 0 ? (d > 0 ? 0 : results.length - 1) : Math.min(results.length - 1, Math.max(0, at + d))];
    if (next.id !== selected || playing !== next.id) audition(next.id);
  };
  useEffect(() => {
    listRef.current?.querySelector('.lib-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected, picked]);
  // a click on a sound name in Muse's reply: list what Muse found, play the one clicked
  const auditionRef = useRef(audition);
  auditionRef.current = audition;
  useShowSounds(useCallback((s: ShowSounds) => {
    setPicked(s);
    if (isShelf(scope) || scope === 'recent') setScope('all');
    setCategory(null);
    setChips([]);
    setText('');
    if (s.focus) auditionRef.current(s.focus);
    else setSelected(null);
  }, [scope]));
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') step(e.key === 'ArrowDown' ? 1 : -1);
    else if (e.key === 'Enter' && selected) addIdea(selected);
    else if (e.key === 'Escape' && playing) stop();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="library" data-testid="library">
      <div className="lib-search">
        <input
          type="search" placeholder="Search sounds" aria-label="Search sounds" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' || browsing || !results.length) return;
            e.preventDefault();
            listRef.current?.focus();
            step(1);
          }}
        />
      </div>
      <div className="lib-scopes" role="tablist" aria-label="Sound sets">
        {SCOPES.map((s) => (
          <button key={s.id} role="tab" aria-selected={scope === s.id} className={`${scope === s.id ? 'on' : ''}${isShelf(s.id) ? ' shelf-tab' : ''}`} onClick={() => { setScope(s.id); setCategory(null); setPicked(null); }}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="lib-chips" aria-label="Filters" hidden={isShelf(scope)}>
        <button
          className={`chip fits${fits ? ' on' : ''}`} aria-pressed={!!fits} disabled={!project.key} data-testid="lib-fits"
          title={project.key ? `Only sounds in ${project.key} (and phrases near ${project.tempo ?? '?'} BPM, half or double time). Drums and textures always fit.` : 'Set the project key first (or ask Muse to detect it)'}
          onClick={() => setFitsOn((f) => !f)}
        >
          Fits {project.key ?? 'project'}
        </button>
        {CHIPS.map((c) => (
          <button key={c.id} className={`chip${chips.includes(c.id) ? ' on' : ''}`} aria-pressed={chips.includes(c.id)} onClick={() => toggleChip(c.id)}>
            {c.label}
          </button>
        ))}
        {(chips.length > 0 || category || text || picked) && (
          <button className="chip reset" onClick={() => { setChips([]); setCategory(null); setText(''); setPicked(null); }}>Reset</button>
        )}
      </div>

      <div className="lib-body">
        {isShelf(scope) && <ShelfList bridge={bridge} run={run} shelf={scope} text={text} />}
        {!isShelf(scope) && <>
        {items === null && !error && <p className="hint pad">Loading library…</p>}
        {error && <p className="lib-error pad" role="alert" onClick={() => setError(null)}>{error}</p>}
        {items && items.length === 0 && (
          <p className="hint pad">No sounds found. Electron reads the repo's <code>data/</code> folder; dev:web reads <code>$LATTICE_DATA_DIR</code> (default <code>../data</code>).</p>
        )}
        {items && items.length > 0 && browsing && (
          <div className="lib-browse" data-testid="lib-browse">
            {groups.map((g) => (
              <section key={g.set}>
                <h4>{SET_LABELS[g.set]}</h4>
                <ul>
                  {g.categories.map((c) => (
                    <li key={c.id}>
                      <button className="cat" onClick={() => setCategory(c.id)} disabled={c.count === 0}>
                        <span>{c.label}</span>
                        <span className="count">{c.count === c.total ? c.total : `${c.count} of ${c.total}`}</span>
                        <span className="chev">›</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {items && items.length > 0 && !browsing && (
          <>
            <div className="lib-crumbs">
              {picked ? (
                <>
                  <button className="link" onClick={() => setPicked(null)}>‹ All</button>
                  <span>{picked.label}</span>
                </>
              ) : category ? (
                <>
                  <button className="link" onClick={() => setCategory(null)}>‹ All</button>
                  <span>{categoryLabel(category)}</span>
                </>
              ) : (
                <span>{scope === 'recent' ? 'Recently used' : 'Results'}</span>
              )}
              <span className="count">{results.length} sounds</span>
            </div>
            <ul className="lib-list" data-testid="lib-list" ref={listRef} tabIndex={0} data-keynav data-last-played={lastPlayed ?? ''} onKeyDown={onListKey} aria-label="Sounds (↑/↓ to audition, Enter adds to Ideas)">
              {results.map((i) => (
                <li
                  key={i.id}
                  className={`lib-row${selected === i.id ? ' sel' : ''}${playing === i.id ? ' playing' : ''}`}
                  data-testid={`lib-item-${i.id}`}
                  draggable
                  onDragStart={(e) => {
                    libraryDrag.item = i;
                    e.dataTransfer.setData(LIBRARY_MIME, i.id);
                    e.dataTransfer.setData('text/plain', i.name);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={() => (libraryDrag.item = null)}
                  onClick={() => play(i.id)}
                  onDoubleClick={() => addIdea(i.id) /* into Ideas, like its +; from there "Add to track…" puts it on a track */}
                  title="Click to preview (↑/↓ for the next one), double-click or Enter to add to Ideas, drag onto a track (or below the tracks for a new one)"
                >
                  <span className="play" aria-hidden>{playing === i.id ? '■' : '▶'}</span>
                  <span className="nm">{i.name}</span>
                  <span className="meta">{categoryLabel(i.category)} · {fmtDur(i.duration)}{i.note ? ` · ${i.note}` : ''}{phraseBpm(i) ? ` · ${Math.round(phraseBpm(i)!)} bpm` : ''}</span>
                  <span className={`lic${needsAttribution(i) ? ' by' : ''}`}>{licenseBadge(i.license)}</span>
                  <StarButton run={run} args={{ library_id: i.id }} name={i.name} />
                  <button
                    className="add-idea" aria-label={`Add ${i.name} to Ideas`} title="Add to Ideas and try it on Musical Typing"
                    onClick={(e) => {
                      e.stopPropagation();
                      addIdea(i.id);
                    }}
                  >+</button>
                </li>
              ))}
              {results.length === 0 && (
                <li className="hint pad">
                  {scope === 'recent' && !recentIds.length
                    ? 'Sounds you add to Ideas or drag onto a track show up here.'
                    : `Nothing matches. ${fits ? 'Turn off Fits, remove' : 'Remove'} a filter or try fewer words.`}
                </li>
              )}
            </ul>
          </>
        )}
        </>}
      </div>

      <div className="lib-info" data-testid="lib-info">
        {sel ? (
          <>
            <div className="info-name">{sel.name}</div>
            <div className="info-meta">
              {SET_LABELS[sel.set]} · {categoryLabel(sel.category)} · {fmtDur(sel.duration)}
              {sel.note ? ` · ${sel.note}` : ''}
            </div>
            {sel.tags.length > 0 && <div className="info-tags">{sel.tags.slice(0, 8).join(', ')}</div>}
            <div className={`info-credit${needsAttribution(sel) ? ' by' : ''}`} data-testid="lib-credit">
              {needsAttribution(sel) && <strong>Attribution required: </strong>}
              {attribution(sel)}
            </div>
          </>
        ) : (
          <div className="hint">
            {isShelf(scope)
              ? `${shelfCount} sound${shelfCount === 1 ? '' : 's'} in ${SHELF_LABELS[scope]}. Click one to preview; + puts it in Ideas.`
              : items ? `${items.length} sounds. Click one to preview; drag it to a track.` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
