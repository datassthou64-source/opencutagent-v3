# Retake V3: plan

Status: plan only, nothing implemented. Written 2026-09-23 after reading the Retake V2 code
(`server/retake-v2.js`, `server/retakes/*`, `server/rpc/index.js`, `cep-panel/host/premiere.jsx`)
and your real run data (`.cache/usage-log.json`, `.cache/retake-diagnostics/latest.json`,
`.cache/transcripts/Sean_09212026_A_CAM.*.ranged.json`).

---

## 1. What is actually going wrong today

### 1.1 The timing layer throws the AI's answer away

Your latest diagnostic run (`Sean 09212026 A CAM`, 439 words, 7 stages):

- **Discovery** correctly found one retake event spanning sentences 0-26: four attempts at the intro,
  including "Okay. Let's start this over again. Take two." and an aborted "...damn it".
- **Selection** proposed the right edit: cut W0-213 and W224-294, keep W214-223 and W295-337.
- **Verification** (a second model call) approved it.
- **Timing** then rejected **both** cuts: *"No safe frame-aligned gap, or source occurrence is ambiguous."*
- Result: **0 cuts applied**, after 5 `claude -p` calls, ~69s and ~68k input tokens.

The other five Reliable runs in your usage log show the same pattern: 2-5 calls, 1-3 minutes,
48k-98k input tokens, and 0-2 suggestions each on a ~4-minute clip.

### 1.2 The root cause is the word timestamps

Transcription moved from ElevenLabs Scribe to **local whisper.cpp `small.en`** (via the
HyperFrames CLI). The README and CLAUDE.md still describe Scribe. In the cached Sean transcript:

- **401 of 438 word-to-word gaps are exactly 0.0s.** Whisper tiles words back to back, so it
  carries no information about where the pauses are.
- Whisper word timestamps typically drift by 100-300ms.
- Whisper also **skips whole passages**. Measured against Scribe v2 on the same clip (see 1.3),
  it missed about 59s of the 252s, including the ending of the final keeper take.

`planSafeWordCuts` and `filterTimedSuggestions` try to put each cut "in the air between the
removed word and the kept word". When the gap is always zero there's no air to cut in, so
anything the protection rules can't prove safe is deferred. Then the acoustic check tests only
the exact planned frame instead of searching nearby, so even a near miss fails.

**In short, the system uses ASR word timestamps as the source of truth for where to cut.
That's the wrong source.** ASR timestamps are good for knowing which words were said in
roughly which second. They aren't accurate enough to place a cut.

### 1.3 Measured: whisper small.en vs Scribe v2 on the same clip (2026-09-23)

Same source range (Sean 09212026 A CAM, source 4122.4s-4374.6s, 252s), cost about $0.015:

| | whisper small.en | Scribe v2 |
|---|---|---|
| Words | 439 | **645** |
| Speech with no transcript at all | **~59s** | 0 |
| Zero gaps between words | 401 of 438 | **1 of 644** |
| Gaps ≥0.3s (usable cut points) | 16 | **80** |
| Cut-off words (`this--`, `v--`) | 0 | 4 |
| Audio events | 0 | `[clears throat]`, `[sighs]` |
| Stutters ("And, and", "the machine that, and the machine that") | smoothed away | kept |

What whisper dropped, all of which should be kept or is a take the editor needs to see:

- 47.7-62.0s: an entire third attempt (40 words)
- 91.2-93.7s: "I'm gonna tell you right now, that code is in this video."
- 139.2-143.3s: "Seven laws, a calendar written in the sky, and nine specific floors to go through."
- **175.3-210.4s: the ending of the final keeper take (112 words)**, from "...fuck you money. The
  amount that lets you tell the system or the matrix to take a walk" through "I'm not gonna take
  you off your spiritual journey..."

The dropped audio doesn't vanish. It gets absorbed into neighboring whisper words: one word
("machine.") spans **16 seconds** and another ("make.") spans 8.4s. Cutting that one "word"
would delete 16s of real speech.

Corrections to section 1.1: Claude's cut list was right **for the transcript it was given**,
but that transcript was missing the ending of the real final take. And "in Jesus" wasn't a
mishearing: the speaker actually said "That code is in... Ugh, Jesus."

**Conclusion: Scribe v2 (or another verbatim ASR) is required for retakes, not optional.**
A transcript that silently skips 23% of the speech can't safely drive cuts, no matter how
good the AI judgment or the edge snapping is. Local whisper can stay as a free fallback only
with a coverage check that marks any long un-transcribed speech (from the loudness envelope)
as REVIEW.

### 1.4 Too many engines, too many calls

The Retake V2 tab currently has three engines layered on top of each other:

