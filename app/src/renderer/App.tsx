import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Waveform,
  WaveformPlaylistProvider,
  usePlaybackAnimation,
  usePlaylistControls,
  usePlaylistState,
} from '@waveform-playlist/browser';
import type { ClipTrack } from '@waveform-playlist/core';
import { BeatsAndBarsProvider, darkTheme } from '@waveform-playlist/ui-components';
import type { Bridge } from '../core/bridge';
import { attribution, needsAttribution } from '../core/library';
import type { Session } from '../core/session';
import type { SnapMode } from '../core/snap';
import { ArrangeInteraction, type DropTarget } from './Arrange';
import { buffers, decodeFile, diffToToolCalls, newSourceId, sameLayout, toClipTracks } from './audio';
import { clicks } from './click';
import { ControlBar } from './ControlBar';
import { ChatPanel } from './ChatPanel';
import { LibraryPanel } from './LibraryPanel';
import { libraryBuffer } from './libraryAudio';
import { editShortcutFor, type EditAction } from './shortcuts';
import { SmartControls } from './SmartControls';
import { TrackHeader, trackColor } from './TrackHeader';
import { DevicePanel, useFxEngine, withTrackFx } from './DevicePanel'; // [S1 fx] effects engine + device panel
import { ExtractMidiControl, uploadSourceAudio } from './ExtractMidi'; // [S3 midi] audio -> MIDI
import { useMidiRenders } from './midiSynth'; // [S3 midi] MIDI clip playback

// Logic Pro-like dark theme on top of the library's dark theme: neutral greys, coloured
// region headers (per track, see trackColorCss), light waveforms on a dark region body.
const theme = {
  ...darkTheme,
  waveformDrawMode: 'normal' as const,
  // (in 'normal' mode the outline colour paints the lane and the fill colour draws the waveform)
  waveOutlineColor: 'rgba(0, 0, 0, 0)', // transparent: the region body colour comes from CSS
  waveFillColor: '#9fc3ef',
  selectedWaveOutlineColor: 'rgba(0, 0, 0, 0)',
  selectedWaveFillColor: '#c4dcfa',
  waveProgressColor: 'rgba(255, 255, 255, 0.10)',
  selectedTrackBackground: '#26282c',
  selectedTrackControlsBackground: '#3a3c42',
  timescaleBackgroundColor: '#2a2b2f',
  timeColor: '#a7a9ae',
  playheadColor: '#f4f4f4',
  clipHeaderBackgroundColor: '#3d8ee6',
  clipHeaderTextColor: '#0b1420',
  selectedClipHeaderBackgroundColor: '#5aa2f0',
  playlistBackgroundColor: '#1d1e21',
  loopRegionColor: 'rgba(224, 178, 58, 0.25)',
  loopMarkerColor: '#e0b23a',
};

/** Region colour per track, by track id (the library themes all clips alike). Regions on
 *  muted tracks turn grey, as in Logic. */
function trackColorCss(session: Session): string {
  return session.tracks
    .map((t, i) => `[data-track-row][data-track-id="${t.id}"] [data-clip-container] { --region-color: ${t.muted ? '#6d6e73' : trackColor(i)}; }`)
    .join('\n');
}

