import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReview } from '../review.js';
import { getTimeline, callHostHealing } from '../tools/util.js';
import { planSafeWordCuts } from '../retake-v2.js';
import { checkAcousticBoundaries } from './acoustic-boundaries.js';
import { planReviewMarkers, REVIEW_SENTINEL } from './review-markers.js';
import { analyzeReliableRetakes, verifyFinalRetakePlan } from './reliable.js';
import { findMicroRestarts } from './stutters.js';
import { analyzeRetakesV3 } from './judge.js';
import { liveEnv } from '../config.js';
import { geometry, expectedGeometry, requireSimpleTimeline, timelineFingerprint } from './timeline-safety.js';

const ENGINE_SOURCES = {
  reliable: readFileSync(new URL('./reliable.js', import.meta.url), 'utf8'),
  v3: readFileSync(new URL('./judge.js', import.meta.url), 'utf8'),
};
/** v3 (default): windowed single-pass judge, code checks. reliable: the multi-call chain. */
export function retakeEngine(params = {}) {
  const e = String(params.engine || liveEnv('EDITAGENT_RETAKE_ENGINE') || 'v3').toLowerCase();
  return e === 'reliable' ? 'reliable' : 'v3';
}

function mergeFrames(ranges) {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.startFrame - b.startFrame)) {
    const last = out[out.length - 1];
    if (last && r.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, r.endFrame);
    else out.push({ startFrame: r.startFrame, endFrame: r.endFrame });
  }
  return out;
}

