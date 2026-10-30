// Sound library, modelled on Logic's Loop Browser: a search field, keyword buttons (chips,
// combined with AND), a category browser, a result list where a click previews the sound,
// drag a row onto a track (or below the tracks for a new one) or press its + to add it to
// Ideas (on no track, to try out on Musical Typing first), and an info area at the bottom with
// the credit line CC-BY sounds need.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Bridge } from '../core/bridge';
import {
  CHIPS, SET_LABELS, attribution, categoriesBySet, categoryLabel, filterLibrary, needsAttribution,
  type LibraryEntry, type LibrarySet,
} from '../core/library';
import { LIBRARY_MIME, libraryDrag, preview, stopPreview } from './libraryAudio';
import { ShelfList, StarButton, useShelfItems, useShowShelf } from './Shelves'; // B17 sound shelves
import { SHELF_LABELS, type ShelfName } from '../core/shelf';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;
type Scope = LibrarySet | 'all' | ShelfName;
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'freesound', label: 'Instruments' },
  { id: 'material', label: 'Material' },
  { id: 'voice_notes', label: 'Voice notes' },
  { id: 'starred', label: '★ Starred' }, // B17: shelves that span projects
  { id: 'mine', label: 'My Sounds' },
];
const isShelf = (s: Scope): s is ShelfName => s === 'starred' || s === 'mine';

const fmtDur = (s: number) => (s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const licenseBadge = (l: string) => (/^CC0/i.test(l) ? 'CC0' : /^CC-BY/i.test(l) ? 'CC BY' : l === 'own recording' ? 'Own' : l);

export function LibraryPanel({ bridge, open, onAddIdea, run }: { bridge: Bridge; open: boolean; onAddIdea: (id: string) => void; run: Run }) {
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

  const all = items ?? [];
  const set = isShelf(scope) ? 'all' : scope;
  const results = useMemo(() => filterLibrary(all, { text, set, category, chips }), [all, text, set, category, chips]);
  const browsing = !text.trim() && !category && chips.length === 0;
  const groups = useMemo(() => categoriesBySet(set === 'all' ? all : all.filter((i) => i.set === set)), [all, set]);
  const sel = all.find((i) => i.id === selected) ?? null;

  const toggleChip = (id: string) => setChips((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const play = (id: string) => {
    setSelected(id);
    if (playing === id) {
      stopPreview();
      setPlaying(null);
      return;
    }
    setPlaying(id);
    preview(bridge, id, () => setPlaying((p) => (p === id ? null : p))).catch((e) => {
      setPlaying(null);
      setError(`Preview failed: ${e instanceof Error ? e.message : e}`);
    });
  };

  return (
    <div className="library" data-testid="library">
      <div className="lib-search">
        <input type="search" placeholder="Search sounds" aria-label="Search sounds" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="lib-scopes" role="tablist" aria-label="Sound sets">
        {SCOPES.map((s) => (
          <button key={s.id} role="tab" aria-selected={scope === s.id} className={`${scope === s.id ? 'on' : ''}${isShelf(s.id) ? ' shelf-tab' : ''}`} onClick={() => { setScope(s.id); setCategory(null); }}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="lib-chips" aria-label="Filters" hidden={isShelf(scope)}>
        {CHIPS.map((c) => (
          <button key={c.id} className={`chip${chips.includes(c.id) ? ' on' : ''}`} aria-pressed={chips.includes(c.id)} onClick={() => toggleChip(c.id)}>
            {c.label}
          </button>
        ))}
        {(chips.length > 0 || category || text) && (
          <button className="chip reset" onClick={() => { setChips([]); setCategory(null); setText(''); }}>Reset</button>
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
                      <button className="cat" onClick={() => setCategory(c.id)}>
                        <span>{c.label}</span>
                        <span className="count">{c.count}</span>
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
              {category ? (
                <>
                  <button className="link" onClick={() => setCategory(null)}>‹ All</button>
                  <span>{categoryLabel(category)}</span>
                </>
              ) : (
                <span>Results</span>
              )}
              <span className="count">{results.length} sounds</span>
            </div>
            <ul className="lib-list" data-testid="lib-list">
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
                  title="Click to preview, drag onto a track (or below the tracks for a new one)"
                >
                  <span className="play" aria-hidden>{playing === i.id ? '■' : '▶'}</span>
                  <span className="nm">{i.name}</span>
                  <span className="meta">{categoryLabel(i.category)} · {fmtDur(i.duration)}{i.note ? ` · ${i.note}` : ''}{i.bpm ? ` · ${Math.round(i.bpm)} bpm` : ''}</span>
                  <span className={`lic${needsAttribution(i) ? ' by' : ''}`}>{licenseBadge(i.license)}</span>
                  <StarButton run={run} args={{ library_id: i.id }} name={i.name} />
                  <button
                    className="add-idea" aria-label={`Add ${i.name} to Ideas`} title="Add to Ideas and try it on Musical Typing"
                    onClick={(e) => {
                      e.stopPropagation();
                      stopPreview();
                      setPlaying(null);
                      onAddIdea(i.id);
                    }}
                  >+</button>
                </li>
              ))}
              {results.length === 0 && <li className="hint pad">Nothing matches. Remove a filter or try fewer words.</li>}
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
