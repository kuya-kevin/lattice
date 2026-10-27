import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Waveform,
  WaveformPlaylistProvider,
  usePlaybackAnimation,
  usePlaylistControls,
  usePlaylistData,
  usePlaylistState,
} from '@waveform-playlist/browser';
import type { ClipTrack } from '@waveform-playlist/core';
import { BeatsAndBarsProvider, darkTheme } from '@waveform-playlist/ui-components';
import type { Bridge } from '../core/bridge';
import { attribution, needsAttribution } from '../core/library';
import type { Session } from '../core/session';
import { SNAP_LABELS, SNAP_MODES, type SnapMode } from '../core/snap';
import { ArrangeInteraction, type DropTarget } from './Arrange';
import { buffers, decodeFile, diffToToolCalls, newSourceId, sameLayout, toClipTracks } from './audio';
import { clicks } from './click';
import { ControlBar } from './ControlBar';
import { ChatPanel } from './ChatPanel';
import { Icon } from './icons';
import { IdeaWires, Ideas, ideaSources } from './Ideas';
import { LibraryPanel } from './LibraryPanel';
import { libraryBuffer } from './libraryAudio';
import { ColumnHandles, LaneHeightControl, SplitHandle, useLayoutSizes } from './Resizable';
import { editShortcutFor, type EditAction } from './shortcuts';
import { SmartControls } from './SmartControls';
import { TrackHeader, trackColor } from './TrackHeader';
import { DevicePanel, useFxEngine, withTrackFx } from './DevicePanel'; // [S1 fx] effects engine + device panel
import { ExtractMidiControl, uploadSourceAudio } from './ExtractMidi'; // [S3 midi] audio -> MIDI
import { useMidiRenders } from './midiSynth'; // [S3 midi] MIDI clip playback
import { MusicalTypingButton, MusicalTypingKeyboard, musicalTyping } from './MusicalTyping'; // letter keys play notes

// Canvas theme on top of the library's dark theme: blue-black islands, regions tinted by track
// colour (see trackColorCss), white bar waveforms that styles.css tints to the track colour.
const theme = {
  ...darkTheme,
  waveformDrawMode: 'normal' as const,
  // (in 'normal' mode the outline colour paints the lane and the fill colour draws the waveform)
  waveOutlineColor: 'rgba(0, 0, 0, 0)', // transparent: the region body colour comes from CSS
  waveFillColor: '#ffffff',
  selectedWaveOutlineColor: 'rgba(0, 0, 0, 0)',
  selectedWaveFillColor: '#ffffff',
  waveProgressColor: 'rgba(255, 255, 255, 0.08)',
  selectedTrackBackground: '#191b20',
  selectedTrackControlsBackground: '#1c1f24',
  timescaleBackgroundColor: '#15171b',
  timeColor: '#8a909c',
  playheadColor: '#5fd0e0',
  clipHeaderBackgroundColor: '#252830',
  clipHeaderTextColor: '#e7e9ee',
  selectedClipHeaderBackgroundColor: '#2c3038',
  playlistBackgroundColor: '#15171b',
  loopRegionColor: 'rgba(95, 208, 224, 0.16)',
  loopMarkerColor: '#5fd0e0',
};

/** Region colour per track, by track id (the library themes all clips alike). Regions on
 *  muted tracks turn grey, as in Logic. */
function trackColorCss(session: Session): string {
  return session.tracks
    .map((t, i) => `[data-track-row][data-track-id="${t.id}"] [data-clip-container] { --region-color: ${t.muted ? '#5b616d' : trackColor(i)}; }`)
    .join('\n');
}

/** Timeline zoom steps (samples per pixel); 1024 is 100 %. */
const ZOOM_LEVELS = [256, 512, 1024, 2048, 4096, 8192];

