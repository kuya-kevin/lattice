// "Ideas" column on the canvas: one card per recorded / imported sound (voice notes, takes,
// library sounds), wired to the tracks that use it. Clicking a card selects its first clip; a
// sound on no track yet is tried out instead: Musical Typing opens with it as the instrument.
// Drag a card onto the arrangement to put the sound on a track (place_sound).
// The × (or Delete/Backspace on a focused card) deletes the sound; if clips use it, it asks first.
// A sound and its processed versions (cleanup_noise, quantize_drums) share one card, which shows
// the version in use; its Versions list plays each one and switches the clips back or forward
// (use_audio_version, undoable).
// B12: sample pads (kits) get a card too, under the sounds: a mini 3x3 of its pads. Clicking it plays
// the kit on the keyboard window; dragging it onto the arrangement puts an empty region on it;
// double-click its name to rename it. Sounds on a kit's pads (and on no track) show on the kit's
// card, not their own, and wires run from it to the tracks that play it. "New sample pad" makes one.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { kitSources, PAD_COUNT, type Kit } from '../core/kit';
import { rootSource, type Session, type Source } from '../core/session';
import { buffers } from './audio';
import { IDEA_MIME, KIT_MIME, previewBuffer, soundDrag, stopPreview } from './libraryAudio';
import './Ideas.css';
import { musicalTyping, openDrumPad } from './MusicalTyping';
import { trackColor } from './TrackHeader';

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

