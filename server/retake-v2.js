// Word-level retake review. This deliberately sits beside review.js (Retakes
// Classic): both use the same cached transcript and the same batched Premiere
// cut engine, but V2 never reduces an edit decision to a phrase/card boundary.
import { getTimeline, round3 } from "./tools/util.js";
import { sourceRangeToTimelineFrames, sourceSecToTimeline } from "./transcription/timecode.js";
import { applyRangesBatched } from "./silences.js";
import { timelineFingerprint } from "./retakes/timeline-safety.js";
import { captureUndo } from "./undo.js";

const SENTENCE_END = /[.?!]["'”’)\]]*$/;

function normPath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").toLowerCase();
}

function joinTokens(tokens) {
  return tokens.join(" ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/([(“])\s+/g, "$1")
    .trim();
}

function contentTokens(words) {
  return (words || []).filter((w) => (w.type || "word") !== "spacing" && Number.isFinite(w.start));
}

/**
 * Turn the audible word list for each timeline clip into one document model.
 * Phrase grouping is intentionally absent here: sentence boundaries affect only
 * layout/timestamps, never what can be selected or cut.
 */
export function buildRetakeV2Document(clipEntries, sequence, opts = {}) {
  const sentenceGapSec = Number.isFinite(opts.sentenceGapSec) ? opts.sentenceGapSec : 0.8;
  const timebase = sequence.timebase;
  const words = [];
  const sentences = [];
  let sentence = null;

  const flushSentence = () => {
    if (!sentence || !sentence.wordIndexes.length) { sentence = null; return; }
    const first = words[sentence.wordIndexes[0]];
    const last = words[sentence.wordIndexes[sentence.wordIndexes.length - 1]];
    sentence.startWord = first.index;
    sentence.endWord = last.index;
    sentence.startSec = first.startSec;
    sentence.endSec = last.endSec;
    sentence.text = joinTokens(sentence.wordIndexes.map((i) => words[i].text));
    sentences.push(sentence);
    sentence = null;
  };

  const ordered = [...(clipEntries || [])].sort((a, b) => a.clip.start.frame - b.clip.start.frame);
  for (let clipOrdinal = 0; clipOrdinal < ordered.length; clipOrdinal++) {
    const { clip } = ordered[clipOrdinal];
    const tokens = contentTokens(ordered[clipOrdinal].words);
    let prev = null;
    flushSentence(); // a sentence never crosses a Premiere clip/edit boundary

    for (let localIndex = 0; localIndex < tokens.length; localIndex++) {
      const token = tokens[localIndex];
      const srcStart = Math.max(clip.sourceIn.seconds, Number(token.start));
      const srcEnd = Math.min(clip.sourceOut.seconds, Number.isFinite(token.end) ? Number(token.end) : srcStart);
      if (!(srcEnd > srcStart)) continue;

      const speaker = token.speaker_id != null ? String(token.speaker_id) : null;
      const startsSentence = !sentence || (prev && (
        srcStart - prev.sourceOutSec >= sentenceGapSec ||
        (prev.speaker != null && speaker != null && prev.speaker !== speaker) ||
        SENTENCE_END.test(String(prev.text || "").trim())
      ));
      if (startsSentence && sentence) flushSentence();
      if (!sentence) {
        sentence = {
          index: sentences.length,
          clipKey: `${clipOrdinal}:${clip.id}`,
          wordIndexes: [],
          speaker,
        };
      }

      const mapped = sourceRangeToTimelineFrames(srcStart, srcEnd, clip, timebase);
      const word = {
        index: words.length,
        sentenceIndex: sentence.index,
        clipKey: `${clipOrdinal}:${clip.id}`,
        clipId: clip.id,
        clipSourceInSec: clip.sourceIn.seconds,
        clipSourceOutSec: clip.sourceOut.seconds,
        originalTimelineStartSec: clip.start.seconds,
        mediaPath: clip.mediaPath,
        trackType: clip.trackType,
        trackIndex: clip.trackIndex,
        sourceInSec: srcStart,
        sourceOutSec: srcEnd,
        startFrame: mapped ? mapped.startFrame : clip.start.frame,
        endFrame: mapped ? mapped.endFrame : clip.start.frame + 1,
        startSec: mapped ? mapped.startSeconds : clip.start.seconds,
        endSec: mapped ? mapped.endSeconds : clip.start.seconds,
        text: String(token.text || "").trim(),
        type: token.type || "word",
        speaker,
      };
      words.push(word);
      sentence.wordIndexes.push(word.index);
      prev = word;
    }
    flushSentence();
  }

  return { words, sentences };
}

/** Convert Classic's candidate decisions to precise, visible word spans. */
export function suggestionsFromSegments(segments, words) {
  const suggestions = [];
  for (const seg of segments || []) {
    if (seg.decision !== "cut" || seg.protected || !(seg.wordCount > 0)) continue;
    const matches = (words || []).filter((w) =>
      w.clipId === seg.clipId &&
      normPath(w.mediaPath) === normPath(seg.mediaPath) &&
      w.trackType === seg.trackType && w.trackIndex === seg.trackIndex &&
      w.sourceOutSec > seg.sourceInSec && w.sourceInSec < seg.sourceOutSec
    );
    if (!matches.length) continue;
    suggestions.push({
      id: suggestions.length,
      startWord: matches[0].index,
      endWord: matches[matches.length - 1].index,
      reason: seg.reason || (seg.fragment === "empty" ? "no speech" : "duplicate take"),
      group: Number.isInteger(seg.group) ? seg.group : null,
      accepted: true,
    });
  }
  return suggestions;
}

function selectedIndexes(ranges, wordCount) {
  const selected = new Set();
  for (const r of ranges || []) {
    let a = Math.max(0, Math.min(wordCount - 1, Number(r.startWord)));
    let b = Math.max(0, Math.min(wordCount - 1, Number(r.endWord)));
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    if (a > b) { const t = a; a = b; b = t; }
    for (let i = a; i <= b; i++) selected.add(i);
  }
  return selected;
}

function sourcePlans(words, ranges, padSec) {
  const selected = selectedIndexes(ranges, words.length);
  const ordered = [...selected].sort((a, b) => a - b);
  const plans = [];
  for (let p = 0; p < ordered.length;) {
    const first = words[ordered[p]];
    if (!first) { p++; continue; }
    let q = p;
    while (q + 1 < ordered.length) {
      const cur = words[ordered[q]], next = words[ordered[q + 1]];
      if (ordered[q + 1] !== ordered[q] + 1 || !cur || !next || cur.clipKey !== next.clipKey) break;
      q++;
    }
    const last = words[ordered[q]];
    const prev = words[first.index - 1];
    const next = words[last.index + 1];
    const prevKept = prev && prev.clipKey === first.clipKey && !selected.has(prev.index) ? prev : null;
    const nextKept = next && next.clipKey === last.clipKey && !selected.has(next.index) ? next : null;

    // Put edit points in the air between removed and kept speech. When the gap is
    // wide, reserve padSec next to the kept word; when it is tight, use its midpoint.
    const startGapLo = prevKept ? prevKept.sourceOutSec : first.clipSourceInSec;
    const startGapHi = first.sourceInSec;
    let start = startGapHi;
    if (startGapHi > startGapLo) {
      start = startGapHi - startGapLo >= padSec * 2 ? startGapLo + padSec : (startGapLo + startGapHi) / 2;
    }
    const endGapLo = last.sourceOutSec;
    const endGapHi = nextKept ? nextKept.sourceInSec : last.clipSourceOutSec;
    let end = endGapLo;
    if (endGapHi > endGapLo) {
      end = endGapHi - endGapLo >= padSec * 2 ? endGapHi - padSec : (endGapLo + endGapHi) / 2;
    }
    if (end > start) plans.push({
      startWord: first.index,
      endWord: last.index,
      startSourceSec: start,
      endSourceSec: end,
      clipKey: first.clipKey,
      mediaPath: first.mediaPath,
      trackType: first.trackType,
      trackIndex: first.trackIndex,
      originalTimelineStartSec: first.originalTimelineStartSec,
    });
    p = q + 1;
  }
  return plans;
}

function matchingClips(plan, timeline) {
  return timeline.clips.filter((c) =>
    c.hasMedia && c.speedIsNormal && normPath(c.mediaPath) === normPath(plan.mediaPath) &&
    c.trackType === plan.trackType && c.trackIndex === plan.trackIndex &&
    Math.min(plan.endSourceSec, c.sourceOut.seconds) > Math.max(plan.startSourceSec, c.sourceIn.seconds)
  );
}

/**
 * Pure planner used by Apply. It takes a fresh normalized timeline, maps every
 * selected source span through integer Premiere ticks, and returns merged-engine
 * input. A range split by an existing edit is emitted as separate frame spans.
 */
export function planSafeWordCuts(words, ranges, timeline, opts = {}) {
  const padSec = Number.isFinite(opts.padSec) ? opts.padSec : 0.08;
  const timebase = timeline.sequence.timebase;
  const frames = [];
  const plans = sourcePlans(words || [], ranges || [], padSec);
  let alreadyGone = 0;

  for (const plan of plans) {
    const candidates = matchingClips(plan, timeline);
    if (!candidates.length) { alreadyGone++; continue; }
    // Normally one live clip covers the range. If a prior razor split it, keep the
    // closest occurrence then include only source-adjacent pieces of that occurrence.
    candidates.sort((a, b) => {
      const aExpected = Math.abs(a.start.seconds - plan.originalTimelineStartSec);
      const bExpected = Math.abs(b.start.seconds - plan.originalTimelineStartSec);
      return aExpected - bExpected || a.start.seconds - b.start.seconds;
    });
    const chosen = [candidates[0]];
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      const touches = chosen.some((x) =>
        Math.abs(x.sourceOut.seconds - c.sourceIn.seconds) < 0.05 ||
        Math.abs(c.sourceOut.seconds - x.sourceIn.seconds) < 0.05
      );
      if (touches) chosen.push(c);
    }
    for (const clip of chosen) {
      const mapped = sourceRangeToTimelineFrames(plan.startSourceSec, plan.endSourceSec, clip, timebase);
      if (mapped && mapped.endFrame > mapped.startFrame) {
        if (opts.protectKeptSpeech) {
          const first = words[plan.startWord], last = words[plan.endWord];
          const prev = words[plan.startWord - 1], next = words[plan.endWord + 1];
          const tb = BigInt(timebase);
          const tick = sec => {
            // A clipped token at an exact clip edge must use the original tick,
            // not a float-seconds round trip that can produce a one-tick error.
            if (sec === clip.sourceIn.seconds) return BigInt(clip.start.ticks);
            if (sec === clip.sourceOut.seconds) return BigInt(clip.end.ticks);
            return BigInt(sourceSecToTimeline(sec, clip, timebase).ticks);
          };
          const floor = n => Number(n >= 0n ? n / tb : -((-n + tb - 1n) / tb));
          const ceil = n => -floor(-n);
          const lo = prev && prev.clipKey === first.clipKey ? Math.max(clip.sourceIn.seconds, prev.sourceOutSec) : clip.sourceIn.seconds;
          const hi = next && next.clipKey === last.clipKey ? Math.min(clip.sourceOut.seconds, next.sourceInSec) : clip.sourceOut.seconds;
          const minStart = ceil(tick(lo)), maxStart = ceil(tick(first.sourceInSec));
          const minEnd = floor(tick(last.sourceOutSec)), maxEnd = floor(tick(hi));
          // Adjacent ASR words often share a fractional-frame timestamp. Preserve
          // retained speech by snapping INWARD into discarded speech by <1 frame.
          // Requiring both full discarded-word coverage and no retained-word overlap
          // makes every shared non-frame boundary impossible. Larger overlaps still defer.
          if (minStart > maxStart || minEnd > maxEnd) continue;
          mapped.startFrame = Math.max(minStart, Math.min(maxStart, mapped.startFrame));
          mapped.endFrame = Math.max(minEnd, Math.min(maxEnd, mapped.endFrame));
          if (mapped.endFrame <= mapped.startFrame) continue;
          mapped.inwardSnap = mapped.startFrame > floor(tick(first.sourceInSec)) || mapped.endFrame < ceil(tick(last.sourceOutSec));
        }
        frames.push({ startFrame: mapped.startFrame, endFrame: mapped.endFrame, startWord: plan.startWord, endWord: plan.endWord,
          ...(mapped.inwardSnap ? { inwardSnap: true } : {}) });
      }
    }
  }
  frames.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  return { frames, plans, alreadyGone };
}

