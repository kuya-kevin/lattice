# worktree-agent-a22af36e17ca276c1 (lane B) — 2026-10-29
Backlog: B14 Muse talks back (done in code; still needs checking by ear in Electron)

Changed:
- New speaker button in the prompt bar (next to the mic), off by default. It calls the new tool
  `set_voice_reply` (`core/voiceTools.ts`), which Muse can call too ("talk back to me" / "stop talking").
  The setting is `session.voiceReply`. It is a preference, so it makes no undo step, and undo or a
  version restore leaves it as it is (`store.restored`). While it is on, Muse sees one line in the summary.
- When it is on, Muse's final reply is spoken with Meta's MMS-TTS English (`facebook/mms-tts-eng`,
  VITS, ONNX build `Xenova/mms-tts-eng`, fp32), run by Transformers.js in a Web Worker in the renderer
  (`renderer/tts.worker.ts`). Replies up to 160 characters are spoken whole. Longer ones are spoken
  by their first sentence only. Markdown, links and bullets are stripped.
- MMS-TTS reads only lowercase letters and the digits 0-6 (no punctuation), so `speakable()` writes
  numbers, units, ranges and ordinals out as words: "-3 dB at 250 Hz" becomes "minus three decibels
  at two hundred fifty hertz".
- Playback pauses while Muse speaks. It picks up again afterwards unless the transport moved meanwhile.
  We pause rather than duck because the audio has no master bus: the playlist, MIDI synth, click and
  previews each go straight to `destination`.
- Muse never starts speaking while a track records, and if a recording starts during speech, the
  speech stops. Push-to-talk (`` ` `` or the mic button) cuts the speech off. While Muse speaks, a
  status pill reads "Muse is speaking… hold ` to talk".
- The model runs on WebGPU when it is there and falls back to WASM. You can force one with
  localStorage `lattice.ttsDevice` = `wasm` | `webgpu`. The weights (~115 MB) download from the
  Hugging Face Hub on first use into the Electron/browser cache in userData, never into the repo.
  The ORT wasm (27 MB) is bundled into `dist/` by Vite.
- The web build and Playwright use a silent mock voice that only takes time, so tests download no
  model. In dev:web, `?voice=mms` uses the real model.
- Test hook `window.latticeVoice`: `kind`, `speaking()`, `spoken()`, `say(text)`, `stop()`,
  `mockMsPerChar`.

Check it: `npm run dev:web -- --port 5392 --strictPort` (mock voice, silent), then
  1. Click the speaker button next to the mic. It lights up. Ask "list the tracks". The pill
     "Muse is speaking…" shows for a few seconds.
  2. Import a loop, press Space, then ask again. Playback stops while the pill shows, then plays on.
  3. While the pill shows, click outside the prompt and hold `. The pill gives way to "Listening…".
  4. Open `http://localhost:5392/?voice=mms` to hear the real voice in the browser. The first reply
     waits for the ~115 MB download.

Check by ear in Electron (the real voice):
  1. `npm run build && npm run dev` (or `npx electron .` after the build). Electron needs no `.env`
     just to hear the voice.
  2. Click the speaker button. This starts loading the model, and the console shows `[voice]
     MMS-TTS loaded in … ms`. Open the DevTools console (View > Toggle Developer Tools), then run
     `latticeVoice.say('Panned the double 30 percent right.')`. You can try any of the phrases below.
     Live Muse replies are spoken the same way, but they cost Meta calls.
  3. Or, headless: `node scripts/tts-electron-spike.mjs`. It speaks the five phrases through the
     speakers and logs the timings.
  4. Spike WAVs to listen to: `out/tts-spike/1.wav` to `5.wav` in this worktree. The Node script
     `node scripts/tts-spike.mjs` makes them, with the numbers already written out as the app does.
     The Node run uses the CPU (onnxruntime-node); Electron uses WebGPU. Both are fp32, so they
     should sound alike, but compare by ear.

Spike timings (M-series Mac, fp32; 16 kHz output; phrases 2.2-4.3 s long):

| Where | Model load | Per phrase (synthesis only) |
|---|---|---|
| Node, onnxruntime-node CPU (`scripts/tts-spike.mjs`) | 158 s first (download), then 0.36-0.41 s cached | 0.27-0.72 s (about 0.12-0.2x real time) |
| Headless Chromium, WASM worker (`scripts/tts-browser-spike.mjs`) | download + load ≈ 80 s | 2.1-4.3 s (about real time: too slow) |
| Electron, WASM worker | ~1.3 s cached | 2.0-4.1 s |
| Electron, WebGPU worker (default) | ~1.5 s cached, incl. the first phrase's shader compile | 0.17-0.27 s |

So in Electron the first spoken reply arrives about 2-4 s after Muse answers: model load plus
synthesis. Warming starts when the toggle is switched on, so it is usually done by then. Later
replies take about 0.2 s. Cost per reply: $0 (the model runs locally; no Meta call).

Licence watchlist row to add (CLAUDE.md):
| MMS-TTS English (`facebook/mms-tts-eng`, ONNX `Xenova/mms-tts-eng`) | weights CC BY-NC 4.0 | non-commercial; downloaded at runtime to the app cache, not in the repo; Transformers.js is Apache-2.0 |

docs/model-map.md row to add (under "Talking and planning"):
| Speak Muse's reply | MMS-TTS English (`facebook/mms-tts-eng`, VITS, Meta) via Transformers.js, fp32 | app (renderer Web Worker; WebGPU, WASM fallback) | in app (B14, Oct 29), off by default | The Meta API has no TTS. Electron WebGPU about 0.2 s per short phrase after a ~1.5 s load; WASM about real time. Reads letters only, so numbers and units are written out first. $0 per reply. |

Files outside lane B's own: `core/tools.ts` (import + `...VOICE_TOOLS`), `core/session.ts`
(optional `voiceReply` field + summary line), `core/store.ts` (`restored` keeps `voiceReply`),
`renderer/App.tsx` (ChatPanel props: pause returns a token, resume, voiceOn), `renderer/main.tsx`
(one call so the test hook exists before the page renders), `renderer/icons.tsx` (a `speaker` icon),
`package.json` (`@huggingface/transformers` 4.3.1, Apache-2.0). No changes to `bridge.ts`,
`mockBridge.ts`, `electron/`, `agent.ts` or `styles.css`. The button reuses the existing `ibtn sm on`
styles, and the pill reuses `ptt-status`.

Tests: vitest 259 passing (new `tests/voice.test.ts`, 12 tests), tsc clean, `npm run build` OK.
  e2e `voice-reply.spec.ts` (4 tests; repeated 4x, all pass), `push-to-talk`, `smoke`, `versions` and
  `electron` pass. One `electron.spec` run failed once on the region-trim test and passed on rerun.
  That test is unrelated and timing-sensitive.
Muse spend: $0.00 (no Meta calls).

Left / known issues:
- Not yet heard by the user. VITS output varies a little from run to run (it is stochastic).
- The voice uses its own AudioContext and output, so a speaker-device choice in the app (if one is
  added) would not apply to it.
- If a new reply arrives while Muse is still speaking, it cuts off the older one, and playback then
  stays paused (it does not resume).
- The `spikes/README.md` row is not added: the spike lives in `app/scripts/tts-*.mjs`, not in a
  Python spike folder.
