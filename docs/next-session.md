# Next session: restart plan (written 2026-10-26, 11 pm)

Paused because the usage limit was low. Three agents are to be (re)launched, each in its own git worktree (`isolation: worktree`), in the background. None had written code yet, so they start fresh.

Read first: `docs/session-plan.md` (streams, rules), `docs/plugin-catalog.md` (S1 spec), `docs/architecture.md`, `docs/spike-results.md`.

**Important:** all docs and new spike files are **staged, not committed**, so a new worktree (made from HEAD `b9575ba`) won't contain them. Each agent prompt must point at absolute paths in the main checkout (`<repo>/docs/...`, as absolute paths). Alternative: ask the user to commit the staged work first.

## Environment block (paste into every agent prompt)

`<repo>` is the main checkout and `<bigdisk>` is the project folder on the large data drive; substitute the real absolute paths (kept in local memory, not in the repo) when building prompts.


- Root disk `/` has ~1.7 GB free. Nothing big goes there.
- Node: in the worktree, `ln -s <repo>/app/node_modules app/node_modules` instead of `npm install`. New deps only if essential: `npm_config_cache=<bigdisk>/npm-cache npm install <pkg>` (lands in the shared node_modules); list them in the report.
- Playwright: `export PLAYWRIGHT_BROWSERS_PATH=<bigdisk>/ms-playwright` (Chromium installed). Dev-server ports: S1 5180, UI 5190.
- Python: `cd spikes && UV_CACHE_DIR=<bigdisk>/uv-cache UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=<bigdisk>/venvs/spikes uv run python ...`; `uv run --with pytest` / `--with av` as needed. Never a `.venv` in the worktree.
- Model weights, caches, clones, outputs: `<bigdisk>/{hf,torch,xdg-cache,repos,venvs,out-fx,out-evals,ui-shots}`; set `HF_HUB_CACHE=<bigdisk>/hf` (not `HF_HOME`, so the Hugging Face login token at its default location still works), `TORCH_HOME`, `XDG_CACHE_HOME` accordingly. Hugging Face login is done (2026-10-26).
- No paid API calls (no Muse/Meta). Stage-only rule: do not commit. Existing tests must pass: `npx vitest run` (34) and `npx playwright test e2e/smoke.spec.ts e2e/shortcuts.spec.ts` (9).

## Agent 1: S1 effects engine + verification

Implement `docs/plugin-catalog.md`:
1. `app/src/fx/catalog.json` + TS loader/types (schema from the catalog doc). Build order: utility, eq, comp, deess, gate, limiter, sat, filter, delay, reverb, then pitch, mod, crush.
2. One chain builder used live (waveform-playlist per-track effects hook) and in `OfflineAudioContext`. Chain + knob values live on the track in the session model; tools `insert_device` / `set_param` / `remove_device` bounded by catalog ranges; hand edits logged like existing ones.
3. Faust devices (permissive library functions only; own compressor/limiter), compiled ahead of time with `@grame/faustwasm`. If blocked, ship native Web Audio first behind the same ids.
4. Minimal `app/src/renderer/DevicePanel.tsx` generated from the catalog, mounted by a small marked hook in `App.tsx`.
5. **Verification harness** + `docs/fx-verification.md`: render test signals headless (Playwright) → WAV → measure (Python/pytest or TS). References per device: EQ/filters vs RBJ Audio EQ Cookbook (±0.25 dB); comp/limiter/gate static curve and time constants vs Giannoulis, Massberg & Reiss 2012 (JAES); de-esser on synthetic sibilant bursts + the sibilant vocals in `data/freesound_material` (dry_vocal); delay spacing/feedback; reverb RT60 (Schroeder integration) + predelay; saturation THD vs drive; pitch ±5 cents; utility gain and M/S width. Cite Zölzer DAFX, Pirkle, Reiss & McPherson, J.O. Smith (CCRMA), Dattorro 1997, Zavalishin, ITU-R BS.1770 / EBU R128 (verify citations). Export test signals for an optional Logic "golden bounce" comparison on the Mac.
6. Report: per-device native vs Faust, verification table with measured numbers, deps, gaps, changed files.

## Agent 2: UI iteration (Logic / GarageBand as reference)

User asks:
1. **Sound library tab on the right** (collapsible, tabbed like Logic's Library / Loop Browser): Freesound sets (`data/freesound/manifest.json`, `data/freesound_material/manifest.json`) and voice notes (`data/voice_notes/*.wav`); category browse, search, filter chips, click to preview, drag to a track or empty space (new track), CC-BY attribution in details. Electron via bridge; dev:web via a small Vite middleware; tests use small fixtures, not `<bigdisk>`.
2. **Movable clips across tracks**: drag in time and to another track, snap to bar/beat (toggle), drop indicator, undo; logged as a hand edit Muse sees. Check waveform-playlist 16 / @dnd-kit support first.
3. Polish toward Logic: track headers (name, mute/solo/arm, volume), selection highlight, Logic-like dark theme, shortcuts from `app/docs/ux-notes.md` intact; leave a bottom "editor / smart controls" area for the DevicePanel. Append cited conventions to `ux-notes.md`.
Iterate with headless Playwright screenshots (≥3 passes, saved to `<bigdisk>/ui-shots/`). Add Vitest (clip move, snap math, library filter) and e2e tests. Report files touched, especially `App.tsx` regions, for merging with Agent 1.

## Agent 3: GPU model evals (3090 to itself)

1. **Magenta RT2 on CUDA** (JAX or other backend; check licence). If it runs: RTF and VRAM for small/base; reproduce `spikes/d_mrt2` on the 6 `out/c_recreate` targets as new listening-test candidates (`mrt2_cuda_small`, `mrt2_cuda_base`); text prompts on a short MIDI phrase. If not supported, document why.
2. **Audio to MIDI on real material**: voice notes 112, 114, 119, 143, 145, 146, 149, 150 + drum loop, and Freesound `bass_keys_phrase`, `layered_multi`, `hum_whistle_beatbox`. Separation (BS-RoFormer / Mel-RoFormer, htdemucs_6s) then transcription (YourMT3+, MT3 if runnable, ByteDance piano) vs basic-pitch. Synthetic phone-degraded set with known MIDI, mir_eval note F1 (onset ±50 ms). Export MIDI + synth renders for listening.
3. **Audiobox Aesthetics (Meta)** as a grader: correlate with the pair ratings (rater `Kev3090`; spectral distance agreed 77%).
Per model: licence, VRAM, speed, setup pain, result; skip anything taking >45 min to set up. Scripts in `spikes/j_evals/` with a README; env files under `envs/<name>/`. Check `df -h /` before/after.

## Open items for the user
- One line per new voice note (112, 114, 119, 143, 145): hum / instrument / layered? Automatic guesses are in the chat log: 143 is the cleanest (a melody around F#4); 119 is very quiet; 112/114 are low and noisy.
- A dry vocal take with strong "s" sounds (the Freesound dry vocals are thin).
- Verify a few Logic knob ranges in `plugin-catalog.md` on the Mac.
- Unstaged: `.gitignore` (`/data`, `/out`, `.claude/worktrees/`). Everything else staged; nothing committed.
- Optional cleanup to free root disk: `~/.cache/uv` (531 MB), `~/.cache/pip` (198 MB).