function bestLiveClip(word, timeline) {
  const candidates = timeline.clips.filter((c) =>
    c.hasMedia && normPath(c.mediaPath) === normPath(word.mediaPath) &&
    c.trackType === word.trackType && c.trackIndex === word.trackIndex &&
    Math.min(word.sourceOutSec, c.sourceOut.seconds) > Math.max(word.sourceInSec, c.sourceIn.seconds)
  );
  candidates.sort((a, b) => {
    const ao = Math.min(word.sourceOutSec, a.sourceOut.seconds) - Math.max(word.sourceInSec, a.sourceIn.seconds);
    const bo = Math.min(word.sourceOutSec, b.sourceOut.seconds) - Math.max(word.sourceInSec, b.sourceIn.seconds);
    return bo - ao || Math.abs(a.start.seconds - word.originalTimelineStartSec) - Math.abs(b.start.seconds - word.originalTimelineStartSec);
  });
  return candidates[0] || null;
}

export async function reconcileRetakeV2(ctx, timeline = null) {
  if (!ctx.review || !Array.isArray(ctx.review.words)) throw new Error("No Retake V2 transcript loaded yet.");
  if (!timeline) timeline = await getTimeline(ctx);
  const timebase = timeline.sequence.timebase;
  const map = ctx.review.words.map((word) => {
    const clip = bestLiveClip(word, timeline);
    if (!clip) return { index: word.index, state: "absent", liveStartSec: null, liveEndSec: null };
    const mapped = sourceRangeToTimelineFrames(word.sourceInSec, word.sourceOutSec, clip, timebase);
    if (!mapped) return { index: word.index, state: "absent", liveStartSec: null, liveEndSec: null };
    const fully = word.sourceInSec >= clip.sourceIn.seconds - 0.02 && word.sourceOutSec <= clip.sourceOut.seconds + 0.02;
    return {
      index: word.index,
      state: fully ? "present" : "partial",
      liveStartSec: round3(mapped.startSeconds),
      liveEndSec: round3(mapped.endSeconds),
      liveStartFrame: mapped.startFrame,
      liveEndFrame: mapped.endFrame,
    };
  });
  return { map, revision: ctx.state.revision, frameRate: timeline.sequence.frameRate };
}