type RightTab = 'library' | 'muse';

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

  // ─── region: layout state (right pane tabs, Smart Controls, snap) ───
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTab>('muse');
  const [smartOpen, setSmartOpen] = useState(true);
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
    const derived = withTrackFx(toClipTracks(session)); // [S1 fx] per-track effects hook
    setTracks((cur) => (sameLayout(cur, derived) ? cur : derived));
  }, [session, audioVersion]);

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

  // ─── region: edit / window key commands (undo, delete, O, B, Cmd-G) ───
  const editActions = useRef<Record<EditAction, () => void>>(null!);
  editActions.current = {
    undo: () => run('undo'),
    redo: () => run('redo'),
    deleteClip: () => {
      const c = sessionRef.current?.selection.clipId;
      if (c) run('delete_clip', { clip_id: c });
    },
    toggleLibrary: () => {
      if (rightOpen && rightTab === 'library') setRightOpen(false);
      else {
        setRightOpen(true);
        setRightTab('library');
      }
    },
    toggleSmartControls: () => setSmartOpen((o) => !o),
    toggleSnap: () => setSnap((s) => (s === 'off' ? lastSnap.current : 'off')),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = editShortcutFor(e);
      if (!a) return;
      e.preventDefault();
      if (!e.repeat) editActions.current[a]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // ─── end region ───

  if (!session) return <div className="loading">Loading…</div>;

  return (
    <WaveformPlaylistProvider theme={theme} tracks={tracks} onTracksChange={onTracksChange} timescale samplesPerPixel={1024} waveHeight={84} controls={{ show: true, width: 220 }} fillViewport>
      <div
        className={`app${rightOpen ? '' : ' right-closed'}${smartOpen ? '' : ' smart-closed'}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
        }}
      >
        <ControlBar session={session} run={run} importFiles={importFiles} addBuffer={addBuffer} />
        <TransportSync session={session} run={run} />
        <SelectionSync session={session} run={run} getSession={bridge.getSession} />
        <style>{trackColorCss(session)}</style>

        {/* ─── region: tracks area (toolbar + arrange) ─── */}
        <div className="tracks-toolbar" role="toolbar" aria-label="Tracks">
          <div className="group">
            <span className="tb-label">Snap</span>
            <div className="seg" role="radiogroup" aria-label="Snap">
              {(['off', 'bar', 'beat'] as SnapMode[]).map((m) => (
                <button key={m} role="radio" aria-checked={snap === m} className={snap === m ? 'on' : ''} onClick={() => setSnap(m)} title={`Snap: ${m} (⌘G toggles)`}>
                  {m === 'off' ? 'Off' : m === 'bar' ? 'Bar' : 'Beat'}
                </button>
              ))}
            </div>
          </div>
          <div className="group">
            <button title="Undo (⌘Z)" aria-label="Undo" onClick={() => run('undo')}>↶</button>
            <button title="Redo (⇧⌘Z)" aria-label="Redo" onClick={() => run('redo')}>↷</button>
          </div>
          {/* ─── region: [S3 midi] Extract MIDI (source-prep sidecar) ─── */}
          <ExtractMidiControl session={session} bridge={bridge} run={run} />
          {/* ─── end region ─── */}
          <div className="spacer" />
          <div className="group">
            <button className={smartOpen ? 'on' : ''} aria-pressed={smartOpen} title="Smart Controls (B)" onClick={() => editActions.current.toggleSmartControls()}>Smart Controls</button>
            <button className={rightOpen && rightTab === 'library' ? 'on' : ''} aria-pressed={rightOpen && rightTab === 'library'} title="Sound library (O)" onClick={() => editActions.current.toggleLibrary()}>Library</button>
            <button className={rightOpen && rightTab === 'muse' ? 'on' : ''} aria-pressed={rightOpen && rightTab === 'muse'} title="Muse chat" onClick={() => (rightOpen && rightTab === 'muse' ? setRightOpen(false) : (setRightOpen(true), setRightTab('muse')))}>Muse</button>
          </div>
        </div>

        <main className="arrange">
          {error && (
            <div className="error" role="alert" onClick={() => setError(null)}>
              {error} <small>(click to dismiss)</small>
            </div>
          )}
          <ArrangeInteraction session={session} snap={snap} run={run} trimmingRef={trimmingRef} commitTracks={commitTracks} onDropSound={placeLibrarySound}>
            {session.tracks.length === 0 ? (
              <div className="empty" data-testid="empty">Drop a WAV/MP3 or a sound from the Library here, use Import, or Record from the mic.</div>
            ) : (
              <BeatsAndBarsProvider bpm={session.tempo} timeSignature={session.timeSignature} snapTo={snap}>
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

        {/* ─── region: Smart Controls / DevicePanel mount (effects agent) ───
            Put the effects UI inside <SmartControls>, e.g.
              <SmartControls ...>{selectedTrackId && <DevicePanel trackId={selectedTrackId} run={run} />}</SmartControls>
            With no children it shows a placeholder for the selected track. */}
        {smartOpen && (
          <SmartControls session={session} onClose={() => setSmartOpen(false)}>
            <DevicePanel session={session} run={run} /> {/* [S1 fx] device panel */}
          </SmartControls>
        )}
        {/* ─── end region: Smart Controls ─── */}

        {/* ─── region: right pane (Library / Muse tabs) ─── */}
        <aside className="right-pane" aria-label="Library and Muse" hidden={!rightOpen}>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={rightTab === 'library'} className={rightTab === 'library' ? 'on' : ''} onClick={() => setRightTab('library')}>Library</button>
            <button role="tab" aria-selected={rightTab === 'muse'} className={rightTab === 'muse' ? 'on' : ''} onClick={() => setRightTab('muse')}>Muse</button>
            <button className="close" title="Hide (O)" aria-label="Hide panel" onClick={() => setRightOpen(false)}>×</button>
          </div>
          <div className="tab-body" hidden={rightTab !== 'library'}>
            <LibraryPanel bridge={bridge} />
          </div>
          <div className="tab-body" hidden={rightTab !== 'muse'}>
            <ChatPanel bridge={bridge} />
          </div>
        </aside>
        {/* ─── end region: right pane ─── */}
      </div>
    </WaveformPlaylistProvider>
  );
}

type Run = (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>;

/** Keeps the engine in step with session.transport (set by the play/stop/go_to tools, from
 *  the UI or from Muse), and runs the click while playing. */
function TransportSync({ session, run }: { session: Session; run: Run }) {
  const { play, pause, seekTo } = usePlaylistControls();
  const { isPlaying, getPlaybackTime, getLookAhead, currentTimeRef } = usePlaybackAnimation();
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

  // playback ended on its own (end of audio): tell the session
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
