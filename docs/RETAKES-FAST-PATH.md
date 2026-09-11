# Retakes audit + fast path (2026-09-09)

Audit of the Retakes feature (**Load segments** -> **Analyze w/ Claude** -> Apply) and a
scaffold for doing the same job in seconds instead of minutes, with almost no model tokens.

Status: **wired in and live** as of 2026-09-09. "Analyze w/ Claude" runs the fast path by
default (`EDITAGENT_RETAKE_MODE=hybrid`). The original path is still there as
`EDITAGENT_RETAKE_MODE=ai`. Not yet verified in live Premiere.

---

## 1. What the current pipeline actually does

```
Load segments      buildReview (review.js)
                     -> gather used source ranges per media
                     -> transcribeSourceRanges (local whisper via hyperframes CLI)
                     -> sliceWordsToWindow  -> groupIntoPhrases  -> partitionClip
                     -> N segments (~1 sentence or 14 words each), all decision:"keep"

Analyze w/ Claude  aiRetakes (rpc/index.js)
                     -> drop word-empty segments (deterministic auto-cut)
                     -> analyzeRetakes (ai.js): planRetakeChunks -> 36-segment blocks,
                        +14 segments of context each side, 4 concurrent `claude -p` calls
                     -> merge cut decisions by owning window
```

## 2. Measured cost (from your own `.cache/usage-log.json`, not estimates)

| run | segments | `claude -p` calls | wall clock | output tokens |
|---|---|---|---|---|
| Opus, high | 842 | 24 | **6m 53s** | 112,679 |
| Sonnet, medium | 765 | 22 | 4m 09s | 80,709 |
| Sonnet, medium | 758 | 22 | 3m 11s | 63,951 |
| Opus, high | 553 | 16 | 5m 20s | 94,704 |

Plus, per call, a **7,942-character system prompt (~2k tokens)** re-sent every time
(`retakeSystem()` injects a whole skill section), and a fresh CLI process boot.
Transcription time is **not instrumented at all** (`recordUsage` for transcription stores
`seconds` of audio but no `durationMs`), so the other half of your 15-20 minutes is
currently invisible.

## 3. Root causes

1. **Every segment is sent to a reasoning model.** On an 842-segment timeline, most
   segments are unique forward-moving speech with no duplicate anywhere near them. They
   still cost a place in a window, context tokens in two neighbouring windows, and
   reasoning tokens.
2. **The context margin re-sends text.** With `block=36` / `context=14`, the average
   segment's text is transmitted ~1.8 times.
3. **Fixed per-call overhead x N.** 24 calls x (~2k system prompt + CLI boot + model
   spin-up) before any judgment happens.
4. **`effort: high` is the default** for a task that is mostly string comparison.
5. **The core question is not a reasoning question.** "The speaker restarted this line
   four times" is decidable from the transcript text alone. Only two sub-questions
   genuinely need judgment: *is this a restart or a new point?* and *if no take is clean,
   which partials stitch together?*
6. **Segmentation inflates N.** `EDITAGENT_PHRASE_MAX_WORDS=14` plus sentence splitting
   turns an hour of raw talking head into 700-900 segments. Fine for a matcher, expensive
   per-item for a model.

## 4. Proposed architecture: three tiers

```
Tier 0  deterministic, free, instant
        word-empty clips              -> cut          (already exists)
        restart staircases            -> cut all but the last usable pass
        orphan cut-off fragments      -> cut
        unique forward speech         -> keep, never leaves the machine

Tier 1  model, ONE small call, only on flagged groups
        groups where no take is clean, or where two clean takes may be
        different points rather than a restart
        payload = the takes of those groups only, ~1.5k tokens

Tier 2  human, in the panel (already built)
        the group list with keeper highlighted, re-insert, Soft Apply
```

Tier 0 is `server/retakes/detect.js` (new, this scaffold). Tier 1 reuses `askClaude`
with a much smaller prompt. Tier 2 is unchanged.

### How Tier 0 works

Everything runs on the transcript text you already have, with exact word timings from
the HyperFrames whisper pass.

- **`tokenize`** strips transcription parentheticals and records two flags per take:
  `truncated` (ends `-` or `...`, i.e. cut off mid-line) and `terminal` (ends `.?!`).
- **`commonPrefix`** is the primary retake signal: a restart re-says the same opening
  words. The final word of a cut-off take may be a partial or a swapped word
  ("autonomin-" -> "autonomously"), so it matches on a shared 4-character stem.
- **`overlapRatio`** (LCS over content words, function words dropped) catches a retake
  that reworded its opening: *"But ultimately, here's the idea..."* -> *"But this is the
  idea..."*, which a prefix test alone misses.
