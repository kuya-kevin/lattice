// Light / dark mode: a per-window view preference (not session state, so Muse doesn't see it).
// The mode is `data-theme` on <html>; styles.css and light.css swap the tokens on it.
import { useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light';
const KEY = 'lattice.theme';

function saved(): ThemeMode {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark'; // storage blocked: the default
  }
}

/** Set the saved mode before the first render, so a light window doesn't flash dark. */
export function applySavedTheme() {
  document.documentElement.dataset.theme = saved();
}

export function useTheme(): [ThemeMode, () => void] {
  const [mode, setMode] = useState<ThemeMode>(saved);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // not remembered
    }
  }, [mode]);
  return [mode, () => setMode((m) => (m === 'dark' ? 'light' : 'dark'))];
}
