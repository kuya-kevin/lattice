# Architecture (updated 2026-10-26, after the workflow interview)

> **2026-10-27 note:** diagram A is the day-1 snapshot and is out of date. Since then the effects
> engine (13 devices), the device panel and audio-to-MIDI (`extract_midi`) were built and wired in;
> the vocabulary layer exists only as seed data. Current status: `HANDOFF.md`; models by job:
> `docs/model-map.md`. Diagram B is still the target.

## A. Where we were on day 1 (2026-10-26)

Solid = working. Dashed = spike only, not wired into the app. Dotted = blocked or unproven.

```mermaid
flowchart TB
  user([Producer: voice, hand edits, ears])

  subgraph app["Electron app (app/) - working"]
    ui["Mini-DAW UI<br/>waveform-playlist, tracks, punch-in,<br/>click, tempo/key bar, shortcuts"]
    chat["Muse chat panel"]
    store["Session model + store (TS)<br/>tracks, tempo, key, hand-edit log"]
    agent["Agent loop<br/>OpenAI-format tool calls, recorded fixtures"]
    tools["Session tools<br/>trim, gain, mute, add track,<br/>punch-in, tempo, key, transport"]
    stubs["Placeholder tools<br/>quantize, cleanup, synth knobs,<br/>fit-to-reference, MRT2, ears"]
    sidecar["sidecar.ts<br/>(plan: local HTTP/stdio)"]
  end

  muse[["Muse Spark 1.3 contributor<br/>Meta API - planner, text only, cannot hear music"]]
  fs[["Freesound API<br/>144 CC0/CC-BY set"]]

  subgraph py["Python spikes (spikes/, envs/) - not wired"]
    direction TB
    clean["Cleanup: noisereduce<br/>(working)"]
    quant["Drum quantize + trim<br/>(working, needs a listen)"]
    synth["15-knob synth + CMA-ES<br/>(top pick by ear)"]
    musefit["Muse patch seeds optimizer<br/>(close second)"]
    demucs["Demucs htdemucs_6s<br/>piano stem (working)"]
    midi["basic-pitch -> MIDI + key<br/>(acceptable)"]
    mrt["Magenta RT2 small<br/>(vibe not copy, Mac/MLX only)"]
    ears["PE-AV ears small/base/large<br/>(tracks 4 of 6 knobs, large untested)"]
    sam["SAM Audio<br/>(access pending)"]
  end

  subgraph evalbox["Evaluation"]
    pair["Pairwise A/B listening page<br/>(e_eval) - not rated yet"]
    grade{{"Can any score grade an attempt?<br/>spectral dist, MusicCoCa, PE-AV: so far no"}}
  end

  user --> ui
  user --> chat
  ui --> store
  chat --> agent
  store -- "state + hand edits as text" --> agent
  agent <--> muse
  agent --> tools --> store
  agent --> stubs --> sidecar
  agent -. search .-> fs
  sidecar -.-> clean & quant & synth & musefit & demucs & midi & mrt & ears
  sam -.-> sidecar
  musefit -. calls .-> muse
  ears -.-> grade
  pair --> grade
  grade -. decides if agent self-checks .-> agent
  ears -. text summary of sound .-> muse

  classDef ok fill:#d7f5dd,stroke:#2e7d32,color:#000
  classDef part fill:#fff3cd,stroke:#b58900,color:#000
  classDef blocked fill:#f8d7da,stroke:#b02a37,color:#000
  class ui,chat,store,agent,tools,clean,quant,synth,demucs ok
  class musefit,midi,mrt,ears,stubs,sidecar,pair part
  class sam,grade blocked
```


## B. Where we are going

The user's workflow (see `session-plan.md`) is a **session-engineer** job: capture a sound, shape it with effects, add quantized MIDI parts, record vocals with a light chain, arrange lightly. Everything runs in Lattice, not Logic. The centre of the system becomes a **fixed effects engine with exposed knobs** that Muse drives, backed by a **vocabulary layer** ("gritty", "stand out in the mix") that turns words into knob moves. Hearing is a side-bet, not the spine.

```mermaid
flowchart LR
  subgraph input["Inputs"]
    mic["Hotkey voice command<br/>(push-to-talk)"]
    rec["Recording: voice notes,<br/>vocals, phone-quality audio"]
    imp["Imported song snippet<br/>(remix / stems use case)"]
    fsd["Freesound reference set"]
  end

  subgraph prep["Source prep (sidecar)"]
    stt["Speech to text<br/>(Muse 1.2 audio in)"]
    den["Cleanup: noisereduce<br/>(+ SAM Audio for hard cases)"]
    sep["Isolate sources / stems<br/>Demucs, SAM Audio"]
    tom["Notes: basic-pitch + cleanup<br/>octave fix, key snap, quantize"]
  end

  subgraph core["Lattice core (TS)"]
    sess["Session model<br/>tracks, clips, MIDI, tempo, key,<br/>device chains, hand-edit log"]
    vocab["Vocabulary layer<br/>words to knob moves<br/>(gritty, warm, wide, stand out)"]
    fx["Effects engine: fixed device set<br/>EQ, comp, de-esser, sat, filter,<br/>reverb, delay, pitch, gate, limiter"]
    synth["Instruments<br/>sampler, subtractive synth,<br/>drum/bass/piano MIDI parts"]
    mix["Mix-aware helpers<br/>masking check, gain staging,<br/>vocal-on-top recipes"]
  end

  agent["Muse planner (Meta API)<br/>typed tool calls, sees state as text,<br/>reads user knob moves as feedback"]
  ui["Mini-DAW UI + knob panels"]
  out["Export: WAV stems + MIDI<br/>(optional hand-off to Logic)"]

  mic --> stt --> agent
  rec --> den --> sess
  imp --> sep --> sess
  sep --> tom --> sess
  fsd -. test material .-> sep
  agent <--> sess
  agent --> vocab --> fx
  agent --> synth
  agent --> mix
  fx --> sess
  synth --> sess
  mix -. reads .-> sess
  sess <--> ui
  ui -- "hand edits = feedback" --> agent
  sess --> out
```

**What is new relative to the first diagram**
- Effects engine and vocabulary layer are the main deliverable. The effects engine is built (Oct 27); the vocabulary layer is seed data only.
- Source prep (cleanup, isolation, audio to notes) is one pipeline that also serves the stems/remix use case.
- Synth+optimizer, MRT2 and PE-AV ears are demoted to **optional modules** ("recreate a reference", "grade an attempt").
- Muse never needs to hear: it picks from words plus session state, and the user judges by ear.

## Reading diagram A (day 1)

- **The gap that matters:** everything the agent can *do to sound* is in the dashed box. The app only has stubs. The sidecar is the bridge.
- **Muse is blind:** it plans from text. Any "listening" has to be a measurement or an embedding turned into text, which is why ears and self-grading are the open research questions.
- **Meta-central constraint:** Muse (planner), PE-AV, Demucs, SAM Audio are Meta. MRT2 (Google) and basic-pitch (Spotify) are not.