- **`selfRepeat`** flags a take that stutters over itself ("and just, just, and just this
  loop") as not-clean even though it may be long.
- **`detectRuns`** union-finds those links inside a bounded lookback (14 segments / 180s),
  so grouping is O(n x lookback) and finishes in milliseconds on any length of timeline.
- **Keeper rule:** the keeper is the **last usable pass** of a run. A re-record supersedes
  what came before. This single rule, with no model, is the highest-value decision in the
  feature. (The current LLM prompt spends most of its instruction budget teaching it.)

### Measured result

Scored against the **same human-labeled 412-segment fixture** as the LLM path
(`server/test/eval/fixtures/retakes-n8n.golden.json`), with the same metrics:

| path | wall clock | tokens | calls | F1 | leftover dupes | lost content |
|---|---|---|---|---|---|---|
| current chunked LLM (2026-06-29 baseline) | minutes | ~80-110k out | 12-24 | 97.4% | 3 | 4 |
| **Tier 0 alone (this scaffold)** | **6 ms** | **0** | **0** | **95.2%** | **10** | **5** |
| Tier 0 + Tier 1 (projected) | seconds | ~2-4k | 1 | - | - | - |

Reproduce with `npm run eval:detect` (free, instant). `-v` lists every disagreement.

### What Tier 1 gets sent

`planEscalation` returns only the ambiguous groups:

- `mode: "tight"` (default): **20 groups, 100 of 412 segments, ~1,551 tokens.** One call.
- `mode: "wide"`: every multi-take group, ~62% of the timeline, still one call, and it
  covers roughly twice as many of Tier 0's disagreements.

Either way it is **one small call instead of 24 large ones**.

## 5. Integration (the wiring that is NOT done yet)

`aiRetakes` in `server/rpc/index.js` currently calls `analyzeRetakes(speechSegs, ...)`.
The fast path slots in at exactly that seam:

```js
import { analyzeRuns } from "../retakes/detect.js";

// Tier 0: free, instant, no model.
const { decisions: fast, groups, escalate } = analyzeRuns(speechSegs);
helpers.progress(`Found ${fast.length} duplicate takes in ${groups.length} groups.`);

// Tier 1: one small call, only if there is anything genuinely ambiguous.
let refined = [];
if (escalate.length && params.review_ambiguous !== false) {
  refined = await reviewAmbiguousGroups(escalate, speechSegs, { model, effort: "low", token });
}
const decisions = mergeDecisions(fast, refined); // refined wins per group
```

`reviewAmbiguousGroups` is the one piece still to write: it formats each flagged group as
`group N: [idx] text` lines and asks only *which index (or indices) to keep* — a far
smaller schema and system prompt than `retakeSystem()`.

Also worth doing at the same time:

- Record `durationMs` on transcription usage entries so Load segments becomes measurable.
- Default `EDITAGENT_AI_EFFORT` to `low`/`medium` for the escalation call; `high` buys
  nothing once the model only sees ambiguous groups.
- Keep the current `analyzeRetakes` reachable behind a flag as the reference path, and
  keep both evals so a change to either is scored the same way.

## 6. Load segments: separate findings

The AI step is the headline, but Load has its own slack:

- **Whisper model.** `small.en` is the default. Duplicate detection matches repeated word
  sequences, so `base.en` (roughly 3x faster) is very likely sufficient for the retake
  pass. Worth an A/B on the same source with `npm run eval:detect` as the scorer.
- **Concurrency.** `EDITAGENT_TRANSCRIBE_CONCURRENCY` defaults to 3, but whisper.cpp is
  already multi-threaded across all cores. Three concurrent instances probably oversubscribe
  the CPU rather than overlap usefully. Measure 1 vs 2 vs 3 before assuming 3 is faster.
- **No timing instrumentation** (see above) means neither of the two points above can
  currently be settled with data. Fix that first.

## 7. Where this could go further (word-level)

The current segmentation tiles clips into ~14-word phrases before anything looks for
duplicates, so a cut boundary can only ever land on a phrase edge. Because whisper gives
exact per-word timings, the same matching can run **on the word stream directly**: find
repeated word n-grams, take the match span's own start/end times as the cut range, and
derive segments from the match boundaries rather than from fixed phrasing. That removes
the "keeper take starts two words late" class of artifact entirely. The functions in
`detect.js` are token-array based, so they port to a word stream unchanged; only
`detectRuns`'s input changes.

## 8. Files in this scaffold

| file | what |
|---|---|
| `server/retakes/detect.js` | Tier 0 detector. Pure functions, no I/O, no ctx. |
| `server/retakes/fast.js` | Mode routing, Tier 1 escalation call, merge of the two. |
| `server/test/retakeDetect.js` | Unit checks (24). Wired into `npm test`. |
| `server/test/eval/evalDetect.mjs` | Offline accuracy eval vs the human-labeled fixture. `npm run eval:detect`. |

`server/ai.js` `analyzeRetakes` and its prompts are untouched and still reachable via
`EDITAGENT_RETAKE_MODE=ai`, so the old behaviour is one setting away at any time.
