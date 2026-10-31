// Projects on disk (B11; several since Oct 30), under the app's userData folder:
//   projects.json        the project list (names, times) and which one is open
//   project/             the first project (where B11 kept the only one), then projects/p<n>/
// and in each project's folder:
//   session.json         autosave of the open session (debounced after each change)
//   versions/            index.json (names, times) + one v<n>.json per version
//   audio/refs.json      where each source's audio is: the imported file's path, a library id,
//   audio/<id>.audio     or (recordings, files without a path) the encoded audio kept here
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProjectIndex, type ProjectMeta } from '../core/projects';
import type { Session } from '../core/session';
import type { SessionStore } from '../core/store';
import type { Version, VersionLibrary, VersionMeta } from '../core/versions';

function readJson<T>(file: string, what: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    console.warn(`${what}: could not read ${file}: ${(e as Error).message}`);
    return null;
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a file. */
function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(data));
  renameSync(`${file}.tmp`, file);
}

export class FileVersionLibrary implements VersionLibrary {
  private index: VersionMeta[]; // oldest first
  private cache = new Map<string, Session>(); // versions never change once saved

  constructor(private dir: string) {
    this.index = readJson<{ versions: VersionMeta[] }>(join(dir, 'index.json'), 'versions')?.versions ?? [];
  }

  list(): VersionMeta[] {
    return [...this.index].reverse();
  }

  get(id: string): Version | undefined {
    const meta = this.index.find((v) => v.id === id);
    const session = meta && (this.cache.get(id) ?? readJson<Session>(join(this.dir, `${id}.json`), 'version'));
    if (meta && session) this.cache.set(id, session);
    return meta && session ? { ...meta, session } : undefined;
  }

  save(v: { name: string; auto: boolean; session: Session }): VersionMeta {
    const n = Math.max(0, ...this.index.map((m) => Number(m.id.slice(1)) || 0)) + 1;
    const meta: VersionMeta = { id: `v${n}`, name: v.name, auto: v.auto, savedAt: new Date().toISOString() };
    writeJson(join(this.dir, `${meta.id}.json`), v.session);
    this.index.push(meta);
    writeJson(join(this.dir, 'index.json'), { version: 1, versions: this.index });
    return meta;
  }
}

/** The autosaved session, or null if there is none (or it can't be read). Comes back stopped. */
export function loadAutosave(file: string): Session | null {
  const s = readJson<{ session: Session }>(file, 'autosave')?.session;
  if (!s?.tracks || !s.sources) return null;
  return { ...s, transport: { ...s.transport, playing: false, command: 'stop' } };
}

const writeSession = (file: string, session: Session) => writeJson(file, { version: 1, savedAt: new Date().toISOString(), session });

/** Writes the store's session to `file` (or the open project's, a function) once edits have
 *  settled for `delayMs`. */
export class SessionAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: () => void;

  constructor(private file: string | (() => string), private store: SessionStore, private delayMs = 500) {
    this.unsubscribe = store.subscribe(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    writeSession(typeof this.file === 'string' ? this.file : this.file(), this.store.get());
  }

  /** Stop watching; writes a pending change first. */
  dispose() {
    if (this.timer) this.flush();
    this.unsubscribe();
  }
}

/** Oct 30: every project, each in its own folder under `root` (userData). The first one is
 *  `project/`, where the single project lived before, so an existing one opens as "Untitled". */
export class FileProjectLibrary extends ProjectIndex {
  private dirs: Record<string, string> = {}; // id -> folder, relative to root
  private versionLibs = new Map<string, FileVersionLibrary>();

  constructor(private root: string) {
    super();
    const saved = readJson<{ current: string; projects: (ProjectMeta & { dir: string })[] }>(join(root, 'projects.json'), 'projects');
    if (saved?.projects?.length && saved.projects.some((p) => p.id === saved.current)) {
      this.projects = saved.projects.map(({ dir, ...p }) => ((this.dirs[p.id] = dir), p));
      this.currentId = saved.current;
    } else {
      this.start();
      this.dirs.p1 = 'project';
      this.persist();
    }
  }

  /** The open project's folder. */
  dir(id = this.currentId) {
    return join(this.root, this.dirs[id] ?? `projects/${id}`);
  }

  protected keepSession(id: string, s: Session) {
    writeSession(join(this.dir(id), 'session.json'), s);
  }
  protected loadSession(id: string) {
    return loadAutosave(join(this.dir(id), 'session.json'));
  }
  protected versionsOf(id: string) {
    let v = this.versionLibs.get(id);
    if (!v) this.versionLibs.set(id, (v = new FileVersionLibrary(join(this.dir(id), 'versions'))));
    return v;
  }
  protected dropFiles(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true });
    this.versionLibs.delete(id);
    delete this.dirs[id];
  }
  protected persist() {
    for (const p of this.projects) this.dirs[p.id] ??= `projects/${p.id}`;
    writeJson(join(this.root, 'projects.json'), { version: 1, current: this.currentId, projects: this.projects.map((p) => ({ ...p, dir: this.dirs[p.id] })) });
  }
}

export type AudioRef = { path: string } | { library: string } | { file: string };

/** Where each source's audio lives, so a restored session can load it again. */
export class SourceAudioFiles {
  private refs: Record<string, AudioRef>;

  constructor(private dir: string) {
    this.refs = readJson<{ refs: Record<string, AudioRef> }>(join(dir, 'refs.json'), 'source audio')?.refs ?? {};
  }

  /** Remember a source: its original file, a library id, or (no original) its encoded bytes. */
  keep(id: string, a: { path: string } | { library: string } | { bytes: Uint8Array }) {
    let ref: AudioRef;
    if ('bytes' in a) {
      const file = `${id.replace(/[^\w-]/g, '_')}.audio`;
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, file), a.bytes);
      ref = { file };
    } else ref = a;
    this.refs[id] = ref;
    writeJson(join(this.dir, 'refs.json'), { version: 1, refs: this.refs });
  }

  ref(id: string): AudioRef | undefined {
    return this.refs[id];
  }

  /** The encoded audio of a file-backed source, or null (unknown, moved, or a library item). */
  read(id: string): Uint8Array | null {
    const r = this.refs[id];
    const p = r && ('path' in r ? r.path : 'file' in r ? join(this.dir, r.file) : null);
    return p && existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }
}