| Engine | File | Calls per run | Notes |
|---|---|---|---|
| Classic suggestions | `review.js` + `retakes/fast.js` + `detect.js` | 0-1 | Phrase-level. Deterministic detector scores 95% F1 in 6ms |
| AI-Lite | `retakes/word-ai.js` | N discovery + M precision | One logged run used 366s and 56k in / 36k out (haiku) |
| Reliable (Auto-remove) | `retakes/reliable.js` + `reliable-session.js` | discovery windows + 1-2 per event + 1 per cut + final plan | All calls run **sequentially**; each is a fresh CLI boot |

Where the tokens go:

- Every `claude -p` call re-sends Claude Code's own default system prompt (`inlineSystem: true`
  keeps it), about 10-15k tokens even though it's mostly cache reads. On a 439-word transcript,
  the transcript itself is under 1k tokens. **Most of the token cost is per-call overhead, not
  content**, so the number of calls matters far more than prompt wording.
- Verify-the-verifier layers (select, then verify each cut, then verify the final plan) cost
  one boot each and mostly re-confirm what the selector already said.

---

## 2. First principles

A retake is **a stretch of speech that the speaker later re-said better**. To remove it
reliably, you need three answers from three different sources:

| Question | Best source | Why |
|---|---|---|
| **What** was said? | Transcript (ASR) | Only text can tell "same line again" from "new point" |
| **Which** attempt to keep? | Claude, reading the whole transcript once | Judgment call; needs global context (distant retakes, recaps) |
| **Where** exactly to cut? | **The audio waveform** (pauses) | Speakers breathe or pause before restarting. The quiet gap is the natural, inaudible cut point |

The current design asks the transcript to answer the third question. V3 flips it:

> **Cut points come from the audio. Decisions come from the text. Premiere does the cutting.**

Nearly every retake starts after a pause. You stop, breathe, and go again. So if the timeline is
first split into **speech islands** (speech between pauses of ~250ms or more, detected by the
free loudness envelope you already have), a retake is almost always a whole island or a run of
whole islands. Cutting whole islands puts every edge in silence by construction, so there's no
word-timestamp snapping and no "No safe gap" rejections.

---

## 3. Proposed pipeline

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ 1. MEASURE (free, local, cached)                                         │
 │    ffmpeg loudness envelope (audio/levels.js, 20ms windows, exists)      │
 │    -> pause map -> SPEECH ISLANDS  (min pause ~250ms, tunable)           │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ 2. TRANSCRIBE (cached)                                                   │
 │    whisper / Scribe words -> assigned to islands by max overlap          │
 │    (tolerates 100-300ms ASR drift because islands are the unit)          │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ 3. PRE-SCAN (free, deterministic, ms)                                    │
 │    detect.js on islands: repeated openings, LCS overlap, truncation,     │
 │    self-stutter, explicit cues ("take two", "start over", "damn it")     │
 │    -> candidate groups + "certain" groups                                │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ 4. JUDGE (ONE Claude call for the whole video)                           │
 │    compact island transcript + pre-scan hints -> sparse list of cuts     │
 │    (island ranges, optional word trims inside an island)                 │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ 5. RESOLVE EDGES (free, local)                                           │
 │    whole-island cuts: edges = middle of the pause (already silent)       │
 │    in-island word trims: snap to the quietest 20ms valley within         │
 │    ±150ms of the ASR boundary; if none is quiet enough -> REVIEW         │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ 6. APPLY IN PREMIERE (see section 5)                                     │
 │    duplicate sequence -> razor -> DISABLE rejected takes -> review ->     │
 │    "Commit" ripples them out                                             │
 └──────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Speech islands (new, small)

- Input: the existing normalized peak envelope (`getLevels` / `sliceEnvelope`), per clip.
- Threshold: reuse the Remove Silences threshold if the user has set one, otherwise
  `estimateThreshold`. Minimum pause length ~250ms (restarts almost always have ≥300ms).
- Each island record: `{ id, clipKey, srcIn, srcOut, pauseBefore, pauseAfter, words[] }`.
- Word-to-island assignment by **maximum overlap**, not by exact edges. Whisper drift stops
  mattering because a word only needs to land in the right island.
- Words that land in no island (whisper hallucinations in silence) are dropped.
- `pauseBefore` is itself a useful signal: long pause, then a repeated opening, is a strong
  retake indicator.

### 3.2 Pre-scan (reuse `retakes/detect.js`)

`detect.js` is already token-array based and scores 95.2% F1 alone on the 412-segment golden
fixture. Point it at islands instead of phrases and add:

