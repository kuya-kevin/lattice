// Evidence for a human to look at (screenshots, videos), not assertions. Off by default so the
// suite runs faster and loads the CPU less (the audio timing specs are load-sensitive);
// LATTICE_EVIDENCE=1 npx playwright test ... writes them as before.
export const EVIDENCE = !!process.env.LATTICE_EVIDENCE;

/** `video` for `test.use`: recorded only with LATTICE_EVIDENCE=1. */
export const evidenceVideo = EVIDENCE ? 'on' : 'off';

type Shootable = { screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown> };

/** page.screenshot / locator.screenshot, only with LATTICE_EVIDENCE=1. */
export async function shot(on: Shootable, path: string, options: { fullPage?: boolean } = {}) {
  if (EVIDENCE) await on.screenshot({ path, ...options });
}
