import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipInteractionProvider,
  Waveform,
  WaveformPlaylistProvider,
  usePlaybackAnimation,
  usePlaylistControls,
  usePlaylistState,
} from '@waveform-playlist/browser';
import type { ClipTrack } from '@waveform-playlist/core';
import { BeatsAndBarsProvider, darkTheme } from '@waveform-playlist/ui-components';
import type { Bridge } from '../core/bridge';
import type { Session } from '../core/session';
import { buffers, decodeFile, diffToToolCalls, newSourceId, sameLayout, toClipTracks } from './audio';
import { clicks } from './click';
import { ControlBar } from './ControlBar';
import { ChatPanel } from './ChatPanel';

// Dark, Logic-ish palette on top of the library's dark theme: blue regions, light waveform.
const theme = {
  ...darkTheme,
  waveformDrawMode: 'normal' as const,
  // (in 'normal' mode the outline colour paints the lane and the fill colour draws the waveform)
  waveOutlineColor: '#1b2230',
  waveFillColor: '#8fb0ff',
  selectedWaveOutlineColor: '#202a3c',
  selectedWaveFillColor: '#b4cbff',
  waveProgressColor: 'rgba(124, 156, 255, 0.25)',
  selectedTrackBackground: '#181c24',
  selectedTrackControlsBackground: '#232837',
  timescaleBackgroundColor: '#15181d',
  timeColor: '#9aa3b2',
  playheadColor: '#f2f2f2',
  clipHeaderBackgroundColor: 'rgba(36, 50, 77, 0.95)',
  clipHeaderTextColor: '#dfe7ff',
  selectedClipHeaderBackgroundColor: '#34497a',
  playlistBackgroundColor: '#111317',
};

export function App({ bridge }: { bridge: Bridge }) {
  const [session, setSession] = useState<Session | null>(null);
  const [tracks, setTracks] = useState<ClipTrack[]>([]);
  const [audioVersion, setAudioVersion] = useState(0); // bumps when a buffer is added
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    bridge.getSession().then(setSession);
    return bridge.onSession(setSession);
  }, [bridge]);

  // session (+ audio) -> playlist tracks; keep the engine's array if nothing changed
  useEffect(() => {
    if (!session) return;
    const derived = toClipTracks(session);
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
  }, []);

  // user drags/trims in the playlist -> same tools Muse uses, logged as feedback
  const onTracksChange = useCallback(
    (next: ClipTrack[]) => {
      setTracks(next);
      if (sessionRef.current) for (const c of diffToToolCalls(sessionRef.current, next)) run(c.tool, c.args);
    },
    [run],
  );

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

  if (!session) return <div className="loading">Loading…</div>;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
      }}
    >
      <main className="daw">
        <WaveformPlaylistProvider theme={theme} tracks={tracks} onTracksChange={onTracksChange} timescale samplesPerPixel={1024} waveHeight={96} controls={{ show: true, width: 210 }} fillViewport>
          <ControlBar session={session} run={run} importFiles={importFiles} addBuffer={addBuffer} />
          <TransportSync session={session} run={run} />
          <SelectionSync run={run} />
          {error && (
            <div className="error" role="alert" onClick={() => setError(null)}>
              {error} <small>(click to dismiss)</small>
            </div>
          )}
          {session.tracks.length === 0 ? (
            <div className="empty" data-testid="empty">Drop a WAV/MP3 here, use Import, or Record from the mic.</div>
          ) : (
            <BeatsAndBarsProvider bpm={session.tempo} timeSignature={session.timeSignature} snapTo="off">
              <ClipInteractionProvider>
                <Waveform showClipHeaders renderTrackControls={(i) => <TrackControls session={session} index={i} run={run} />} />
              </ClipInteractionProvider>
            </BeatsAndBarsProvider>
          )}
          {session.punchIn && (
            <div className="punch">
              Punch-in armed on {session.punchIn.trackId}: {session.punchIn.start}–{session.punchIn.end} s. Press Record.
            </div>
          )}
        </WaveformPlaylistProvider>
      </main>
      <ChatPanel bridge={bridge} />
    </div>
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

function SelectionSync({ run }: { run: Run }) {
  const { selectedTrackId } = usePlaylistState();
  useEffect(() => {
    run('select', { track_id: selectedTrackId ?? undefined });
  }, [selectedTrackId, run]);
  return null;
}

function TrackControls({ session, index, run }: { session: Session; index: number; run: Run }) {
  const t = session.tracks[index];
  const [gain, setGain] = useState(t?.gainDb ?? 0);
  useEffect(() => setGain(t?.gainDb ?? 0), [t?.gainDb]);
  if (!t) return null;
  const commit = () => gain !== t.gainDb && run('set_gain', { track_id: t.id, gain_db: gain });
  return (
    <div className="track-controls" data-testid={`track-${t.id}`}>
      <div className="track-name" title={t.id}>
        {t.name} <small>{t.id}</small>
      </div>
      <div className="track-row">
        <button className={t.muted ? 'on mute' : ''} onClick={() => run('mute', { track_id: t.id, muted: !t.muted })}>M</button>
        <button className={t.soloed ? 'on solo' : ''} onClick={() => run('solo', { track_id: t.id, soloed: !t.soloed })}>S</button>
        <input type="range" min={-60} max={12} step={0.5} value={gain} aria-label={`${t.name} gain`} onChange={(e) => setGain(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
        <span className="db">{gain} dB</span>
      </div>
    </div>
  );
}