export async function applyRetakeV2(ctx, ranges, { removeGaps = true, chunkSize } = {}, onProgress = () => {}) {
  if (!ctx.review || !Array.isArray(ctx.review.words)) throw new Error("No Retake V2 transcript loaded yet.");
  const timeline = await getTimeline(ctx); // fresh live geometry immediately before planning
  if (ctx.review.timelineFingerprint && ctx.review.timelineFingerprint !== timelineFingerprint(timeline)) {
    throw new Error("Timeline changed since the transcript was loaded. Reload before applying word cuts.");
  }
  const planned = planSafeWordCuts(ctx.review.words, ranges, timeline, { protectKeptSpeech: ctx.review.reliableTiming === true });
  if (!planned.frames.length) {
    return { applied: 0, requested: 0, alreadyGone: planned.alreadyGone, appliedSec: 0, undoable: false, revision: ctx.state.revision };
  }
  const res = await applyRangesBatched(ctx, planned.frames, {
    ripple: removeGaps === true,
    fps: timeline.sequence.frameRate || ctx.review.frameRate || 30,
    chunkSize,
    onProgress,
  });
  if (res.applied > 0) {
    captureUndo(ctx, "retake-v2", timeline, { ripple: removeGaps === true, applied: res.applied, markerMoves: res.markerMoves });
    ctx.state.revision += 1;
  }
  return { ...res, alreadyGone: planned.alreadyGone, undoable: res.applied > 0, revision: ctx.state.revision };
}
