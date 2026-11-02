# Lane note: Meta-only runtime (2026-11-01)

Items 1-10 of `docs/demo.md` are done. Item 11, the public repo (B6), is the user's.

- Sidecar: Demucs is the only model. A solo voice uses noisereduce then pyin, with no Demucs; parts in a mix use their Demucs stem; chords stay audio. Removed Mel-RoFormer,
  MuScriptor, basic-pitch, YourMT3+, ByteDance piano and their envs.
- Tools: removed `generate_mrt2`, `set_synth_knobs`, `fit_synth_to_reference` and the `sound` fixture
  that called one. Added `split_stems`. System prompt now tells Muse to use `measure_track`.
- Tests: fixed two stale web e2e tests (dark colour tokens, Muse dock position).
- Not seen live: Muse using the new prompt lines or `split_stems`. No Meta calls were made.
