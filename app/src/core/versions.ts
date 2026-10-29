// Named versions (B11): full copies of the session the user or Muse can go back to. Muse also
// gets an automatic one before each of its turns ("go back to before the drive"). Audio is not
// copied: every version points at the same sources. Electron keeps versions on disk
// (node/projectFiles.ts); web and tests keep them in memory.
import * as S from './session';
import { diffSessions, type Change } from './versionDiff';
import type { ToolContext, ToolDef } from './tools';

export interface VersionMeta {
  id: string; // v1, v2, ...
  name: string;
  auto: boolean; // made by the app (before a Muse turn, before New session)
  savedAt: string; // ISO time
}

export interface Version extends VersionMeta {
  session: S.Session;
}

export interface VersionLibrary {
  /** Newest first. */
  list(): VersionMeta[];
  get(id: string): Version | undefined;
  save(v: { name: string; auto: boolean; session: S.Session }): VersionMeta;
}

export class MemoryVersionLibrary implements VersionLibrary {
  protected versions: Version[] = [];

  list(): VersionMeta[] {
    return this.versions.map(({ session: _, ...meta }) => meta).reverse();
  }

  get(id: string): Version | undefined {
    return this.versions.find((v) => v.id === id);
  }

  save(v: { name: string; auto: boolean; session: S.Session }): VersionMeta {
    const version: Version = { id: `v${this.versions.length + 1}`, name: v.name, auto: v.auto, savedAt: new Date().toISOString(), session: v.session };
    this.versions.push(version);
    const { session: _, ...meta } = version;
    return meta;
  }
}

/** The context's library, or an in-memory one created on first use (tests, scenarios). */
export function versionLibrary(ctx: { versions?: VersionLibrary }): VersionLibrary {
  return (ctx.versions ??= new MemoryVersionLibrary());
}

/** Save an automatic version, unless the session is the same as the newest version. */
export function autoVersion(ctx: ToolContext, name: string): VersionMeta | null {
  const lib = versionLibrary(ctx);
  const s = ctx.store.get();
  const last = lib.list()[0];
  if (!s.tracks.length && !last) return null;
  if (last && sameContent(lib.get(last.id)!.session, s)) return null;
  return lib.save({ name, auto: true, session: s });
}

/** The Versions list: every named version plus the newest `autoLimit` auto ones (all if `showAll`). */
export function shownVersions<V extends VersionMeta>(list: V[], showAll: boolean, autoLimit = 20): { shown: V[]; hidden: number } {
  if (showAll) return { shown: list, hidden: 0 };
  let autos = 0;
  const shown = list.filter((v) => !v.auto || ++autos <= autoLimit);
  return { shown, hidden: list.length - shown.length };
}

/** What Muse sees about versions: named ones by name, auto ones as a count. */
export function versionsLine(ctx: ToolContext): string | undefined {
  const all = versionLibrary(ctx).list();
  if (!all.length) return undefined;
  const named = all.filter((v) => !v.auto).map((v) => JSON.stringify(v.name));
  const auto = all.length - named.length;
  return [named.join(', '), auto && `${auto} auto`].filter(Boolean).join('; ') + ' (list_versions shows them).';
}

// transport and selection are view state, not part of what a version is
const content = ({ transport: _t, selection: _s, ...rest }: S.Session) => JSON.stringify(rest);
const sameContent = (a: S.Session, b: S.Session) => content(a) === content(b);

function findVersion(lib: VersionLibrary, ref: string): Version {
  const meta = lib.list().find((v) => v.id === ref) ?? lib.list().find((v) => v.name === ref);
  if (!meta) {
    const names = lib.list().slice(0, 8).map((v) => `${v.id} "${v.name}"`);
    throw new S.SessionError(`no version "${ref}" (${names.length ? `newest: ${names.join(', ')}` : 'none saved yet'})`);
  }
  return lib.get(meta.id)!;
}

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });

export const VERSION_TOOLS: ToolDef[] = [
  {
    name: 'save_version',
    description: 'Save the whole session as a named version the user can go back to (e.g. before trying a big change).',
    parameters: obj({ name: str('Short name, e.g. "clean vocal" or "mix A"') }, ['name']),
    run: (ctx, a) => {
      const name = String(a.name).trim();
      if (!name) throw new S.SessionError('give the version a name');
      const { id, savedAt } = versionLibrary(ctx).save({ name, auto: false, session: ctx.store.get() });
      return { id, name, saved_at: savedAt };
    },
  },
  {
    name: 'restore_version',
    description:
      'Go back to a saved version (by id or name), replacing the current tracks, devices and clips. The current state stays one undo step away. An automatic version is saved before each of your turns, named after the request that followed it.',
    parameters: obj({ version: str('Version id (e.g. "v3") or name') }, ['version']),
    run: (ctx, a) => {
      const v = findVersion(versionLibrary(ctx), String(a.version));
      ctx.store.set(ctx.store.restored(v.session));
      return { restored: v.id, name: v.name, tracks: ctx.store.get().tracks.length };
    },
  },
  {
    name: 'list_versions',
    description:
      'List saved versions, newest first (id, name, auto = saved automatically before a Muse turn). With changes: true, each also lists ' +
      'what changed after it (up to the next newer version, or now for the newest): what restoring it takes away.',
    parameters: obj({ changes: { type: 'boolean', description: 'Include what changed after each version' } }),
    quiet: true,
    run: (ctx, a) => {
      const lib = versionLibrary(ctx);
      const list = lib.list();
      // newest first: each version's "after" is the one before it in the list, or the live session
      let after = ctx.store.get();
      return {
        versions: list.map((v) => {
          const row = { id: v.id, name: v.name, auto: v.auto, saved_at: v.savedAt };
          if (!a.changes) return row;
          const at = lib.get(v.id)?.session;
          const changes: Change[] = at ? diffSessions(at, after) : [];
          if (at) after = at;
          return { ...row, changes };
        }),
      };
    },
  },
  {
    name: 'new_session',
    description: 'Start an empty session; the current one is saved as an automatic version first.',
    userOnly: true,
    parameters: obj({}),
    run: (ctx) => {
      const saved = autoVersion(ctx, 'Before new session');
      const cur = ctx.store.get();
      ctx.store.set({ ...S.emptySession(), seq: cur.seq, transport: cur.transport });
      return { saved_as: saved?.id ?? versionLibrary(ctx).list()[0]?.id ?? null };
    },
  },
];
