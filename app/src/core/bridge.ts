// The renderer's only door to the outside. Electron: preload -> IPC -> main process
// (Muse, Freesound and keys live there). Plain browser: an in-page mock (renderer/mockBridge.ts).
import type { TurnResult } from './agent';
import type { Session } from './session';
import type { ToolOutcome } from './tools';

export interface Bridge {
  mode: 'electron' | 'web';
  getSession(): Promise<Session>;
  onSession(cb: (s: Session) => void): () => void;
  /** Run a tool on the user's behalf (UI actions). */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** Send a chat message to Muse; resolves when Muse answers (or fails). */
  sendChat(text: string): Promise<{ ok: true; turn: TurnResult } | { ok: false; error: string }>;
}

declare global {
  interface Window {
    lattice?: Bridge;
  }
}
