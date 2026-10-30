// B17 sound shelves in the renderer: the shelf list the library panel shows (Starred, My Sounds),
// star buttons for library rows, Ideas cards and pads, and the right-click menu on a region or
// track header that exports it as a sound. Every action is a tool (star_sound, export_sound, ...).
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Bridge } from '../core/bridge';
import { SHELF_LABELS, type ShelfItem, type ShelfName } from '../core/shelf';
import type { Session } from '../core/session';
import { decodeBytes } from './audio';
import { previewBuffer, stopPreview } from './libraryAudio';
import './Shelves.css';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

// ---- the shelf items, shared by every component (kept in step with the bridge by App) ----
let items: ShelfItem[] = [];
const listeners = new Set<() => void>();
const shelfStore = {
  subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  get: () => items,
};

/** Call once (App): loads the shelves and reloads them whenever they change (user or Muse). */
export function useShelfSync(bridge: Bridge) {
  useEffect(() => {
    let live = true;
    const load = () =>
      bridge.listShelf().then((next) => {
        if (!live) return;
        items = next;
        for (const l of listeners) l();
      }, (e) => console.warn('[shelf] could not list', e));
    load();
    const off = bridge.onShelf(load);
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
}

export const useShelfItems = () => useSyncExternalStore(shelfStore.subscribe, shelfStore.get);

/** The Starred item for a library id or a session source, if starred. */
export function starredFor(all: ShelfItem[], ref: { library?: string; sourceId?: string }): ShelfItem | undefined {
  return all.find((i) => i.shelf === 'starred' && ((ref.library && i.library === ref.library) || (ref.sourceId && i.sourceId === ref.sourceId)));
}

/** ☆ / ★ toggle: star_sound with `args`, or unstar_sound when already starred. */
export function StarButton({ run, args, name, sourceId = args.source_id, className = '' }: {
  run: Run;
  args: { library_id?: string; source_id?: string; kit_id?: string; pad?: number };
  name: string;
  /** the session source it stars (marks it starred); defaults to args.source_id */
  sourceId?: string;
  className?: string;
}) {
  const all = useShelfItems();
  const on = starredFor(all, { library: args.library_id, sourceId });
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`star-btn${on ? ' on' : ''} ${className}`}
      aria-pressed={!!on}
      aria-label={on ? `Unstar ${name}` : `Star ${name}`}
      title={on ? 'Starred: click to take it off the Starred shelf' : 'Star it: keep it on the Starred shelf in the Library, across projects'}
      disabled={busy}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        await (on ? run('unstar_sound', { shelf_id: on.id }) : run('star_sound', args));
        setBusy(false);
      }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

const fmtDur = (s: number) => (s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const FROM: Record<ShelfItem['from'], string> = { library: 'Library', idea: 'Ideas', pad: 'Pad', export: 'Export', recording: 'Recording' };

/** One shelf in the library panel: click to preview, + to bring it into Ideas, reopen an export. */
export function ShelfList({ bridge, run, shelf, text }: { bridge: Bridge; run: Run; shelf: ShelfName; text: string }) {
  const all = useShelfItems();
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter((i) => i.shelf === shelf && words.every((w) => `${i.name} ${FROM[i.from]}`.toLowerCase().includes(w)));
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => stopPreview(), []);
  const play = async (id: string) => {
    if (playing === id) {
      stopPreview();
      return setPlaying(null);
    }
    setPlaying(id);
    try {
      const b = await decodeBytes(await bridge.loadShelfAudio(id));
      previewBuffer(b, () => setPlaying((p) => (p === id ? null : p)), id);
    } catch (e) {
      setPlaying(null);
      setError(`Preview failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  const act = async (tool: string, args: Record<string, unknown>) => {
    const r = await run(tool, args);
    if (!r.ok) setError(r.error ?? `${tool} failed`);
  };
  return (
    <div className="shelf" data-testid={`shelf-${shelf}`}>
      {error && <p className="lib-error pad" role="alert" onClick={() => setError(null)}>{error}</p>}
      <div className="lib-crumbs">
        <span>{SHELF_LABELS[shelf]}</span>
        <span className="count">{list.length} sound{list.length === 1 ? '' : 's'} · all projects</span>
      </div>
      <ul className="lib-list">
        {list.map((i) => (
          <li key={i.id} className={`lib-row shelf-row${playing === i.id ? ' playing' : ''}`} data-testid={`shelf-item-${i.id}`} onClick={() => play(i.id)} title="Click to preview">
            <span className="play" aria-hidden>{playing === i.id ? '■' : '▶'}</span>
            <span className="nm">{i.name}</span>
            <span className="meta">{FROM[i.from]} · {fmtDur(i.duration)}{i.recipe ? ` · ${i.recipe.devices.length} device${i.recipe.devices.length === 1 ? '' : 's'}` : ''}</span>
            {i.recipe ? (
              <button className="shelf-reopen" aria-label={`Reopen ${i.name}`} title="Reopen: the sound before its effects on a new track, with its device chain" onClick={(e) => (e.stopPropagation(), act('reopen_sound', { shelf_id: i.id }))}>
                ↺
              </button>
            ) : <span />}
            <button className="shelf-remove" aria-label={`Remove ${i.name} from ${SHELF_LABELS[shelf]}`} title={`Take it off ${SHELF_LABELS[shelf]}`} onClick={(e) => (e.stopPropagation(), act('unstar_sound', { shelf_id: i.id }))}>
              {shelf === 'starred' ? '★' : '×'}
            </button>
            <button className="add-idea" aria-label={`Add ${i.name} to Ideas`} title="Bring it into this project (Ideas column)" onClick={(e) => (e.stopPropagation(), stopPreview(), act('use_shelf_sound', { shelf_id: i.id }))}>
              +
            </button>
          </li>
        ))}
        {list.length === 0 && (
          <li className="hint pad">
            {text ? 'Nothing matches.' : shelf === 'starred'
              ? 'No starred sounds yet. Star (☆) a sound in the library, an Ideas card or a pad to keep it here for every project.'
              : 'Nothing here yet. Right-click a region or track and choose Export as Sound, or use Export Sound in the device panel.'}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Right-click on a region or a track header: export it as a sound (My Sounds), or star the
 *  region's sound. Mount once (App); it listens on the arrangement element it is given. */
export function SoundMenu({ session, run }: { session: Session; run: Run }) {
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string; clipId: string | null } | null>(null);
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const arrange = el.closest('.arrange');
      if (!arrange) return;
      // overlays sit on the lanes, so find the region and the lane under the pointer by position;
      // the region header carries the clip id
      const under = (sel: string) => [...arrange.querySelectorAll<HTMLElement>(sel)].find((n) => {
        const r = n.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      const clipEl = el.closest<HTMLElement>('[data-clip-id]') ?? under('[data-clip-container]')?.querySelector<HTMLElement>('[data-clip-id]');
      const trackEl = el.closest<HTMLElement>('[data-track-id]') ?? el.closest<HTMLElement>('[data-testid^="track-t"]') ?? under('[data-track-row][data-track-id]');
      const clipId = clipEl?.dataset.clipId ?? null;
      const trackId = trackEl?.dataset.trackId ?? trackEl?.dataset.testid?.replace(/^track-/, '') ?? (clipId ? session.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.id : undefined);
      if (!trackId || !session.tracks.some((t) => t.id === trackId)) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, trackId, clipId: clipId && session.tracks.some((t) => t.clips.some((c) => c.id === clipId)) ? clipId : null });
    };
    window.addEventListener('contextmenu', onMenu);
    return () => window.removeEventListener('contextmenu', onMenu);
  }, [session]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !(e.target as HTMLElement).closest?.('.sound-menu') && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);
  if (!menu) return null;
  const track = session.tracks.find((t) => t.id === menu.trackId);
  const clip = track?.clips.find((c) => c.id === menu.clipId);
  const src = clip && !clip.midi ? session.sources[clip.sourceId] : undefined;
  const pick = (tool: string, args: Record<string, unknown>) => {
    setMenu(null);
    if (tool === 'export_sound') void exportSound(run, args);
    else run(tool, args);
  };
  return (
    <div className="sound-menu island" role="menu" aria-label="Region menu" style={{ left: menu.x, top: menu.y }} data-testid="sound-menu">
      {clip && (
        <button role="menuitem" onClick={() => pick('export_sound', { clip_id: clip.id })}>
          Export Region as Sound <small>to My Sounds, with effects</small>
        </button>
      )}
      {track && (
        <button role="menuitem" onClick={() => pick('export_sound', { track_id: track.id })} disabled={!track.clips.length}>
          Export Track as Sound <small>{track.name}</small>
        </button>
      )}
      {src && (
        <button role="menuitem" onClick={() => pick('star_sound', { source_id: src.id })}>
          Star the Region's Sound <small>{src.name}</small>
        </button>
      )}
    </div>
  );
}

// ---- what an export did, said where the user looks (the Export Sound button, the region menu) ----
type NoticeMsg = { text: string; showShelf?: ShelfName };
const NOTICE = 'lattice-notice';
const SHOW_SHELF = 'lattice-show-shelf';

/** Run export_sound and say where the sound went (or why it didn't). */
export async function exportSound(run: Run, args: Record<string, unknown>) {
  const r = await run('export_sound', args);
  const msg: NoticeMsg = r.ok ? { text: `Saved "${r.result?.name}" to My Sounds`, showShelf: 'mine' } : { text: `Export failed: ${r.error}` };
  window.dispatchEvent(new CustomEvent(NOTICE, { detail: msg }));
}

/** Ask the library to open on a shelf (App opens the panel, LibraryPanel switches its tab). */
export const showShelf = (shelf: ShelfName) => window.dispatchEvent(new CustomEvent(SHOW_SHELF, { detail: shelf }));
export function useShowShelf(onShow: (shelf: ShelfName) => void) {
  useEffect(() => {
    const h = (e: Event) => onShow((e as CustomEvent<ShelfName>).detail);
    window.addEventListener(SHOW_SHELF, h);
    return () => window.removeEventListener(SHOW_SHELF, h);
  }, [onShow]);
}

/** A short status line over the canvas for 4 s (App mounts one). */
export function Notice() {
  const [msg, setMsg] = useState<NoticeMsg | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const h = (e: Event) => {
      setMsg((e as CustomEvent<NoticeMsg>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 4000);
    };
    window.addEventListener(NOTICE, h);
    return () => {
      window.removeEventListener(NOTICE, h);
      clearTimeout(timer);
    };
  }, []);
  if (!msg) return null;
  return (
    <div className="notice island" role="status" data-testid="notice">
      {msg.text}
      {msg.showShelf && (
        <button onClick={() => { showShelf(msg.showShelf!); setMsg(null); }}>Show</button>
      )}
    </div>
  );
}
