# Retake V2: automatic cuts and review markers

## Use

Restart the OpenCut server and reopen the Premiere panel after this update. In **Retake V2**, click **Auto-remove retakes**. Loading a transcript separately is optional: the operation loads/reuses it as needed.

The operation analyzes the recording, keeps the last recorded take within confirmed retake groups, checks selected source-audio boundaries, verifies the actual final plan, and applies eligible cuts to a **duplicate sequence**. Uncertain footage stays and receives **OpenCut Review** sequence markers. Open **Window > Markers** in Premiere to inspect reasons and locations. Markers are mapped after confirmed ripple removal, not left at old times.

A run with zero eligible cuts but review items still creates a duplicate with review markers. A clean no-cuts/no-review result changes nothing. **Analyze retakes** performs the same planning checks without cloning, cutting or adding timeline markers; review words are underlined in the transcript. Existing manual selections and Apply remain available for editor-directed edits.

## Explicit outcomes

- **AUTO_CUT:** a supported later replacement exists, an independent critique approves the editing logic, word/frame mapping passes, bounded source-audio checks find quiet internal boundaries, and final-plan verification approves the exact eligible set.
- **KEEP:** ordinary content or intentional repetition that needs no edit.
- **REVIEW:** unclear retake relationship, uncertain audio boundary, incomplete coverage, distant repetition needing context, unsupported timeline layout, or a dependent edit that cannot be safely completed. No automatic deletion of that passage.

These are eligibility states, not calibrated confidence percentages or a guarantee of 100% accuracy. “Verified” timeline geometry means positions/source ranges/sync match the planned edits; it does not prove semantic truth or audible perfection.

## Last-take policy

The latest recorded attempt wins within a confirmed retake group, including when it omits wording or a payoff from an earlier version. Unrepeated prefixes needed for partial restarts stay. Unrelated additions, intentional emphasis and recaps are not retakes merely because they discuss the same topic. Explicit manual Keep selections are protected.

A truncated final attempt is not permission to invent a completion. Unresolved joins stay for review rather than switching silently to an earlier take.

## Analysis and verification

1. Read the live sequence and cached verbatim transcript. Fingerprint the source/timeline state.
2. Review every owner window (600 words, 180 words of neighboring context). Recover bounded right-hand context for incomplete events. Oversized or invalid-coverage windows remain review items.
3. Retrieve distant exact repeated openings (12 normalized words separated by more than 600 words). If not already covered by a discovered event, mark both passages for review. This is conservative candidate retrieval, not automatic proof of a distant retake; it will not find every distant paraphrase.
4. Split each event into independent edit units. Dependent cuts may share one bundle when they must happen together for a coherent join. Every event word must be accounted for by a unit. Strict schemas and runtime checks reject contradictory cut/keep responses.
5. Independently critique each cut bundle. Semantic uncertainty stays a review item instead of forcing a cut through repeated prompting.
6. Check frame geometry and source audio for each eligible range. If one cut in a dependent bundle fails, retain the entire bundle, without blocking independent bundles.
7. Verify the actual surviving plan after timing filtering. If rejection changes it, allow one more bounded final check. Never apply an unverified remainder.
8. Freeze the acoustically checked frames. Apply these exact frames rather than replanning a different edit during apply.

Calls use the panel-selected Claude model (Sonnet when Latest) at medium effort. Semantic results are cached by engine source, source/timeline/transcript data, model/effort and protected words. Repeated runs with unchanged input reuse semantic decisions and redo boundary/final-plan checks. No new provider credentials are required.

## Audio-boundary checks

The implementation uses short local ffprobe/ffmpeg reads, not a video render or an audio upload. It requires one mono/stereo source stream and inspects a 0.7-second excerpt around each internal cut boundary. A 30-ms neighborhood must meet conservative absolute/relative peak thresholds. Source clip edges without a retained neighbor are treated separately.

The frame planner may snap inward by less than a frame to protect retained words, but that alone is no longer enough for automatic eligibility: the audio check must pass too. Ambiguous/noisy/voiced boundaries are kept and marked. This is quiet-boundary evidence, not forced phoneme alignment. No automatic re-alignment or proof that the ASR wording is correct is claimed. These conservative thresholds may leave more review items on noisy or tightly spoken recordings.

## Premiere behavior and limits

Automatic removal supports one populated video track with one matching camera-audio track: identical source media/ranges and timeline geometry, enabled and unlocked, forward normal speed, frame-aligned edges, no transitions/captions. In Auto mode, unsupported layouts skip transcription/AI and are retained and marked on a duplicate rather than sent through the all-track razor engine. Analyze remains available for transcript review where the source supports it. Expanding reliable cuts to multicam, external audio, overlays or complex retiming is separate work.

Before every automatic mutation, the host checks expected sequence identity, timebase and clip geometry inside that same synchronous host call. Deletion batches are lifted first, geometry is checked, gaps are closed once, and final source/timeline positions are checked again. Failure or cancellation can leave a partially edited **duplicate**; the original is the recovery point. No blind retries and no claim of a single-step CEP undo.

Review markers use their own sentinel and leave user/Classic markers alone. Their count, position, name and comments are read back after creation. Placement verification permits up to one frame of marker-position quantization. Existing user markers on the duplicate are not automatically retimed by this feature.

## Records and diagnosis

- `.cache/retake-diagnostics/latest.json`: latest 40 detailed stage records, version `reliable-retakes-7-review-markers`.
- `.cache/retake-runs/<runId>.json`: durable original geometry, frozen plan, outcomes, exact cut ranges, duplicate identity, marker plan and pending/verified/partial operations.
- `.cache/retake-plans/<hash>.json`: cached semantic decisions. These contain transcript-derived information and are local files.

The existing `EDITAGENT_CACHE_DIR` redirects these directories. No credentials or CLI environment are written. A required operation-ledger write failure stops further edits. Diagnostic detail is best-effort; the operation ledger is saved before mutations.

## Validation status

At Tyler's request, this update was checked with npm/syntax and whitespace checks only. No model calls, audio checks, automated test suite, or Premiere edits were executed during implementation. Actual editing accuracy, marker behavior and acoustics still require live validation. The new independent-unit schema and final-plan behavior have not been benchmarked on recordings.

## Implementation files

`server/retakes/reliable.js`, `reliable-session.js`, `timeline-safety.js`, `acoustic-boundaries.js`, and `review-markers.js`; the existing review/transcription mapping and RPC path; `cep-panel/host/premiere.jsx` and the Retake V2 panel files.
