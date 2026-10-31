// Oct 30: more than one project. Each project has its own session, versions and audio; the
// shelves, saved chains and setups span projects (userData). The Lattice pill's menu lists the
// projects (newest opened first) and makes, opens, renames, deletes and saves them. Electron
// keeps them on disk (node/projectFiles.ts, FileProjectLibrary); web and tests keep them in memory.
// Switching projects is the user's: the tools are userOnly, so Muse never switches mid-turn.
import * as S from './session';
import { MemoryVersionLibrary, versionLibrary, type VersionLibrary } from './versions';
import type { ToolContext, ToolDef } from './tools';
import { setupOffers } from './setups';

export interface ProjectMeta {
  id: string; // p1, p2, ...
  name: string;
  createdAt: string; // ISO time
  openedAt: string; // last made current
  tracks: number; // when it was last left (the open one: now)
}

export interface ProjectLibrary {
  /** Newest opened first. */
  list(): ProjectMeta[];
  current(): ProjectMeta;
  /** Keep `leaving` as the open project's session, then make a new empty project current. */
  create(name: string, leaving: S.Session): { meta: ProjectMeta; versions: VersionLibrary };
  /** Keep `leaving` as the open project's session, then make `id` current: its session (null if
   *  it has none yet) and versions. */
  open(id: string, leaving: S.Session): { meta: ProjectMeta; session: S.Session | null; versions: VersionLibrary };
  rename(id: string, name: string): ProjectMeta;
  /** Delete a project that isn't open, with its versions and kept audio. */
  remove(id: string): void;
  /** The open project's versions (on launch). */
  versions(): VersionLibrary;
}

/** The index and switching; subclasses say where sessions and versions are kept. */
export abstract class ProjectIndex implements ProjectLibrary {
  protected projects: ProjectMeta[] = [];
  protected currentId = '';

  protected abstract keepSession(id: string, s: S.Session): void;
  protected abstract loadSession(id: string): S.Session | null;
  protected abstract versionsOf(id: string): VersionLibrary;
  protected abstract dropFiles(id: string): void;
  protected abstract persist(): void;

  /** The first project, when there are none yet. */
  protected start(name = 'Untitled') {
    const now = new Date().toISOString();
    this.projects = [{ id: 'p1', name, createdAt: now, openedAt: now, tracks: 0 }];
    this.currentId = 'p1';
  }