- **Explicit cue phrases**: "take two", "start (that) over", "let me redo", "one more time",
  "cut", "damn it", "okay, again". Anything before a cue that matches what follows is almost
  certainly a failed take.
- **Pause weighting**: a restart after a pause of more than 1.5s gets a stronger link.
- **Output**: `certain` groups (can be auto-cut even with AI off) and `candidate` groups (hints
  for the model).

This tier gives the **free, zero-token "Fast" mode**, and it's also the safety net if Claude is
unavailable.

### 3.3 One Claude call (replaces discovery + selection + verify + final verify)

Payload format, one line per island, as short as possible:

```
#41 03:12 +1.8s | So the first thing you want to do is open the
#42 03:15 +0.4s | So the first thing you want to do is open the settings panel and-
#43 03:19 +2.1s | Okay. The first thing you want to do is open settings, then go to API keys.
HINT g7: #41-43 repeated opening (pre-scan)
```

- `#id`, `mm:ss`, and `+pause` carry the timing information the model needs. Word IDs are
  not sent in the main pass.
- The response lists **only cuts** (sparse), so it doesn't grow with video length:

```json
{ "cuts": [
  { "islands": [41, 42], "reason": "restart; #43 is the last complete take", "confidence": "high" },
  { "island": 57, "trimWords": [0, 3], "reason": "stutter 'the the the'", "confidence": "medium" }
], "review": [ { "islands": [88, 90], "reason": "could be a recap, not a retake" } ] }
```

- `trimWords` is an **offset inside one island** (word 0-3 of island 57). That's small and
  easy to validate, and only needed for mid-island restarts.
- **Token math:** 1 hour of talking-head ≈ 9,000 words ≈ 12k tokens of plain text, plus about
  20% for ids, times and pauses, so ~15k input. Output is a few hundred to ~2k tokens. **One
  call per video** instead of 5-30. Current Sonnet/Opus context handles this easily, and the
  whole video in one view is what catches distant retakes. The current windowed design can
  only flag those as "review".
- **Over ~2 hours**: split into 2-3 large windows at long pauses (topic breaks), with the
  pre-scan's candidate list shared across windows. Don't go back to 600-word windows.
- **Optional token saver:** send only islands within ±8 of a pre-scan candidate, plus a
  one-line outline of the rest. That's typically 30-50% of the text. Keep it as a setting and
  measure it against the eval before making it the default.
- Model and effort: Sonnet at medium effort is a good default. Offer Opus as an option.

### 3.4 Deterministic checks replace the "verify" calls

Instead of asking Claude a second time, check in code:

1. Every cut island has a **later kept island** whose text overlaps (LCS ≥ ~0.5, or a shared
   opening). This is the "last take wins" evidence, and it's cheap to compute.
2. No cut touches a **protected** island (manual Keep).
3. `confidence: "high"` and check 1 passes: **AUTO**. Anything else: **REVIEW**.

A cut that fails a check is downgraded to review, never silently dropped.

### 3.5 Edge resolution (the fix for "No safe frame-aligned gap")

- **Whole-island cuts**: the cut edge is the middle of the pause before or after, or the
  kept side's island edge plus a small handle (60-100ms), rounded to the frame grid. This is
  silent by construction.
- **Word trims inside an island**: take the ASR boundary and **search** ±150ms of the envelope
  for the lowest 20ms window. If that valley is under the threshold, cut there; otherwise mark
  it REVIEW. This replaces "test one exact frame, reject on failure" with "look for the quiet
  point nearby".
- Keep the existing BigInt tick/frame math (`timecode.js`) for the final frame conversion. That
  part is solid.

### 3.6 Transcription recommendation

Islands make timestamp accuracy much less important, but a **verbatim** transcript still helps
detection. In order of preference:

1. **ElevenLabs Scribe v2**: the default for retakes (see 1.3). ~$0.22/hr, verbatim, real gaps
   between words, audio events. The code was removed in commit `60c1bad`; restore it from `83db2cf`.
2. **Local whisper, tuned**: `medium.en` over `small.en`, and whisper.cpp's DTW token
   timestamps if the HyperFrames CLI exposes them (verify). Free, but it still smooths away
   stutters.
3. Make the engine a panel setting, "Local (free)" or "Scribe (verbatim, paid)", since the
   interface in `transcribe.js` is already pluggable.

Also update the README and CLAUDE.md, which still say Scribe is the engine.

---

## 4. Modes in the panel (simplify from three engines to one pipeline)

| Mode | What runs | Cost |
|---|---|---|
| **Fast** | Islands + pre-scan only; auto-cuts `certain` groups | 0 tokens, seconds |
| **Smart** (default) | Islands + pre-scan + one Claude call | ~15-20k in per hour of footage, 1 call |
| **Careful** | Smart, then a second Claude call over **REVIEW items only** (cut list and its neighbors) | +1 small call |

