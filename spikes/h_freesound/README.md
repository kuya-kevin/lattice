# h_freesound: reference sounds from Freesound

A small, reproducible set of CC0 / CC-BY one-shots and textures (~140 sounds, 18 categories), used as:
real-world targets for the synth optimizer, Muse and Magenta RT2; labelled data for testing "ears"
(PE-AV) against Freesound tags, descriptions and timbre scores; and app starting points.

## Rebuild

```sh
# needs FREESOUND_API_KEY in the repo-root .env (sent only as an Authorization header, never logged)
cd spikes && uv run python h_freesound/curate.py              # all categories, 8 per category
uv run python h_freesound/curate.py --only kick pad           # a subset
uv run python h_freesound/curate.py --offline                 # rebuild from caches, no network
```

Search responses are cached in `data/freesound/cache/search/` and previews are kept in
`data/freesound/audio/`, so a rerun costs zero requests. Delete the cache to re-query.
Every real request is appended to `data/freesound/requests.log` (no key). The script throttles to
about 1 search/s, well under Freesound's 60/min and 2000/day. A full fresh build uses ~140
searches and ~200 to 300 preview downloads.

## What it does

1. **Search**: for each category, several query terms x three `brightness` bins (dark / mid / bright),
   filtered to `license:("Attribution" OR "Creative Commons 0")` and a duration range. Pitched categories
   also need `note_confidence >= 0.5`; drums need `single_event:true`. Licence URLs are re-checked locally.
2. **Exclude**: tags such as `loop`, `melody`, `arpeggio`, `chord` (except pads), "loop" in the name,
   and Freesound's `loopable` flag. A label check requires the name or tags to mention the category
   (`MUST`) and rejects names that point to another instrument (`NOT`), because search alone put
   "EP" samples under piano, kicks under 808 and log drums under closed hat. (`bpm` is set on almost every sound, one-shots included, so it is
   not a usable loop signal.)
3. **Rank and diversify**: relevance plus one-shot-ish tags, `note_confidence` and `single_event`;
   round-robin across brightness bins, preferring octaves not yet taken; at most 2 per pack and per uploader
   per category; deduped by id across categories.
4. **Download** the HQ MP3 preview (original files need OAuth2) and write a trimmed mono 22050 Hz WAV
   (`librosa.effects.trim`, top_db=40; levels are not normalized).
5. **Local QC** (librosa): drop near-silent clips (peak < -35 dBFS); pitched: pyin, drop if under
   50% voiced (35-40% for bells and brass) or a second stable note (>= 100 ms, not an octave) covers
   > 30% of voiced frames; drums: drop if more than 2 strong onsets.
6. **Write** `data/freesound/manifest.json` + `.csv` (kept), `dropped.json` (with reasons), `stats.json`,
   and `README.md` (attribution list). A `test` split of round(20%) per category (2 of 8, so 25% overall) is drawn with a fixed seed.

## Manifest fields

`id, category, kind, name, tags, description, license, license_name, username, url, pack_id`,
Freesound timbre scores `brightness, warmth, roughness, hardness, depth` (0-100),
`fs_pitch, fs_note_name, fs_note_confidence, fs_bpm, fs_single_event, duration`,
measured `peak_db, trimmed_duration, voiced_frac, other_note_frac, n_notes, f0_hz, f0_note` (pitched) or
`onsets` (drums), pitch agreement `fs_pitch_cents_off, fs_pitch_ok(_any_octave), fs_note_ok(_pitch_class)`,
`search_query, brightness_bin, mp3, wav, split`.

**Use `fs_note_name`, not `fs_pitch`**: in this set Freesound's `pitch` value disagrees with the
measured f0 most of the time, while `note_name` usually matches it. See the agreement fields.

## Licences

Only CC0 and CC-BY. CC-BY sounds need attribution (author, title, link, licence) anywhere they are
shown or used, including the demo. `data/freesound/README.md` has the generated attribution list.
