// Recently used library sounds (added to Ideas or dropped on a track), newest first, for the
// library's Recent tab. A per-machine convenience across projects, so it lives in localStorage;
// the panel still works when storage is unavailable.
import { useSyncExternalStore } from 'react';
import { pushRecent } from '../core/library';

const KEY = 'lattice.libraryRecents';
const listeners = new Set<() => void>();

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let recents = load();

export function addRecent(id: string) {
  recents = pushRecent(recents, id);
  try {
    localStorage.setItem(KEY, JSON.stringify(recents));
  } catch {
    // storage blocked: keep them for this run only
  }
  listeners.forEach((l) => l());
}

export function useRecents(): string[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => recents,
  );
}
