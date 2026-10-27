# Arrange-first concept (superseded 2026-10-26)

> Archived. The first idea was an arrange-first canvas where agents only write reviewable proposals. We pivoted to a mini-DAW with Muse as sound designer + session engineer (see `../../idea.md`). Kept for ideas worth reusing later: the proposal/diff model, provenance, and the invariants. Not a plan.

## 1. The idea in one paragraph

Lattice is an **arrange-first AI music canvas** where agents never touch the song directly. The song is a typed, symbolic graph (sections, lanes, tracks, MIDI clips, devices, automation). An AI agent reads that graph and **proposes** changes as reviewable diffs ("open up the hook" → a ghosted proposal of 5 objects). The artist auditions it, A/Bs it, and **commits all, part, or none** of it. Neural audio models are **instruments on tracks** driven by the graph's MIDI, not composers that replace the song. Everything an agent or model made stays editable and carries provenance.

**Why it matters (the producer's view):** today's AI music tools either generate a whole song you can't edit, or bolt a chatbot onto a DAW. Lattice keeps the artist the director: AI output always resolves into ordinary clips, notes and curves you can change by hand.

**Why us:** the builder produces music in Logic, so this is a domain known first-hand (the theme's requirement).

## 3. Core invariants (from the spec, §1)

1. **Canvas first, timeline always.** Spatial freedom never costs timing precision.
2. **Generated = editable.** No committed AI result stays a black box.
3. **Agents write proposals; humans commit.** No code path lets an agent mutate the session. `commit` is user-only.
4. **Complexity exposed by selection.** Routing/parameter graphs one click away, never mandatory.
5. **Musical roles over implementation.** Sections and lanes carry meaning; tracks are how it's built.
6. **Local-first trust.** Session, assets and provenance live on the artist's disk.
7. **Structure is authoritative; audio is a render.**

## 5. Object model (spec §3, abridged)

| Primitive | Meaning |
|---|---|
| Project | song + tempo map, key, markers, refs, macros |
| Section | verse/hook/bridge span with role, energy 0..1, tags |
| Lane | a musical role, backed by one or more tracks |
| Track | audio/MIDI channel with a device chain |
| Clip | audio/MIDI/generated performance; immutable source, takes |
| SoundSource | sample/recording/AI instrument with mandatory origin + rights |
| Device | instrument/effect/analyzer; typed I/O; automatable params |
| Route / Bus | explicit graph edges; sends; sidechains |
| Parameter | real units (dB, Hz, ms), range, curve |
| AutomationCurve / Macro / Modulator | the three things that write to a Parameter, kept distinct |
| Reference | an artist-supplied anchor; agent reads only the ticked descriptors |
| **Proposal** | `{diff, rationale, scope, cost, provenance}`: previewable, partially committable, reversible |
| Branch | a safe alternate direction; merges object by object |
| Intent | natural-language direction bound to a selection |

**Provenance** on every object an agent/model touched: author (human / agent mode / model id+version), intent text, inputs, model seed/settings, proposal id, `derived_from` (freeze → thaw lineage), compute local/cloud.

## 6. Agent surface (spec §6, §8, §9)

- **17 verbs.** Read-only: `inspect`, `audition`, `compare`, `analyze`. Propose: `create`, `duplicate`, `move`, `trim/split`, `transform`, `route`, `insert_device`, `set_parameter`, `map_macro`, `write_automation`, `generate_variant`. **Human-only:** `commit`, `revert`.
- **Proposal lifecycle:** Intent → scope shown (narrow / add constraint loop) → Proposal (diff + rationale + cost) → Audition (A/B) → **human gate** → commit whole / commit partial / fork to branch / discard.
- **Permission policy** per session (e.g. vocal track and master bus denied unless opened; mix assistant writes only to a mix-pass branch; cloud compute budget).
- **Four modes** of one Studio Agent: **Arrange** (song shape, contrast, transitions), **Shape** (find/build a sound), **Move** (automation/modulation for a moment), **Balance** (diagnose masking, propose mix fixes).

## 7. Hackathon slice (proposal, to iterate on)

The spec's V1 (plug-in hosting, recording, full mix engine, all four modes) is months of work. A 10-day slice that still shows the idea:

1. **Browser canvas:** sections × lanes of MIDI clips, a transport, one continuous song→detail zoom (piano roll).
2. **Muse Spark Studio Agent**, 1-2 modes (**Arrange** and **Move**), over a small typed action API → returns Proposals.
3. **Proposal UX:** ghosted objects on the canvas and in the piano roll, rationale text, **A/B audition, partial commit**, discard, provenance in an inspector.
4. **Magenta RT2 Small** as one neural instrument on one lane (local on the Mac), the rest via a simple browser synth.
5. **`audition` with Muse Spark 1.2:** the agent listens to its own render and revises once (only if the day-1 test shows it understands music).

**Demo (3 min):** load a short loop → "make the second hook lift" → agent proposes 5 objects with rationale → A/B → accept 2 of 5 → tweak one note by hand (direct manipulation, no agent) → show provenance → MRT2 instrument following the edited MIDI.

**Explicitly out** (spec §14 plus the hackathon cut): plug-in hosting, recording, modular patching, live performance, marketplace/social, one-click full-song generation, DAW project import fidelity.

**Optional extra from the shelved tennis work:** an Apple Watch as a gesture controller whose wrist motion (800 Hz accel / 200 Hz gyro, verified on the SE) gets recorded as automation curves (Move mode). Not core.

## 9. Open questions

**Day-1 tests (decide the plan):**
- **T1** Does Muse Spark 1.2 give useful, specific feedback on a short music render (arrangement, masking, energy)? If not, drop `audition` and stay symbolic.
- **T2** Can a custom app drive MRT2 Small on the M2 Pro (API, latency, CPU/GPU load), or only the AU plugin/apps? If only the plugin, does the demo route MIDI to it in Logic or another host?
- **T3** Does Muse Spark produce musically credible arrangement edits from a typed JSON action API (spec Q6)? Try 3 intents on one loop.

**Product questions (spec §15, ordered by damage if wrong):**
- **Q1** What is the atomic unit of a partial commit: object, property, or time span? Decides the diff UI and the version model.
- **Q2** How does an agent perceive audio it didn't author? Minimum representation beyond LUFS/spectrum; does it need a model?
- **Q3** Can a lane backed by several tracks be automated as one thing? (Probably via Macro; verify.)
- **Q4** Latency budget for a playable neural instrument: ~200 ms vs. <20 ms for playing. Pads survive; percussive transients don't.
- **Q5** Which reference descriptors are legally/ethically extractable (tempo/key yes; groove, spectral balance, arrangement shape contested)?
- **Q6** Does the symbolic writer need a music-specific model, or is an LLM over the action API credible? (= T3)
- **Q7** Serialization format: DAWproject as the escape hatch?
- **Q8** Section energy: artist intent vs. measured analysis; show the disagreement?

**Hackathon-specific:**
- Browser app vs. native Mac app (MRT2 is Mac-native; a browser canvas needs a local bridge to it).
- Logic integration: export MIDI/DAWproject to Logic at the end of the demo, as proof the work isn't locked in?
- How much of Muse Spark's job is visible in a 3-minute video? The agent must be the star.