  list(): ProjectMeta[] {
    // the open one first, then by when last opened (same millisecond: the newer project)
    const rank = (p: ProjectMeta) => (p.id === this.currentId ? 1 : 0);
    return [...this.projects].sort((a, b) => rank(b) - rank(a) || b.openedAt.localeCompare(a.openedAt) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  }

  current(): ProjectMeta {
    return this.projects.find((p) => p.id === this.currentId)!;
  }

  versions(): VersionLibrary {
    return this.versionsOf(this.currentId);
  }

  private leave(leaving: S.Session) {
    this.keepSession(this.currentId, leaving);
    this.current().tracks = leaving.tracks.length;
  }

  create(name: string, leaving: S.Session) {
    this.leave(leaving);
    const n = Math.max(0, ...this.projects.map((p) => Number(p.id.slice(1)) || 0)) + 1;
    const now = new Date().toISOString();
    const meta: ProjectMeta = { id: `p${n}`, name: this.uniqueName(name.trim() || 'Untitled'), createdAt: now, openedAt: now, tracks: 0 };
    this.projects.push(meta);
    this.currentId = meta.id;
    this.persist();
    return { meta, versions: this.versionsOf(meta.id) };
  }

  open(id: string, leaving: S.Session) {
    const meta = this.find(id);
    this.leave(leaving);
    meta.openedAt = new Date().toISOString();
    this.currentId = id;
    this.persist();
    return { meta, session: this.loadSession(id), versions: this.versionsOf(id) };
  }

  rename(id: string, name: string): ProjectMeta {
    const meta = this.find(id);
    const clean = name.trim();
    if (!clean) throw new S.SessionError('give the project a name');
    meta.name = clean === meta.name ? clean : this.uniqueName(clean);
    this.persist();
    return meta;
  }

  remove(id: string) {
    const meta = this.find(id);
    if (id === this.currentId) throw new S.SessionError(`"${meta.name}" is open; open another project first`);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.dropFiles(id);
    this.persist();
  }

  private find(id: string): ProjectMeta {
    const meta = this.projects.find((p) => p.id === id);
    if (!meta) throw new S.SessionError(`no project ${id}`);
    return meta;
  }

  /** "Untitled", then "Untitled 2", ... */
  private uniqueName(name: string) {
    const taken = new Set(this.projects.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} ${n}`.toLowerCase())) n++;
    return `${name} ${n}`;
  }
}

export class MemoryProjectLibrary extends ProjectIndex {
  private sessions = new Map<string, S.Session>();
  private versionLibs = new Map<string, VersionLibrary>();

  /** `firstVersions`: the open project's versions as they are now (a context's existing library). */
  constructor(firstVersions?: VersionLibrary) {
    super();
    this.start();
    if (firstVersions) this.versionLibs.set('p1', firstVersions);
  }
  protected keepSession(id: string, s: S.Session) {
    this.sessions.set(id, s);
  }
  protected loadSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  protected versionsOf(id: string) {
    let v = this.versionLibs.get(id);
    if (!v) this.versionLibs.set(id, (v = new MemoryVersionLibrary()));
    return v;
  }
  protected dropFiles(id: string) {
    this.sessions.delete(id);
    this.versionLibs.delete(id);
  }
  protected persist() {}
}

/** The context's library, or an in-memory one created on first use (tests, scenarios). */
export function projectLibrary(ctx: ToolContext): ProjectLibrary {
  return (ctx.projects ??= new MemoryProjectLibrary(versionLibrary(ctx)));
}

/** What Muse sees: the open project's name. */
export const projectLine = (ctx: ToolContext) => (ctx.projects ? `Project: ${JSON.stringify(ctx.projects.current().name)}` : undefined);

/** Put a project's session in the store: no undo back into the project left behind, and ids
 *  stay above every id used so far in any project (the renderer keys audio by them). */
function switchTo(ctx: ToolContext, next: S.Session | null, versions: VersionLibrary) {
  const cur = ctx.store.get();
  const s = next ?? S.emptySession();
  ctx.versions = versions;
  ctx.store.replace({
    ...s,
    transport: { ...s.transport, playing: false, command: 'stop', rev: cur.transport.rev + 1 },
    voiceReply: cur.voiceReply, // a preference, not part of a project
    frames: cur.frames, // the screen layout is app-wide
    seq: Math.max(cur.seq, s.seq),
  });
  ctx.projectOpened?.();
}

function findProject(lib: ProjectLibrary, ref: string): ProjectMeta {
  const all = lib.list();
  const p = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
  if (!p) throw new S.SessionError(`no project "${ref}" (projects: ${all.map((x) => `${x.id} "${x.name}"`).join(', ')})`);
  return p;
}

const view = (p: ProjectMeta, open: ProjectMeta, tracks: number) => ({
  id: p.id,
  name: p.name,
  open: p.id === open.id,
  tracks: p.id === open.id ? tracks : p.tracks,
  opened_at: p.openedAt,
  created_at: p.createdAt,
});

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

export const PROJECT_TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    description: 'List the user\'s projects, newest opened first (open = the one you are working in). Only the user opens or makes projects.',
    parameters: obj({}),
    quiet: true,
    run: (ctx) => {
      const lib = projectLibrary(ctx);
      const open = lib.current();
      return { projects: lib.list().map((p) => view(p, open, ctx.store.get().tracks.length)) };
    },
  },
  {
    name: 'new_project',
    description: 'Start a new empty project; the open one is kept as it is and stays in the project list.',
    userOnly: true,
    noHistory: true,
    parameters: obj({ name: str('Project name (default "Untitled")') }),
    run: (ctx, a) => {
      const { meta, versions } = projectLibrary(ctx).create(String(a.name ?? ''), ctx.store.get());
      switchTo(ctx, null, versions);
      return { project_id: meta.id, name: meta.name };
    },
    logText: (_a, r) => `started a new project "${r.name}"`,
  },
  {
    name: 'open_project',
    description: 'Open another project (by id or name); the open one is kept as it is.',
    userOnly: true,
    noHistory: true,
    parameters: obj({ project: str('Project id (e.g. "p2") or name') }, ['project']),
    run: (ctx, a) => {
      const lib = projectLibrary(ctx);
      const p = findProject(lib, String(a.project));
      if (p.id === lib.current().id) return { project_id: p.id, name: p.name, already_open: true };
      const { session, versions } = lib.open(p.id, ctx.store.get());
      switchTo(ctx, session, versions);
      return { project_id: p.id, name: p.name, tracks: ctx.store.get().tracks.length };
    },
    logText: (_a, r) => `opened project "${r.name}"`,
  },
  {
    name: 'rename_project',
    description: 'Rename a project (default: the open one).',
    userOnly: true,
    quiet: true,
    parameters: obj({ project: str('Project id or name (default: the open one)'), name: str('New name') }, ['name']),
    run: (ctx, a) => {
      const lib = projectLibrary(ctx);
      const p = a.project ? findProject(lib, String(a.project)) : lib.current();
      const from = p.name;
      return { project_id: p.id, from, name: lib.rename(p.id, String(a.name)).name };
    },
  },
  {
    name: 'delete_project',
    description: 'Delete a project that is not open, with its versions.',
    userOnly: true,
    quiet: true,
    parameters: obj({ project: str('Project id or name') }, ['project']),
    run: (ctx, a) => {
      const lib = projectLibrary(ctx);
      const p = findProject(lib, String(a.project));
      lib.remove(p.id);
      return { deleted: p.id, name: p.name };
    },
  },
  {
    name: 'save_project',
    description:
      'Save: a named version of the open project (Lattice autosaves every change; this is a point to go back to). ' +
      'Saving is when Lattice learns: it notes how each kind of track (vocals, guitars, ...) is set up, and once the same setup shows up in enough projects the result offers to keep it.',
    userOnly: true,
    noHistory: true,
    parameters: obj({ name: str('Version name (default "Saved <time>")') }),
    run: (ctx, a) => {
      const s = ctx.store.get();
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const name = String(a.name ?? '').trim() || `Saved ${time}`;
      const { id } = versionLibrary(ctx).save({ name, auto: false, session: s });
      const offers = setupOffers(ctx, s);
      return { version: id, name, project: projectLibrary(ctx).current().name, ...(offers.length ? { setup_offers: offers } : {}) };
    },
    logText: (_a, r) => `saved the project ("${r.name}")`,
  },
];
