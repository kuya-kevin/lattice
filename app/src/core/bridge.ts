// The renderer's only door to the outside. Electron: preload -> IPC -> main process
// (Muse, Freesound and keys live there). Plain browser: an in-page mock (renderer/mockBridge.ts).
import type { TurnResult } from './agent';
import type { LibraryEntry } from './library';
import type { Features } from './ears';
import type { Session } from './session';
import type { ToolOutcome } from './tools';
import type { RenderJob, RenderOut } from './mixView';
import type { ShelfItem } from './shelf';

export interface Bridge {
  mode: 'electron' | 'web';
  getSession(): Promise<Session>;
  onSession(cb: (s: Session) => void): () => void;
  /** Run a tool on the user's behalf (UI actions). */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** Send a chat message to Muse; resolves when Muse answers (or fails). */
  sendChat(text: string): Promise<{ ok: true; turn: TurnResult } | { ok: false; error: string }>;
  /** B2: a push-to-talk clip (16 kHz mono WAV) -> its transcript (Muse Voice Transcribe). */
  transcribe(wav: ArrayBuffer): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Sound library items (Freesound sets + voice notes). `file` is left out on the wire. */
  listLibrary(): Promise<LibraryEntry[]>;
  /** The encoded audio file (wav/mp3) of a library item, for decoding in the renderer. */
  loadLibraryAudio(id: string): Promise<ArrayBuffer>;
  /** [S3 midi] Hand a source's audio (mono WAV) to the sidecar side, so tools such as
   *  extract_midi (called by the user or Muse) can read it. */
  putSourceAudio(sourceId: string, wav: ArrayBuffer): Promise<void>;
  /** B11: remember where a source's audio is, so a restored session can load it again: the
   *  imported file's path, a library item, or (recordings, files without a path) the bytes. */
  keepSourceAudio(sourceId: string, ref: { path: string } | { library: string } | { bytes: ArrayBuffer }): Promise<void>;
  /** B11: the encoded audio of a source kept with keepSourceAudio, or null if it isn't known.
   *  Rejects if it was known but its file is gone. */
  loadSourceAudio(sourceId: string): Promise<ArrayBuffer | null>;
  /** B9: the renderer answers measure_track (it holds the audio): render the track in this
   *  session as heard and without effects, and measure both. */
  serveMeasure(fn: (session: Session, trackId: string) => Promise<{ wet: Features; dry: Features }>): void;
  /** B17/B18: the renderer answers render jobs (export_sound, star_sound, export_stems, the
   *  dry/wet loudness match): it holds the audio. */
  serveRender(fn: <J extends RenderJob>(session: Session, job: J) => Promise<RenderOut[J['kind']]>): void;
  /** B17: the sound shelves (Starred, My Sounds), newest first; and a call when they change. */
  listShelf(): Promise<ShelfItem[]>;
  onShelf(cb: () => void): () => void;
  /** B17: a shelf sound's encoded audio (for preview). */
  loadShelfAudio(id: string): Promise<ArrayBuffer>;
  /** Electron only: the on-disk path of a dropped or picked file ('' if it has none). */
  pathForFile?(file: File): string;
  /** Electron only: zoom the whole window (Chromium page zoom, like ⌘+ / ⌘−). Every layout
   *  scales together, so timeline pixel math is unaffected. 1 = 100 %. */
  setZoom?(factor: number): void;
  getZoom?(): number;
}

declare global {
  interface Window {
    lattice?: Bridge;
  }
}