const ORIGIN: Record<string, string> = { record: 'Recorded', import: 'Imported', freesound: 'Library' };
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Sources worth a card: real audio, not the placeholders MIDI clips carry, nor sounds that only
 *  sit on a drum pad (the kit's card shows those). */
export function ideaSources(s: Session): Source[] {
  const onPads = new Set(Object.values(s.kits ?? {}).flatMap((k) => [...kitSources(k)]));
  const onClips = new Set(s.tracks.flatMap((t) => t.clips.map((c) => c.sourceId)));
  return Object.values(s.sources).filter((src) => src.origin !== 'generated' && (!onPads.has(src.id) || onClips.has(src.id)));
}

/** One card per sound: its original and processed versions, oldest first. */
export function ideaGroups(s: Session): { root: string; versions: Source[] }[] {
  const groups = new Map<string, Source[]>();
  for (const src of ideaSources(s)) {
    const root = rootSource(s, src.id);
    groups.set(root, [...(groups.get(root) ?? []), src]);
  }
  return [...groups].map(([root, versions]) => ({ root, versions }));
}

/** Colour of the first track that uses a source (cards and wires take the track's colour). A
 *  MIDI take played with the sound as its instrument uses it too. */
function usage(s: Session, sourceId: string | Set<string>) {
  const has = (id?: string) => !!id && (typeof sourceId === 'string' ? id === sourceId : sourceId.has(id));
  const uses = s.tracks.flatMap((t, i) => t.clips.filter((c) => has(c.sourceId) || has(c.midi?.sample?.sourceId)).map((c) => ({ t, i, c })));
  return { uses, color: uses.length ? trackColor(s, uses[0].i) : 'var(--faint)' };
}

/** What deleting a sound does to the arrangement. */
function confirmText(clips: number, takes: number) {
  const out = [];
  if (clips) out.push(`Also removes ${clips} clip${clips > 1 ? 's' : ''} from the arrangement.`);
  if (takes) out.push(`${takes} MIDI take${takes > 1 ? 's' : ''} played with it go${takes > 1 ? '' : 'es'} back to the piano.`);
  return out.join(' ');
}

/** What a version is, for the Versions list. */
const versionLabel = (src: Source) => (src.processed ? src.processed[0].toUpperCase() + src.processed.slice(1) : 'Original');

export function Ideas({ session, run, audioVersion }: { session: Session; run: Run; audioVersion: number }) {
  const groups = ideaGroups(session);
  const [confirm, setConfirm] = useState<string | null>(null); // source id awaiting "Delete?"
  const [open, setOpen] = useState<string | null>(null); // root whose Versions list is open
  const [playing, setPlaying] = useState<string | null>(null); // version being previewed
  const { audition, kit: playingKit, on: typing } = useSyncExternalStore(musicalTyping.subscribe, musicalTyping.get);
  useEffect(() => () => stopPreview(), []);
  const kits = Object.values(session.kits ?? {});
  if (!groups.length && !kits.length) return null;
  const play = (id: string) => {
    const b = buffers.get(id);
    if (playing === id || !b) {
      stopPreview();
      return setPlaying(null);
    }
    setPlaying(id);
    previewBuffer(b, () => setPlaying((p) => (p === id ? null : p)));
  };
  /** Play a sound on Musical Typing before it goes on a track. */
  const tryOut = (id: string) => {
    musicalTyping.audition(id);
    musicalTyping.toggle(true);
    if (session.selection.trackId || session.selection.clipId) run('select', {}); // a take then goes on a new track
  };
  const remove = (id: string) => {
    setConfirm(null);
    run('delete_sound', { source_id: id });
  };
  const askRemove = (id: string) => (usage(session, id).uses.length ? setConfirm(id) : remove(id));
  return (
    <section className="ideas" aria-label="Ideas">
      <div className="frame-title">
        <b>Ideas</b> {groups.length} sound{groups.length === 1 ? '' : 's'}
        {kits.length > 0 && ` · ${kits.length} sample pad${kits.length > 1 ? 's' : ''}`}
      </div>
      {groups.map(({ root, versions }) => {
        const family = new Set(versions.map((v) => v.id));
        // the card shows the newest version a track plays, else the newest one
        const inUse = [...versions].reverse().find((v) => usage(session, v.id).uses.length);
        const src = inUse ?? versions[versions.length - 1];
        const { uses } = usage(session, src.id);
        const { color } = usage(session, family);
        const familyUses = usage(session, family).uses.filter((u) => !u.c.midi);
        const first = uses[0];
        const selected = !!first && uses.some((u) => u.c.id === session.selection.clipId);
        const trying = typing && audition === src.id;
        return (
          <div
            key={root} className="idea" data-idea={root} data-version={src.id} style={{ '--c': color } as React.CSSProperties}
            draggable
            onDragStart={(e) => {
              soundDrag.idea = { sourceId: src.id, duration: src.duration };
              e.dataTransfer.setData(IDEA_MIME, src.id);
              e.dataTransfer.setData('text/plain', src.name);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDragEnd={() => (soundDrag.idea = null)}
          >
            <button
              className={`idea-card${selected || trying ? ' sel' : ''}`}
              data-trying={trying || undefined}
              onClick={() => (first ? run('select', { track_id: first.t.id, clip_id: first.c.id }) : tryOut(src.id))}
              onKeyDown={(e) => {
                if (e.key !== 'Backspace' && e.key !== 'Delete') return;
                e.preventDefault();
                e.stopPropagation(); // the sound, not the selected clip (App's Delete key command)
                askRemove(src.id);
              }}
              title={first ? `Select it on ${first.t.name}; drag it onto the arrangement for another copy` : 'Click to try it on Musical Typing; drag it onto the arrangement to put it on a track'}
            >
              <span className="idea-head">
                <i className="dot" />
                <span className="idea-name">{src.name}</span>
                <span className="idea-dur">{fmtDur(src.duration)}</span>
              </span>
              <MiniWave sourceId={src.id} version={audioVersion} color={color} />
              <span className="idea-meta">
                {ORIGIN[src.origin] ?? src.origin}
                {uses.length ? ` · on ${[...new Set(uses.map((u) => u.t.name))].join(', ')}` : trying ? ' · on Musical Typing' : ' · not on a track'}
              </span>
              {src.credit && <span className="idea-credit" title={src.credit}>{src.credit}</span>}
            </button>
            {versions.length > 1 && (
              <div className="idea-versions" data-testid="idea-versions">
                <button className="idea-versions-toggle" aria-expanded={open === root} onClick={() => setOpen(open === root ? null : root)}>
                  <span className="ver-cur" title={versionLabel(src)}>{versionLabel(src)}</span>
                  <span className="ver-count">{versions.length} versions <span aria-hidden>{open === root ? '▴' : '▾'}</span></span>
                </button>
                {open === root && (
                  <ul>
                    {versions.map((v) => {
                      const on = familyUses.filter((u) => u.c.sourceId === v.id);
                      const all = familyUses.length > 0 && on.length === familyUses.length;
                      return (
                        <li key={v.id} className={`idea-version${v.id === src.id ? ' cur' : ''}`} data-testid={`version-${v.id}`}>
                          <button className="ver-play" aria-label={`Play ${versionLabel(v)}`} title="Listen to this version" disabled={!buffers.get(v.id)} onClick={() => play(v.id)}>
                            {playing === v.id ? '■' : '▶'}
                          </button>
                          <span className="ver-name" title={versionLabel(v)}>{versionLabel(v)}</span>
                          {all ? (
                            <span className="ver-on">in use</span>
                          ) : (
                            <button className="ver-use" disabled={!familyUses.length} title={familyUses.length ? 'Play this version on the arrangement (undoable)' : 'No clips play this sound'} onClick={() => run('use_audio_version', { source_id: v.id })}>
                              Use
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            <button className="idea-del" aria-label="Delete sound" title="Delete this sound (⌫)" onClick={() => askRemove(src.id)}>×</button>
            {confirm === src.id && (
              <div className="idea-confirm" data-testid="idea-confirm" role="alertdialog" aria-label={`Delete ${src.name}?`} onKeyDown={(e) => e.key === 'Escape' && setConfirm(null)}>
                <span>Delete “{src.name}”? {confirmText(uses.filter((u) => !u.c.midi).length, uses.filter((u) => u.c.midi).length)}</span>
                <span className="idea-confirm-actions">
                  <button onClick={() => setConfirm(null)}>Cancel</button>
                  <button className="danger" autoFocus onClick={() => remove(src.id)}>Delete</button>
                </span>
              </div>
            )}
          </div>
        );
      })}
      {kits.map((k) => (
        <KitCard key={k.id} kit={k} session={session} playing={typing && playingKit === k.id} onPlay={() => openDrumPad(session, run, k.id)} onRename={(name) => run('rename_kit', { kit_id: k.id, name })} onDelete={() => run('delete_kit', { kit_id: k.id })} />
      ))}
      <button className="idea-new-kit" data-testid="new-drum-pad" title="Make a sample pad: put any sounds on 9 pads and play them from Q W E / A S D / Z X C" onClick={async () => {
        const r = await run('create_kit', {});
        if (r.ok) openDrumPad(session, run, r.result.kit_id);
      }}>
        + New sample pad
      </button>
    </section>
  );
}

/** Tracks with a region played by a kit, with their positions (for the card's colour and wires). */
const kitUsage = (s: Session, kitId: string) => s.tracks.flatMap((t, i) => (t.clips.some((c) => c.midi?.kit === kitId) ? [{ t, i }] : []));

/** B12: a sample pad's card: its name, a mini 3x3 of filled pads, and the credits its sounds need. */
function KitCard({ kit, session, playing, onPlay, onRename, onDelete }: { kit: Kit; session: Session; playing: boolean; onPlay: () => void; onRename: (name: string) => void; onDelete: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const filled = kit.pads.filter((p) => p.sample).length;
  const credits = [...kitSources(kit)].filter((id) => session.sources[id]?.credit).length;
  const used = kitUsage(session, kit.id);
  const uses = used.map((u) => u.t.name);
  const color = used.length ? trackColor(session, used[0].i) : 'var(--solo)';
  const done = (name: string) => {
    setRenaming(false);
    if (name.trim() && name.trim() !== kit.name) onRename(name);
  };
  return (
    <div
      className="idea idea-kit" data-kit={kit.id} style={{ '--c': color } as React.CSSProperties}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(KIT_MIME, kit.id);
        e.dataTransfer.setData('text/plain', kit.name);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      {renaming && (
        <input
          className="kit-rename"
          data-testid="kit-rename"
          aria-label="Rename sample pad"
          defaultValue={kit.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done(e.currentTarget.value);
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={(e) => done(e.currentTarget.value)}
        />
      )}
      <button
        className={`idea-card${playing ? ' sel' : ''}`}
        data-trying={playing || undefined}
        onClick={onPlay}
        onKeyDown={(e) => {
          if (e.key !== 'Backspace' && e.key !== 'Delete') return;
          e.preventDefault();
          e.stopPropagation();
          onDelete();
        }}
        title="Click to play it on the keyboard window and drop any sounds on its pads there; drag it onto the arrangement for a region on it; double-click the name to rename"
      >
        <span className="idea-head">
          <i className="dot" />
          <span className="idea-name" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(true))}>{kit.name}</span>
          <span className="kit-badge">Kit</span>
        </span>
        <span className="kit-mini" aria-hidden>
          {kit.pads.map((p, i) => <i key={i} className={p.sample ? 'on' : ''} />)}
        </span>
        <span className="idea-meta">
          {filled} of {PAD_COUNT} pads{uses.length ? ` · on ${[...new Set(uses)].join(', ')}` : playing ? ' · on the keyboard' : ''}
        </span>
        {credits > 0 && <span className="idea-credit">{credits} CC-BY credit{credits > 1 ? 's' : ''}</span>}
      </button>
      <button className="idea-del" aria-label="Delete sample pad" title="Delete this sample pad (⌫); takes on it keep playing built-in drums" onClick={onDelete}>×</button>
    </div>
  );
}

/** Bar-style peak overview of a source, drawn once per buffer and again when the card's colour
 *  changes (a canvas keeps the colour it was painted with). */
function MiniWave({ sourceId, version, color }: { sourceId: string; version: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const b = buffers.get(sourceId);
    if (!c || !b) return;
    const draw = () => {
      const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
      c.width = w * dpr;
      c.height = h * dpr;
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);
      g.fillStyle = getComputedStyle(c).color;
      const data = b.getChannelData(0);
      const bars = Math.floor(w / 3);
      const per = Math.max(1, Math.floor(data.length / bars));
      let max = 1e-6;
      const peaks = Array.from({ length: bars }, (_, i) => {
        let p = 0;
        for (let j = i * per; j < Math.min(data.length, (i + 1) * per); j += 8) p = Math.max(p, Math.abs(data[j]));
        max = Math.max(max, p);
        return p;
      });
      peaks.forEach((p, i) => {
        const a = Math.max(1, (p / max) * (h / 2 - 1));
        g.fillRect(i * 3, h / 2 - a, 2, a * 2);
      });
    };
    draw();
    const ro = new ResizeObserver(draw); // redraw when the Ideas column is resized
    ro.observe(c);
    return () => ro.disconnect();
  }, [sourceId, version, color]);
  return <canvas ref={ref} className="idea-wave" data-color={color} aria-hidden />;
}

/** Bezier wires from each idea card to the track headers of the tracks that use it. Positions
 *  are measured in the world's coordinates, so the wires scroll with the canvas. */
export function IdeaWires({ session, worldRef }: { session: Session; worldRef: RefObject<HTMLDivElement | null> }) {
  const [paths, setPaths] = useState<{ d: string; color: string; x0: number; y0: number; x1: number; y1: number }[]>([]);
  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const measure = () => {
      const wr = world.getBoundingClientRect();
      const out: typeof paths = [];
      /** One wire from a card to the header of track `id` (at position `i`). */
      const wire = (card: Element, id: string, i: number) => {
        const head = world.querySelector(`[data-testid="track-${id}"]`);
        if (!head) return;
        const cr = card.getBoundingClientRect();
        const hr = head.getBoundingClientRect();
        // a header scrolled out of a short board: end the wire at the board's visible edge
        const ar = head.closest('.arrange')?.getBoundingClientRect();
        const hy = hr.top + hr.height / 2;
        const y = ar ? Math.min(ar.bottom - 6, Math.max(ar.top + 6, hy)) : hy;
        const x0 = cr.right - wr.left, y0 = cr.top + cr.height / 2 - wr.top;
        const x1 = hr.left - wr.left, y1 = y - wr.top;
        const dx = Math.max(30, (x1 - x0) / 2);
        out.push({ d: `M${x0} ${y0} C${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}`, color: trackColor(session, i), x0, y0, x1, y1 });
      };
      for (const { root, versions } of ideaGroups(session)) {
        const card = world.querySelector(`[data-idea="${root}"]`);
        if (!card) continue;
        const { uses } = usage(session, new Set(versions.map((v) => v.id)));
        for (const id of new Set(uses.map((u) => u.t.id))) wire(card, id, session.tracks.findIndex((t) => t.id === id));
      }
      // B12: sample pads, to the tracks with regions played by them
      for (const kit of Object.values(session.kits ?? {})) {
        const card = world.querySelector(`.idea-kit[data-kit="${kit.id}"]`);
        if (card) for (const { t, i } of kitUsage(session, kit.id)) wire(card, t.id, i);
      }
      setPaths(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(world);
    // resizing the Ideas column, the board or the lanes moves the ends without resizing the world
    world.querySelectorAll('.ideas, .board, .board-col, .arrange-interaction').forEach((el) => ro.observe(el));
    let raf = 0;
    const onScroll = (e: Event) => {
      if (!(e.target as Element).closest?.('.arrange')) return; // the board scrolling its lanes
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    world.addEventListener('scroll', onScroll, true);
    const t = setTimeout(measure, 300); // the playlist lays its rows out a moment after the session changes
    return () => {
      ro.disconnect();
      world.removeEventListener('scroll', onScroll, true);
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [session, worldRef]);
  return (
    <svg className="wires" aria-hidden>
      {paths.map((p, i) => (
        <g key={i} stroke={p.color} fill="none">
          <path d={p.d} strokeWidth={2} opacity={0.8} />
          <circle cx={p.x0} cy={p.y0} r={4} fill={p.color} stroke="none" />
          <circle cx={p.x1} cy={p.y1} r={4} fill="var(--ground)" strokeWidth={2} />
        </g>
      ))}
    </svg>
  );
}