const normWord = w => String(w?.text || '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Restarts repeat words ("I watch men, I watch people"), so a cut can often slide by a
 * word or two and leave IDENTICAL kept text. Pick the equivalent position whose edges
 * sit in the widest pauses: "watch men, I" cuts mid-phrase, "I watch men," cuts in two
 * real pauses. Never moves onto replacements, protected words or other cuts.
 */
export function shiftCutsToPauses(words, suggestions, protectedWords = [], maxShift = 4) {
  // A clip edge or the start/end of the recording counts as an ideal pause.
  const gap = (a, b) => (a && b && a.clipKey === b.clipKey) ? b.sourceInSec - a.sourceOutSec : Infinity;
  const score = (a, b) => Math.min(gap(words[a - 1], words[a]), gap(words[b], words[b + 1]));
  const blocked = new Set(protectedWords);
  return suggestions.map(s => {
    const others = suggestions.filter(o => o !== s);
    const busy = i => blocked.has(i) || (s.replacements || []).some(r => i >= r.startWord && i <= r.endWord) ||
      others.some(o => i >= o.startWord && i <= o.endWord);
    const sameText = (i, j) => words[i] && words[j] && words[i].type !== 'audio_event' && normWord(words[i]) && normWord(words[i]) === normWord(words[j]) && words[i].clipKey === words[j].clipKey;
    let best = { a: s.startWord, b: s.endWord, v: score(s.startWord, s.endWord) };
    for (const dir of [-1, 1]) {
      let a = s.startWord, b = s.endWord;
      for (let k = 0; k < maxShift; k++) {
        // Left: drop word a-1 instead of word b. Right: drop word b+1 instead of word a.
        if (dir < 0 ? !sameText(a - 1, b) || busy(a - 1) : !sameText(a, b + 1) || busy(b + 1)) break;
        a += dir; b += dir;
        const v = score(a, b);
        if (v > best.v + 0.03) best = { a, b, v };
      }
    }
    if (best.a === s.startWord) return s;
    return { ...s, startWord: best.a, endWord: best.b, shiftedFrom: [s.startWord, s.endWord] };
  });
}

/** Exclude unsafe timing even if semantic verification approved it. */
export function filterTimedSuggestions(words, suggestions, timeline) {
  const safe = [], deferred = [];
  for (const s of suggestions) {
    const selected = words.slice(s.startWord, s.endWord + 1);
    let reason = '';
    if (!selected.length || selected.some(w => !Number.isFinite(w.sourceInSec) || !(w.sourceOutSec > w.sourceInSec))) reason = 'Missing word timing.';
    else if (selected.some(w => w.clipKey !== selected[0].clipKey)) reason = 'Cross-clip cut requires review.';
    else if (selected.some((w, i) => i && w.sourceInSec < selected[i - 1].sourceOutSec)) reason = 'Overlapping word timings require listening.';
    const planned = reason ? null : planSafeWordCuts(words, [s], timeline, { protectKeptSpeech: true });
    if (!reason && (planned.frames.length !== 1 || planned.alreadyGone)) reason = 'No safe frame-aligned gap, or source occurrence is ambiguous. Review this boundary.';
    if (!reason) {
      const p = planned.plans[0];
      const occurrences = timeline.clips.filter(c => c.trackType === p.trackType && c.trackIndex === p.trackIndex && c.mediaPath === p.mediaPath && c.sourceIn.seconds < p.endSourceSec && c.sourceOut.seconds > p.startSourceSec);
      if (occurrences.length !== 1) reason = 'Repeated source occurrence requires review.';
      else {
        const f = planned.frames[0], fps = 254016000000 / Number(timeline.sequence.timebase);
        const prev = words[s.startWord - 1], next = words[s.endWord + 1];
        // Snapping must not cross retained speech. All times refer to the captured timeline.
        if ((prev?.clipKey === selected[0].clipKey && f.startFrame / fps < prev.endSec) ||
            (next?.clipKey === selected[0].clipKey && f.endFrame / fps > next.startSec)) reason = 'Frame boundary would intrude on retained speech.';
      }
    }
    if (reason) deferred.push({ ...s, reason, boundaryDetails: {
      timebaseTicks: timeline.sequence.timebase,
      selectedStart: selected[0]?.sourceInSec, selectedEnd: selected[selected.length - 1]?.sourceOutSec,
      previousWordEnd: words[s.startWord - 1]?.sourceOutSec,
      nextWordStart: words[s.endWord + 1]?.sourceInSec,
      sourcePlans: planned?.plans, mappedFrames: planned?.frames,
    } });
    else safe.push({ ...s, frames: planned.frames, ...(planned.frames.some(f => f.inwardSnap) ? {
      boundaryNote: 'Snapped inward by less than one video frame at an edge to preserve retained speech. Listen to the join.',
    } : {}) });
  }
  return { suggestions: safe, deferred };
}

export async function runReliableSession(ctx, params, progress, token, deps = {}) {
  const readTimeline = deps.readTimeline || getTimeline;
  const load = deps.load || buildReview;
  const engine = retakeEngine(params);
  const analyze = deps.analyze || (engine === 'v3' ? analyzeRetakesV3 : analyzeReliableRetakes);
  // V3 replaces the per-bundle Claude re-check with deterministic evidence checks.
  const verify = deps.verify || (engine === 'v3' ? async (_w, s) => ({ suggestions: s, deferred: [], calls: 0 }) : verifyFinalRetakePlan);
  const acoustic = deps.acoustic || checkAcousticBoundaries;
  const host = deps.host || callHostHealing;
  const checkCancel = () => { if (token?.aborted) throw new Error('Cancelled'); };
  const before = await readTimeline(ctx);
  let unsupported = null;
  try { requireSimpleTimeline(before); } catch (e) { unsupported = e.message; }
  const fingerprint = timelineFingerprint(before);
  let review = ctx.review;
  if (params.reviewId && params.reviewId !== review?.reviewId) throw new Error('Transcript changed. Reload before analyzing.');
  if (review && review.timelineFingerprint !== fingerprint) {
    if (params.reviewId) throw new Error('Timeline changed since Load. Reload before analyzing.');
    review = null;
  }
  if (unsupported && params.auto_apply === true) {
    // Unsupported layouts still get a review-only duplicate, even when their
    // media cannot be transcribed (nests, generators, retimed sources).
    review = { reviewId: 'layout-review-' + randomUUID(), timelineFingerprint: fingerprint, words: [], sentences: [] };
    ctx.review = review;
  } else if (!review?.words?.length) review = await load(ctx, { transcribeModel: params.transcribe_model }, progress);
  checkCancel();
  if (timelineFingerprint(await readTimeline(ctx)) !== fingerprint) throw new Error('Timeline changed during transcription. Reload and retry.');
  const protectedWords = unsupported && params.auto_apply === true ? [] : params.protectedWords || [];
  if (!Array.isArray(protectedWords) || protectedWords.some(i => !Number.isInteger(i) || !review.words[i])) throw new Error('Invalid protected word references.');
  const runId = randomUUID(), model = params.word_model || 'sonnet', effort = params.word_effort || 'medium';
  const diagnostic = { version: 'reliable-retakes-7-review-markers', engine, runId, takePolicy: 'last_take',
    startedAt: new Date().toISOString(), reviewId: review.reviewId, model, wordCount: review.words.length, events: [] };
  const ledger = { runId, version: diagnostic.version, startedAt: diagnostic.startedAt, status: 'analyzing',
    sequenceId: before.sequence.id, sequenceName: before.sequence.name, originalGeometry: geometry(before), timebase: before.sequence.timebase, fingerprint, model, takePolicy: 'last_take', operations: [] };
  const atomicJson = (file, data) => {
    writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  };
  const persist = () => {
    if (!ctx.cacheDir) return;
    const dir = join(ctx.cacheDir, 'retake-runs'); mkdirSync(dir, { recursive: true });
    atomicJson(join(dir, runId + '.json'), ledger);
  };
  const recordDiagnostic = event => {
    diagnostic.events.push(JSON.parse(JSON.stringify(event)));
    if (diagnostic.events.length > 40) diagnostic.events.shift();
    if (!ctx.cacheDir) return;
    try {
      const dir = join(ctx.cacheDir, 'retake-diagnostics'); mkdirSync(dir, { recursive: true });
      atomicJson(join(dir, 'latest.json'), diagnostic);
    } catch { /* diagnostics do not authorize an edit */ }
  };
  recordDiagnostic({ stage: 'started' });
  const settings = { model, effort, token, protectedWords, onProgress: progress, onDiagnostic: recordDiagnostic };
  let result;
  try {
    // Semantic results can be reused after a boundary-only change. A prompt/code,
    // transcript, model, protected-word or source geometry change invalidates them.
    const cacheKey = createHash('sha256').update(JSON.stringify({ fingerprint, model, effort,
      protectedWords: [...protectedWords].sort((a,b) => a-b), words: review.words,
      engine, engineSource: ENGINE_SOURCES[engine], windowMin: liveEnv('EDITAGENT_RETAKE_WINDOW_MIN') || '', overlapMin: liveEnv('EDITAGENT_RETAKE_OVERLAP_MIN') || '', chunkPause: liveEnv('EDITAGENT_RETAKE_CHUNK_PAUSE') || '' })).digest('hex');
    ledger.semanticCacheKey = cacheKey;
    let cacheFile;
    if (ctx.cacheDir) {
      const dir = join(ctx.cacheDir, 'retake-plans'); mkdirSync(dir, { recursive: true });
      cacheFile = join(dir, cacheKey + '.json');
      try { result = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }
    }
    const reused = !!(result && Array.isArray(result.suggestions) && Array.isArray(result.deferred) && result.stats);
    if (!reused) {
      result = await analyze(review.words, review.sentences, settings);
      if (cacheFile) atomicJson(cacheFile, result);
    } else { progress('Reusing unchanged AI decisions; checking timing and the final plan…'); }
    result.stats = { ...result.stats, semanticCalls: reused ? 0 : result.stats.calls, reusedSemanticPlan: reused };
    checkCancel();
    if (ctx.review !== review || timelineFingerprint(await readTimeline(ctx)) !== fingerprint) throw new Error('Timeline changed during analysis. No cuts applied.');
    review.reliableTiming = true;
    // Free deterministic pass for micro-restarts Claude may skip. Never overlaps an AI
    // cut, a review span or a protected word; the final-plan check still reviews each one.
    const covered = [...result.suggestions, ...result.deferred].filter(t => Number.isInteger(t.startWord));
    const stutters = findMicroRestarts(review.words).filter(st =>
      !covered.some(t => st.startWord <= t.endWord && t.startWord <= st.endWord + 2) &&
      !protectedWords.some(i => i >= st.startWord && i <= st.endWord + 2));
    for (const st of stutters) {
      // Numeric: the verification schema only carries integer group ids.
      const id = 100000 + st.startWord;
      result.suggestions.push({ ...st, group: id, bundleId: id, eventGroup: id, accepted: true, state: 'AUTO_CUT', id: result.suggestions.length,
        contextStartWord: Math.max(0, st.startWord - 40), contextEndWord: Math.min(review.words.length - 1, st.endWord + 40) });
    }
    if (stutters.length) recordDiagnostic({ stage: 'stutters', found: stutters });
    const shifted = shiftCutsToPauses(review.words, result.suggestions, protectedWords);
    const timed = filterTimedSuggestions(review.words, shifted, before);
    result.deferred.push(...timed.deferred);
    let eligible = timed.suggestions;
    const failedBundles = new Set(timed.deferred.map(d => d.bundleId));
    const audioCache = new Map();
    // Back-to-back cuts (take 1, take 2, take 3) share an edge that disappears once both
    // are cut, so that edge is not checked, unless the neighbor itself ends up retained.
    const touches = (a, b) => a.endWord + 1 === b.startWord && review.words[a.endWord]?.clipKey === review.words[b.startWord]?.clipKey;
    const skipFor = s => ({
      start: eligible.some(o => o !== s && !failedBundles.has(o.bundleId) && touches(o, s)),
      end: eligible.some(o => o !== s && !failedBundles.has(o.bundleId) && touches(s, o)),
    });
    const skipped = new Map();
    const runCheck = async (s, n) => {
      const skip = skipFor(s);
      progress(`Checking source audio boundaries ${n}/${eligible.length}…`);
      const checked = await acoustic(s, review.words, before, token, audioCache, skip);
      recordDiagnostic({ stage: 'acoustic_boundary', id: s.id, skip, result: checked });
      if (!checked.ok) { failedBundles.add(s.bundleId); result.deferred.push({ ...s, reason: checked.reason, category: 'Audio boundary' }); skipped.delete(s); }
      else { s.acousticEvidence = checked; if (skip.start || skip.end) skipped.set(s, skip); else skipped.delete(s); }
    };
    let n = 0;
    for (const s of (unsupported ? [] : eligible)) {
      checkCancel();
      if (failedBundles.has(s.bundleId)) continue;
      await runCheck(s, ++n);
    }
    // A skipped edge whose neighbor failed now borders retained speech: check it for real.
    for (let pass = 0; pass < 4; pass++) {
      const redo = [...skipped.entries()].filter(([s, skip]) => !failedBundles.has(s.bundleId) &&
        ((skip.start && !skipFor(s).start) || (skip.end && !skipFor(s).end))).map(([s]) => s);
      if (!redo.length) break;
      for (const s of redo) { checkCancel(); await runCheck(s, ++n); }
    }
    // Frame rounding can leave a 1-frame sliver between two back-to-back cuts; join them.
    for (const a of eligible) for (const b of eligible) {
      if (a === b || failedBundles.has(a.bundleId) || failedBundles.has(b.bundleId) || !touches(a, b)) continue;
      const fa = a.frames?.[a.frames.length - 1], fb = b.frames?.[0];
      if (fa && fb && fa.endFrame < fb.startFrame) fa.endFrame = fb.startFrame;
    }
    eligible = eligible.filter(s => {
      if (!failedBundles.has(s.bundleId)) return true;
      result.deferred.push({ ...s, reason: 'A dependent cut in this edit needs boundary review; the whole edit is retained.', category: 'Dependent edit' });
      return false;
    });
    if (unsupported) {
      for (const s of eligible) result.deferred.push({ ...s, reason: unsupported, category: 'Timeline layout' });
      eligible = [];
      for (const c of before.clips.filter(c => c.trackType === 'video' || !before.clips.some(v => v.trackType === 'video'))) result.deferred.push({ startSec: c.start.seconds, endSec: c.end.seconds, reason: unsupported, category: 'Timeline layout' });
    }
    // All timing-rejected bundles have now been removed. Verify the ACTUAL plan.
    const checked = eligible.length ? await verify(review.words, eligible, settings) : { suggestions: [], deferred: [], calls: 0 };
    eligible = checked.suggestions; result.deferred.push(...checked.deferred);
    result.stats.calls = result.stats.semanticCalls + checked.calls;
    if (ctx.review !== review || timelineFingerprint(await readTimeline(ctx)) !== fingerprint) throw new Error('Timeline changed before final planning. No cuts applied.');
    // Freeze exactly the acoustically checked frames; no later replanning can change them.
    const frames = mergeFrames(eligible.flatMap(s => s.frames));
    const selected = new Set();
    for (const r of eligible) for (let i = r.startWord; i <= r.endWord; i++) selected.add(i);
    const fps = 254016000000 / Number(before.sequence.timebase);
    if (review.words.some(w => !selected.has(w.index) && frames.some(r => r.startFrame / fps < w.endSec && r.endFrame / fps > w.startSec))) {
      for (const s of eligible) result.deferred.push({ ...s, reason: 'Combined frame plan touches retained speech.', category: 'Final plan' });
      eligible = []; frames.length = 0;
    }
    // Detector stutters that could not be cut cleanly stay as low-confidence markers.
    for (const d of result.deferred) if (Number(d.group) >= 100000) d.confidence = 'low';
    // Merge duplicate review spans, retaining all distinct reasons.
    const reviewMap = new Map();
    for (const d of result.deferred) {
      const key = JSON.stringify([d.startWord, d.endWord, d.startSec, d.endSec]);
      const prior = reviewMap.get(key);
      if (prior) { if (!prior.reason.includes(d.reason)) prior.reason += ' | ' + d.reason; }
      else reviewMap.set(key, { ...d, state: 'REVIEW', accepted: false });
    }
    result.deferred = [...reviewMap.values()];
    result.suggestions = eligible.map(s => ({ ...s, state: 'AUTO_CUT' }));
    result.stats.suggestions = eligible.length; result.stats.deferred = result.deferred.length;
    result.stats.durationMs = Date.now() - Date.parse(diagnostic.startedAt);
    const states = review.words.map(w => ({ index: w.index, state: unsupported ? 'REVIEW' : selected.has(w.index) && eligible.length ? 'AUTO_CUT' : 'KEEP' }));
    for (const d of result.deferred) for (let i = d.startWord; Number.isInteger(i) && i <= d.endWord && i < states.length; i++) states[i].state = 'REVIEW';
    const response = { runId, reviewId: review.reviewId, words: review.words, sentences: review.sentences,
      suggestions: result.suggestions, deferred: result.deferred, states, engine: { mode: engine, ...result.stats } };
    ledger.status = 'planned'; ledger.suggestions = result.suggestions; ledger.deferred = result.deferred; ledger.frames = frames;
    persist(); recordDiagnostic({ stage: 'plan_frozen', frames, suggestions: result.suggestions, deferred: result.deferred });
    if (params.auto_apply !== true || (!frames.length && !result.deferred.length)) return response;

    checkCancel();
    progress('Creating the edited/review sequence…');
    ledger.operations.push({ action: 'duplicateRetakeSequence', status: 'pending' }); persist();
    const duplicate = await host(ctx, 'duplicateRetakeSequence', { expectedSequenceId: before.sequence.id });
    if (!duplicate?.sequenceId || duplicate.sequenceId === before.sequence.id) throw new Error('Could not identify the duplicate. No cuts attempted.');
    ledger.duplicate = duplicate; ledger.status = 'applying'; persist();
    const copy = await readTimeline(ctx);
    if (frames.length) requireSimpleTimeline(copy);
    if (copy.sequence.id !== duplicate.sequenceId || copy.sequence.timebase !== before.sequence.timebase || JSON.stringify(geometry(copy)) !== JSON.stringify(geometry(before))) throw new Error('Duplicate did not match. No cuts attempted.');
    ledger.operations[ledger.operations.length - 1].status = 'verified'; persist();
    ctx.state.revision++; ctx.undo = null; ctx.review = null;
    const expectedId = duplicate.sequenceId;
    let applied = 0, geometryVerified = false;
    try {
      for (let i = 0; i < frames.length; i += 50) {
        checkCancel();
        const batch = frames.slice(i, i + 50);
        ledger.operations.push({ action: 'removeRangesBatch', ranges: batch, status: 'pending' }); persist();
        progress(`Applying eligible cuts ${i + 1}–${Math.min(i + 50, frames.length)}/${frames.length}…`);
        const res = await host(ctx, 'removeRangesBatch', { ranges: batch, expectedSequenceId: expectedId, expectedTimebase: before.sequence.timebase,
          expectedGeometry: expectedGeometry(before, frames.slice(0, i), false) });
        if (res?.failed || res?.straddling || !Array.isArray(res?.removedIndexes) || new Set(res.removedIndexes).size !== batch.length || batch.some((_, k) => !res.removedIndexes.includes(k))) throw new Error('Premiere did not confirm every deletion.');
        const afterBatch = await readTimeline(ctx);
        if (afterBatch.sequence.id !== expectedId || JSON.stringify(geometry(afterBatch)) !== JSON.stringify(expectedGeometry(before, frames.slice(0, i + batch.length), false))) throw new Error('Cut geometry or audio/video synchronization did not match.');
        applied += batch.length;
        ledger.operations[ledger.operations.length - 1].status = 'verified'; persist();
      }
      checkCancel();
      if (frames.length) {
        ledger.operations.push({ action: 'closeRangeGaps', status: 'pending' }); persist();
        progress('Closing gaps and verifying the resulting sequence…');
        const closed = await host(ctx, 'closeRangeGaps', { ranges: frames, expectedSequenceId: expectedId, expectedTimebase: before.sequence.timebase,
          expectedGeometry: expectedGeometry(before, frames, false) });
        if (closed?.ok !== true || closed.failed || closed.misaligned) throw new Error('Premiere could not close every gap.');
      }
      const after = await readTimeline(ctx);
      if (after.sequence.id !== expectedId || JSON.stringify(geometry(after)) !== JSON.stringify(frames.length ? expectedGeometry(before, frames, true) : geometry(before))) throw new Error('Final timeline geometry or synchronization did not match.');
      geometryVerified = true;
      if (frames.length) { ledger.operations[ledger.operations.length - 1].status = 'verified'; persist(); }
      checkCancel();
      const markers = planReviewMarkers(result.deferred, review.words, before, frames);
      if (markers.length > 2000) throw new Error('Review marker count exceeds the supported limit; see the saved run plan.');
      ledger.markers = markers; ledger.operations.push({ action: 'applyReviewMarkers', status: 'pending' }); persist();
      progress(`Placing ${markers.length} review marker(s) at final timeline positions…`);
      const marked = await host(ctx, 'applyReviewMarkers', { markers, sentinel: REVIEW_SENTINEL,
        expectedSequenceId: expectedId, expectedTimebase: before.sequence.timebase, expectedGeometry: geometry(after) });
      if (marked?.verified !== true || marked.created !== markers.length) throw new Error('Premiere did not verify every review marker.');
      ledger.operations[ledger.operations.length - 1].status = 'verified';
      response.applied = { verified: true, ranges: applied, markers: marked.created, sequence: duplicate.name,
        originalSequence: before.sequence.name, geometryVerified: true };
      response.reviewMarkers = markers.map(m => ({ startSec: m.startSec, endSec: m.endSec, name: m.name, comment: m.comment }));
      ledger.status = 'complete'; ledger.applied = response.applied; persist();
      recordDiagnostic({ stage: 'apply_complete', result: response.applied });
    } catch (err) {
      response.applied = { verified: false, partial: true, ranges: applied, geometryVerified,
        sequence: duplicate.name, originalSequence: before.sequence.name,
        error: `${err.message} Stopped on the duplicate; the original sequence is unchanged. Run ${runId}.` };
      ledger.status = token?.aborted ? 'cancelled_partial' : 'failed_partial'; ledger.applied = response.applied;
      try { persist(); } catch { /* the pending entry already records uncertainty */ }
      recordDiagnostic({ stage: 'apply_incomplete', result: response.applied });
    }
    return response;
  } catch (error) {
    ledger.status = token?.aborted ? 'cancelled' : 'failed'; ledger.error = error.message;
    try { persist(); } catch { /* no further mutation after a ledger failure */ }
    recordDiagnostic({ stage: 'failed', error: error.message });
    throw error;
  }
}
