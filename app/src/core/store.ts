import { emptySession, type Session } from './session';

export type Actor = 'user' | 'muse';

/** Holds the session, notifies listeners, and keeps a log of the user's manual edits
 *  since Muse's last turn (Muse reads them as feedback, then the log is cleared). */
export class SessionStore {
  private session: Session;
  private listeners = new Set<(s: Session) => void>();
  private userEdits: string[] = [];

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

  logUserEdit(text: string): void {
    this.userEdits.push(text);
  }

  /** Returns and clears the user's edits since the last call. */
  takeUserEdits(): string[] {
    const edits = this.userEdits;
    this.userEdits = [];
    return edits;
  }
}