Retire AI-Lite and the multi-stage Reliable engine once V3 matches them on the eval. Keep the
code behind a flag until then.

---

## 5. Doing the edit inside Premiere, for maximum flexibility

The host script already covers most of what's needed: `duplicateRetakeSequence`,
`removeRangesBatch` (razor, then lift), `closeRangeGaps` (ripple), `muteRange` (which
**already sets `clip.disabled = true`**), markers with colors, and `reinsertSegment`.

### Recommended flow: "soft cut, then commit"

1. **Duplicate** the active sequence (exists). The original stays untouched as the recovery point.
2. **Razor** at every island edge that borders a cut (exists, frame-exact).
3. **Disable** the rejected takes instead of deleting them. Reuse the `muteRange` path on
   V and A together. In Premiere they show dimmed in place, and playback skips over them as
   black or silence.
4. Lay **markers**: one color per retake group, green on the keeper, a distinct color for
   REVIEW (exists: `applyEditMarkers` / `applyReviewMarkers`).
5. You review in Premiere with normal tools: Shift+E re-enables any take, you can swap which
   attempt is enabled, and you can hear each join by scrubbing.
6. **Commit** (new panel button): find every disabled clip that OpenCut created, lift it, and
   ripple the gaps with the existing `closeRangeGaps`. That's one batched host call.
7. **Uncommit** is just the original sequence, or Cmd+Z.

This gives full in-Premiere flexibility, including hand-picking takes on the actual timeline,
without guessing at undo stacks. It also avoids the Premiere API limit that clip colors can't
be set (DVAPR-4217788): **disabled state is the visible, clickable flag.**

Tracking which disabled clips are OpenCut's: record the source ranges in the run ledger
(`.cache/retake-runs/`) and match on media, track and source range on commit, the same way
reconcile already works. Never use clip IDs, since they renumber.

### Layout support

`requireSimpleTimeline` currently refuses anything except one video track plus one matching
audio track. The soft-cut flow can loosen this safely:

- Razor and disable **every track item that overlaps the cut range in time** (camera, lav,
  B-roll and music all stay in sync).
- Keep refusing only transitions across a cut edge and speed-changed clips. Mark those as REVIEW.

---

## 6. Build order

| Step | What | Size | Proves |
|---|---|---|---|
| 0a | **Restore Scribe v2** as the default engine, whisper as the fallback + coverage check (envelope speech with no words -> REVIEW) | S | Sean clip: 645 words, no uncovered speech |
| 0 | **Instrument**: log per-stage time and tokens, transcription `durationMs`, and a "rejected by timing" count | S | Baseline numbers before touching anything |
| 1 | `retakes/islands.js`: envelope to islands, words to islands (pure, unit tested) | S | Sean clip: island edges fall in the pauses before "Take two" and "Most of you..." |
| 2 | Pre-scan on islands (`detect.js` adapter + cue phrases) | S | `npm run eval:detect` stays ≥95% F1 |
| 3 | Single-call judge (`retakes/judge.js`, one schema, one prompt) + deterministic checks | M | New eval: the Sean clip gives the same cuts as the diagnostic run, **now with 0 timing rejections** |
| 4 | Edge resolver with valley search | S | Every AUTO cut has both edges below threshold |
| 5 | Host: `disableRanges` (razor + disable, all overlapping tracks) and `commitDisabled` | M | Phase-0 probe in live Premiere: `clip.disabled` writable on V and A, and Shift+E toggles it back |
| 6 | Panel: Fast / Smart / Careful, soft-cut review list, Commit button | M | End-to-end on a real 30-60 min recording |
| 7 | Retire AI-Lite and Reliable behind a flag; update README and CLAUDE.md | S | |

### Eval to add

Label the Sean clip, and one long (30-60 min) recording, at the island level (keep/cut). Score
three numbers per run:

1. **Decision F1** vs the human labels (what the eval already measures).
2. **Executable rate**: the share of correct decisions that actually reached the timeline. This
   is the number that is currently **0%** on the Sean run and that no eval measures today.
3. **Cost**: calls, input and output tokens, and wall-clock time.

---

## 7. Open questions for you

2. **Default apply**: soft-cut (disable, then Commit), or straight ripple-delete on the
   duplicate?
3. **Recording habit**: would you use a spoken cue ("cut", "again") or a clap before each
   retake? If so, detection becomes close to trivial and nearly free, and the pre-scan can
   treat the cue as certain.
4. **Typical footage**: single camera plus one mic, or multicam and lav? That decides how much
   of section 5's layout work is needed up front.
