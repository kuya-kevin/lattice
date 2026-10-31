import { emptySession, select, type Session } from './session';

export type Actor = 'user' | 'muse';

const HISTORY_LIMIT = 100;

interface Snapshot {
  session: Session;
  label: string; // the edit that followed this snapshot, e.g. 'move_clip {"clip_id":"c2",...}'
}

/** Holds the session, notifies listeners, and keeps a log of the user's manual edits
 *  since Muse's last turn (Muse reads them as feedback, then the log is cleared).
 *  Also keeps an undo/redo history of edits (by the user or Muse), like Logic's Undo. */
export class SessionStore {
  private session: Session;
  private listeners = new Set<(s: Session) => void>();
  private userEdits: string[] = [];
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];

  constructor(initial: Session = emptySession()) {
    this.session = initial;
  }

  get(): Session {
    return this.session;
  }

  set(next: Session): void {
    if (next === this.session) return;
    this.session = next;
    for (const l of this.listeners) l(next);
  }

  subscribe(fn: (s: Session) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Oct 30: another project's session: no undo back into the one left, no edits carried over. */
  replace(next: Session): void {
    this.past = [];
    this.future = [];
    this.userEdits = [];
    this.set(next);
  }

  logUserEdit(text: string): void {
    this.userEdits.push(text);
  }

  /** Returns and clears the user's edits since the last call. */
  takeUserEdits(): string[] {
    const edits = this.userEdits;
    this.userEdits = [];
    return edits;
  }

  /** Record that `before` was replaced by an edit (call after the edit was applied). */
  pushHistory(before: Session, label: string): void {
    this.past.push({ session: before, label });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Step back one edit. Transport, selection, track heights and the id counter are kept as
   *  they are now (undo restores the arrangement and mix, not the view). Returns the label
   *  of the undone edit, or null if there was nothing to undo. */
  undo(): string | null {
    const snap = this.past.pop();
    if (!snap) return null;
    this.future.push({ session: this.session, label: snap.label });
    this.set(this.restored(snap.session));
    return snap.label;
  }

  redo(): string | null {
    const snap = this.future.pop();
    if (!snap) return null;
    this.past.push({ session: this.session, label: snap.label });
    this.set(this.restored(snap.session));
    return snap.label;
  }

  /** `target` as the next session: its arrangement and mix, with today's view state (see undo).
   *  Also used to restore a saved version (B11). */
  restored(target: Session): Session {
    const cur = this.session;
    const ids = new Set(target.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]));
    const keep = (id: string | null) => (id && ids.has(id) ? id : null);
    const heights = new Map(cur.tracks.map((t) => [t.id, t.heightScale]));
    return {
      ...target,
      tracks: target.tracks.map(({ heightScale: _, ...t }) => (heights.get(t.id) ? { ...t, heightScale: heights.get(t.id) } : t)), // view setting
      sources: { ...target.sources, ...cur.sources }, // audio stays loaded either way
      transport: cur.transport,
      cycle: cur.cycle, // a transport setting, like the playhead
      mixView: undefined, // B18: a listening setting, not part of the mix (kept below)
      ...(cur.mixView ? { mixView: cur.mixView } : {}),
      voiceReply: cur.voiceReply, // B14: a preference, not part of the arrangement
      selection: {
        ...select(cur, keep(cur.selection.trackId), keep(cur.selection.clipId), cur.selection.clipIds?.filter((c) => ids.has(c))).selection,
        ...(keep(cur.selection.clipId) && cur.selection.notes ? { notes: cur.selection.notes } : {}), // checked by selectedNotes()
      },
      seq: Math.max(cur.seq, target.seq), // never reuse ids
    };
  }
}
