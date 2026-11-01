// Opening the library on sounds from elsewhere (Muse's chat replies): App opens the panel,
// LibraryPanel lists the sounds and auditions the one clicked.
import { useEffect } from 'react';

export interface ShowSounds {
  ids: string[];
  /** the one to select and play, if any */
  focus?: string;
  /** what the list is, e.g. "From Muse" */
  label: string;
}

const SHOW = 'lattice-show-sounds';

export const showSounds = (detail: ShowSounds) => window.dispatchEvent(new CustomEvent(SHOW, { detail }));

export function useShowSounds(onShow: (s: ShowSounds) => void) {
  useEffect(() => {
    const h = (e: Event) => onShow((e as CustomEvent<ShowSounds>).detail);
    window.addEventListener(SHOW, h);
    return () => window.removeEventListener(SHOW, h);
  }, [onShow]);
}