/** Drag on empty canvas ground to pan (the canvas also scrolls with a trackpad or wheel). */
function usePan() {
  const ref = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const el = ref.current;
    const t = e.target as HTMLElement;
    if (!el || e.button !== 0 || !(t === el || t.classList.contains('world'))) return;
    const start = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    el.classList.add('panning');
    const move = (ev: PointerEvent) => el.scrollTo(start.l - (ev.clientX - start.x), start.t - (ev.clientY - start.y));
    const up = () => {
      el.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { ref, onPointerDown };
}

export function App({ bridge }: { bridge: Bridge }) {
  const [session, setSession] = useState<Session | null>(null);
  const [tracks, setTracks] = useState<ClipTrack[]>([]);
  const [audioVersion, setAudioVersion] = useState(0); // bumps when a buffer is added
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const tracksRef = useRef<ClipTrack[]>([]);
  tracksRef.current = tracks;
  const trimmingRef = useRef(false);

  // ─── region: layout state (floating panels, device chain, snap) ───
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [museOpen, setMuseOpen] = useState(() => window.innerWidth >= 1440); // the conversation panel
  const [smartOpen, setSmartOpen] = useState(true);
  const pan = usePan();
  const layout = useLayoutSizes(); // resizable ideas / board / device chain + lane height
  const worldRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<SnapMode>('beat');
  const lastSnap = useRef<SnapMode>('beat');
  if (snap !== 'off') lastSnap.current = snap;
  // ─── end region ───

  useEffect(() => {
    bridge.getSession().then(setSession);
    return bridge.onSession(setSession);
  }, [bridge]);

  useFxEngine(session); // [S1 fx] keep live effect chains in step with the session

  // session (+ audio) -> playlist tracks; keep the engine's array if nothing changed
  useEffect(() => {
    if (!session) return;
    const derived = withTrackFx(toClipTracks(session, layout.sizes.waveHeight)); // [S1 fx] per-track effects hook
    setTracks((cur) => (sameLayout(cur, derived) ? cur : derived));
  }, [session, audioVersion, layout.sizes.waveHeight]);

  const run = useCallback(
    async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await bridge.runTool(tool, args);
      if (!r.ok) setError(`${tool}: ${r.error}`);
      return r;
    },
    [bridge],
  );

  const addBuffer = useCallback((id: string, b: AudioBuffer) => {
    buffers.set(id, b);
    setAudioVersion((v) => v + 1);
    uploadSourceAudio(bridge, id, b); // [S3 midi] so extract_midi (user or Muse) can read it
  }, [bridge]);

  // ─── region: [S3 midi] MIDI clip playback (rendered offline, played as audio) ───
  const setMidiRender = useCallback((id: string, b: AudioBuffer) => {
    buffers.set(id, b);
    setAudioVersion((v) => v + 1);
  }, []);
  useMidiRenders(session, setMidiRender);
  // ─── end region ───

  // user drags/trims in the playlist -> same tools Muse uses, logged as feedback.
  // During a trim drag the engine reports every frame; we commit once when it ends.
  const onTracksChange = useCallback(
    (next: ClipTrack[]) => {
      setTracks(next);
      if (trimmingRef.current) return;
      if (sessionRef.current) for (const c of diffToToolCalls(sessionRef.current, next)) run(c.tool, c.args);
    },
    [run],
  );
  const commitTracks = useCallback(async () => {
    const s = await bridge.getSession(); // fresh: the engine may already have committed the trim
    for (const c of diffToToolCalls(s, tracksRef.current)) run(c.tool, c.args);
  }, [bridge, run]);

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        try {
          const b = await decodeFile(file);
          const id = newSourceId();
          addBuffer(id, b);
          await run('import_audio', { source_id: id, name: file.name.replace(/\.[^.]+$/, ''), duration: b.duration, origin: 'import' });
        } catch (e) {
          setError(`Could not import ${file.name}: ${e instanceof Error ? e.message : e}`);
        }
      }
    },
    [addBuffer, run],
  );

  // ─── region: sound library drops ───
  const placeLibrarySound = useCallback(
    async (id: string, target: DropTarget) => {
      try {
        const [items, b] = await Promise.all([bridge.listLibrary(), libraryBuffer(bridge, id)]);
        const item = items.find((i) => i.id === id);
        const sourceId = newSourceId();
        addBuffer(sourceId, b);
        await run('place_audio', {
          source_id: sourceId,
          name: (item?.name ?? id).replace(/\.(wav|mp3|aiff?|flac|ogg|m4a)$/i, ''),
          duration: b.duration,
          origin: item?.set === 'voice_notes' ? 'record' : 'freesound',
          start: target.start,
          ...(target.trackId ? { track_id: target.trackId } : {}),
          ...(item && needsAttribution(item) ? { credit: attribution(item) } : {}),
        });
      } catch (e) {
        setError(`Could not add ${id}: ${e instanceof Error ? e.message : e}`);
      }
    },
    [bridge, addBuffer, run],
  );
  // ─── end region ───

  // ─── region: edit / window key commands (undo, delete, copy/paste, O, B, Cmd-G) ───
  const editActions = useRef<Record<EditAction, () => void>>(null!);
  const copiedClip = useRef<string | null>(null); // clip id; a paste copies it as it is now
  const playheadRef = useRef<() => number>(() => sessionRef.current?.transport.position ?? 0); // set by TransportSync
  editActions.current = {
    undo: () => run('undo'),
    redo: () => run('redo'),
    deleteClip: () => {
      const c = sessionRef.current?.selection.clipId;
      if (c) run('delete_clip', { clip_id: c });
    },
    copyClip: () => {
      const c = sessionRef.current?.selection.clipId;
      if (c) copiedClip.current = c;
    },
    // Logic: paste at the playhead on the selected track (else the copied clip's own track)
    pasteClip: () => {
      const c = copiedClip.current;
      const trackId = sessionRef.current?.selection.trackId;
      if (c) run('duplicate_clip', { clip_id: c, start: playheadRef.current(), ...(trackId ? { track_id: trackId } : {}) });
    },
    toggleLibrary: () => setLibraryOpen((o) => !o),
    toggleSmartControls: () => setSmartOpen((o) => !o),
    toggleSnap: () => setSnap((s) => (s === 'off' ? lastSnap.current : 'off')),
    musicalTyping: () => musicalTyping.toggle(),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = editShortcutFor(e);
      if (!a) return;
      if (a === 'copyClip' && document.getSelection()?.toString()) return; // copying text (e.g. from the chat)
      e.preventDefault();
      if (!e.repeat) editActions.current[a]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // ─── end region ───

  if (!session) return <div className="loading">Loading…</div>;

  const selTrack = session.tracks.find((t) => t.id === session.selection.trackId) ?? null;
  const selClip = selTrack?.clips.find((c) => c.id === session.selection.clipId) ?? null;
  const museContext = selTrack ? (selClip && selClip.name !== selTrack.name ? `${selTrack.name} · ${selClip.name}` : selTrack.name) : null;

  return (
    <WaveformPlaylistProvider theme={theme} tracks={tracks} onTracksChange={onTracksChange} timescale samplesPerPixel={1024} zoomLevels={ZOOM_LEVELS} waveHeight={layout.sizes.waveHeight} barWidth={2} barGap={1} controls={{ show: true, width: 210 }} fillViewport indefinitePlayback>
      <div
        className={`app${museOpen ? ' muse-open' : ''}${libraryOpen ? ' library-open' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
        }}
      >
        <TransportSync session={session} run={run} playheadRef={playheadRef} />
        <SelectionSync session={session} run={run} getSession={bridge.getSession} />
        <style>{trackColorCss(session)}</style>

        {/* ─── region: the canvas (dot grid; ideas, arrangement board and device chain float on it) ─── */}
        <div className="canvas" ref={pan.ref} onPointerDown={pan.onPointerDown}>
          <div className="world" ref={worldRef} style={layout.worldStyle}>
            <IdeaWires session={session} worldRef={worldRef} />
            <Ideas session={session} run={run} audioVersion={audioVersion} />

            {/* split: the board and device chain share the window height (see Resizable.tsx) */}
            <div className={`board-col${layout.sizes.boardW !== null ? ' fixed-w' : ''}${smartOpen && session.tracks.length > 0 ? ' split' : ''}`}>
              <ColumnHandles layout={layout} ideas={ideaSources(session).length > 0} />
              <div className="frame-title">
                <b>Arrangement</b>
                {session.tempo} BPM · {session.timeSignature.join('/')}{session.key ? ` · ${session.key}` : ''}
              </div>
              <section className="board island" aria-label="Arrangement">
                {/* ─── region: tracks area (toolbar + arrange) ─── */}
                <div className="tracks-toolbar" role="toolbar" aria-label="Tracks">
                  <div className="group">
                    <span className="tb-label">Snap</span>
                    <div className="seg" role="radiogroup" aria-label="Snap">
                      {SNAP_MODES.map((m) => (
                        <button key={m} role="radio" aria-checked={snap === m} className={snap === m ? 'on' : ''} onClick={() => setSnap(m)} title={`Snap: ${SNAP_LABELS[m]} (⌘G toggles)`}>
                          {SNAP_LABELS[m]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <LaneHeightControl layout={layout} />
                  <TimelineZoom />
                  <div className="spacer" />
                  {/* ─── region: [S3 midi] Extract MIDI (source-prep sidecar) ─── */}
                  <ExtractMidiControl session={session} bridge={bridge} run={run} />
                  {/* ─── end region ─── */}
                </div>

                <main className="arrange">
                  {error && (
                    <div className="error" role="alert" onClick={() => setError(null)}>
                      {error} <small>(click to dismiss)</small>
                    </div>
                  )}
                  <ArrangeInteraction session={session} snap={snap} run={run} trimmingRef={trimmingRef} commitTracks={commitTracks} onDropSound={placeLibrarySound}>
                    {session.tracks.length === 0 ? (
                      <div className="empty" data-testid="empty">
                        <strong>Start with a sound</strong>
                        Drop a voice note or any WAV/MP3 here, drag one in from the Library (O), use Import, or record from the mic (R).
                      </div>
                    ) : (
                      <BeatsAndBarsProvider bpm={session.tempo} timeSignature={session.timeSignature} snapTo={snap === 'sixteenth' ? 'beat' : snap}>
                        <Waveform showClipHeaders interactiveClips renderTrackControls={(i) => <TrackHeader session={session} index={i} run={run} />} />
                      </BeatsAndBarsProvider>
                    )}
                  </ArrangeInteraction>
                  {session.punchIn && (
                    <div className="punch">
                      Punch-in armed on {session.punchIn.trackId}: {session.punchIn.start}–{session.punchIn.end} s. Press Record.
                    </div>
                  )}
                </main>
                {/* ─── end region: tracks area ─── */}
              </section>

              {/* ─── region: Smart Controls / DevicePanel mount (effects agent) ─── */}
              {smartOpen && session.tracks.length > 0 && <SplitHandle layout={layout} />}
              {smartOpen && session.tracks.length > 0 && (
                <SmartControls session={session} onClose={() => setSmartOpen(false)}>
                  <DevicePanel session={session} run={run} /> {/* [S1 fx] device panel */}
                </SmartControls>
              )}
              {/* ─── end region: Smart Controls ─── */}
            </div>
          </div>
        </div>
        {/* ─── end region: canvas ─── */}

        {/* ─── region: floating chrome (top bar, Muse, library, tool rail, zoom) ─── */}
        <ControlBar session={session} run={run} importFiles={importFiles} addBuffer={addBuffer} />
        <ChatPanel bridge={bridge} open={museOpen} onOpenChange={setMuseOpen} context={museContext} />
        <aside className="library-float island" aria-label="Sound library" hidden={!libraryOpen}>
          <LibraryPanel bridge={bridge} />
        </aside>
        <nav className="rail island" aria-label="Panels">
          <button className={`ibtn${museOpen ? ' on' : ''}`} aria-pressed={museOpen} title="Muse conversation" aria-label="Muse" onClick={() => setMuseOpen((o) => !o)}><Icon name="spark" /></button>
          <button className={`ibtn${libraryOpen ? ' on' : ''}`} aria-pressed={libraryOpen} title="Sound library (O)" aria-label="Library" onClick={() => editActions.current.toggleLibrary()}><Icon name="library" /></button>
          <button className={`ibtn${smartOpen ? ' on' : ''}`} aria-pressed={smartOpen} title="Device chain (B)" aria-label="Smart Controls" onClick={() => editActions.current.toggleSmartControls()}><Icon name="knob" /></button>
          <MusicalTypingButton className="ibtn"><Icon name="keys" /></MusicalTypingButton>
          <hr />
          <button className={`ibtn${snap !== 'off' ? ' on' : ''}`} aria-pressed={snap !== 'off'} title="Snap to grid (⌘G)" aria-label="Snap to grid" onClick={() => editActions.current.toggleSnap()}><Icon name="magnet" /></button>
        </nav>
        <ZoomBar run={run} bridge={bridge} />
        <MusicalTypingKeyboard session={session} />
        {/* ─── end region: floating chrome ─── */}
      </div>
    </WaveformPlaylistProvider>
  );
}

/** Bottom-right island: undo / redo and the window zoom (Electron page zoom: everything on the
 *  canvas and the floating chrome scales together, like ⌘+ / ⌘− in the View menu). */
function ZoomBar({ run, bridge }: { run: Run; bridge: Bridge }) {
  const zoom = useWindowZoom(bridge);
  return (
    <div className="zoombar island" role="toolbar" aria-label="Edit and zoom">
      <button className="ibtn" title="Undo (⌘Z)" aria-label="Undo" onClick={() => run('undo')}><Icon name="undo" /></button>
      <button className="ibtn" title="Redo (⇧⌘Z)" aria-label="Redo" onClick={() => run('redo')}><Icon name="redo" /></button>
      {zoom && (
        <>
          <span className="sep" />
          <button className="ibtn" title="Zoom out the window (⌘−)" aria-label="Zoom out window" disabled={!zoom.canOut} onClick={zoom.out}><Icon name="minus" /></button>
          <button className="zoom-pct" title="Window zoom: click for 100 % (⌘0)" aria-label="Window zoom" data-testid="window-zoom" onClick={zoom.reset}>{Math.round(zoom.factor * 100)}%</button>
          <button className="ibtn" title="Zoom in the window (⌘+)" aria-label="Zoom in window" disabled={!zoom.canIn} onClick={zoom.in}><Icon name="plus" /></button>
        </>
      )}
    </div>
  );
}

const WINDOW_ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const WINDOW_ZOOM_KEY = 'lattice.windowZoom';

/** The window zoom (null in the web build, which has no page zoom). Remembered across launches;
 *  follows ⌘+ / ⌘− / ⌘0 from the View menu too (a zoom change resizes the CSS viewport). */
function useWindowZoom(bridge: Bridge) {
  const { setZoom, getZoom } = bridge;
  const [factor, setFactor] = useState(() => getZoom?.() ?? 1);
  useEffect(() => {
    if (!setZoom || !getZoom) return;
    try {
      const saved = Number(localStorage.getItem(WINDOW_ZOOM_KEY));
      if (saved >= WINDOW_ZOOMS[0] && saved <= WINDOW_ZOOMS[WINDOW_ZOOMS.length - 1]) setZoom(saved);
    } catch {
      // storage blocked: start at whatever Chromium remembers
    }
    const sync = () => setFactor(getZoom());
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [setZoom, getZoom]);
  if (!setZoom || !getZoom) return null;
  const apply = (f: number) => {
    setZoom(f);
    setFactor(f);
    try {
      localStorage.setItem(WINDOW_ZOOM_KEY, String(f));
    } catch {
      // not remembered
    }
  };
  const lower = [...WINDOW_ZOOMS].reverse().find((z) => z < factor - 0.001);
  const higher = WINDOW_ZOOMS.find((z) => z > factor + 0.001);
  return {
    factor,
    canOut: lower !== undefined,
    canIn: higher !== undefined,
    out: () => lower !== undefined && apply(lower),
    in: () => higher !== undefined && apply(higher),
    reset: () => apply(1),
  };
}

/** Tracks toolbar: the timeline's horizontal zoom (samples per pixel; 100 % = 1024). */
function TimelineZoom() {
  const { zoomIn, zoomOut } = usePlaylistControls();
  const { samplesPerPixel, canZoomIn, canZoomOut } = usePlaylistData();
  return (
    <div className="group" role="group" aria-label="Timeline zoom">
      <span className="tb-label" title="Timeline zoom (horizontal)">Zoom</span>
      <div className="seg lane-h">
        <button aria-label="Zoom out" title="Zoom the timeline out" disabled={!canZoomOut} onClick={zoomOut}><Icon name="minus" size={14} /></button>
        <span className="zoom-pct" title="Timeline zoom">{Math.round((1024 / samplesPerPixel) * 100)}%</span>
        <button aria-label="Zoom in" title="Zoom the timeline in" disabled={!canZoomIn} onClick={zoomIn}><Icon name="plus" size={14} /></button>
      </div>
    </div>
  );
}

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** Keeps the engine in step with session.transport (set by the play/stop/go_to tools, from
 *  the UI or from Muse), and runs the click while playing. Also lends App the engine's
 *  playhead (a timeline click moves it without touching the session) for paste. */
function TransportSync({ session, run, playheadRef }: { session: Session; run: Run; playheadRef: React.MutableRefObject<() => number> }) {
  const { play, pause, seekTo } = usePlaylistControls();
  const { isPlaying, getPlaybackTime, getLookAhead, currentTimeRef } = usePlaybackAnimation();
  playheadRef.current = () => currentTimeRef.current ?? session.transport.position;
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  const { command, position, rev, playing } = session.transport;

  useEffect(() => {
    if (rev === 0) return;
    if (command === 'play') play(position);
    else if (command === 'stop') playingRef.current && pause();
    else if (playingRef.current) play(position); // locate while playing: continue from there
    else seekTo(position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  // playback ended on its own: tell the session. With indefinitePlayback the transport rolls
  // past the last region (DAW-style), so this is only a fallback for engine-side stops.
  useEffect(() => {
    if (!isPlaying && playing) run('stop', { at: currentTimeRef.current ?? 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // click track while playing. getPlaybackTime() runs lookAhead ahead of what is being
  // emitted to the speakers right now, so the position at audio-clock "now" is time - lookAhead.
  const { on } = session.metronome;
  const [beats, unit] = session.timeSignature;
  useEffect(() => {
    if (!isPlaying || !on) return;
    clicks.start(getPlaybackTime() - getLookAhead(), { tempo: session.tempo, timeSignature: [beats, unit] });
    return () => clicks.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, on, session.tempo, beats, unit, rev]);
  return null;
}

/** Playlist track selection (a click in a lane) -> session, keeping the selected clip if it
 *  is on that track; session selection (Muse, a header or clip click, a move) -> playlist
 *  highlight. Reads the session fresh from the bridge so a stale render can't undo a newer
 *  selection. */
function SelectionSync({ session, run, getSession }: { session: Session; run: Run; getSession: () => Promise<Session> }) {
  const { selectedTrackId } = usePlaylistState();
  const { setSelectedTrackId } = usePlaylistControls();
  useEffect(() => {
    let live = true;
    getSession().then((s) => {
      if (!live || (selectedTrackId ?? null) === s.selection.trackId) return;
      const keep = s.selection.clipId && s.tracks.find((t) => t.id === selectedTrackId)?.clips.some((c) => c.id === s.selection.clipId);
      run('select', { track_id: selectedTrackId ?? undefined, clip_id: keep ? s.selection.clipId : undefined });
    });
    return () => {
      live = false;
    };
  }, [selectedTrackId, run, getSession]);
  const sel = session.selection.trackId;
  useEffect(() => {
    if (sel && sel !== selectedTrackId) setSelectedTrackId(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  return null;
}
