// Deterministic retake detection: find re-recorded takes WITHOUT an LLM.
//
// Why this exists: the current path (server/ai.js analyzeRetakes) sends every
// speech segment of the timeline to `claude -p` in ~12-25 chunked calls at high
// effort. On a 30-60 min raw recording that is 10-20 minutes of wall clock and
// tens of thousands of reasoning tokens, to answer a question that is mostly
// string matching: the speaker restarted the same line, so cut every pass but
// the last usable one.
//
// This module answers that part in milliseconds with zero tokens, and reports
// WHICH groups it is unsure about so the LLM can be spent only on those.
//
// Pure functions only (no ctx, no I/O) so they unit-test and eval offline:
//   server/test/eval/evalDetect.mjs scores this against the same human-labeled
//   412-segment fixture the LLM path is scored on.

/* ------------------------------- tokenizing ------------------------------- */

// Function words carry no evidence that two takes are the same line, so the
// similarity test ignores them (otherwise "and so it is the" matches everything).
const STOP = new Set(
  ("a an the and or but so is are was were it its this that these those i you we they of to in on " +
   "for with as at by be been do does did not no now just really actually here there my your our").split(" ")
);

/**
 * Normalize one segment's text for comparison.
 *  - parentheticals ("(clears throat)") are transcription annotations, not speech
 *  - `truncated`: the take was cut off mid-line ("...this loop t-", "head over...")
 *  - `terminal`:  the take ends as a finished sentence
 */
export function tokenize(text) {
  const stripped = String(text || "").replace(/\([^)]*\)/g, " ");
  const t = stripped.trim();
  const truncated = /-\s*$/.test(t) || /\.\.\.\s*$/.test(t);
  const terminal = !truncated && /[.?!]["'”’)\]]*\s*$/.test(t);
  const toks = stripped
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter(Boolean);
  return { toks, truncated, terminal };
}

/* ------------------------------- similarity ------------------------------- */

/**
 * Longest common PREFIX of two token arrays. If `aTruncated`, a's final token may
 * be a cut-off word ("autonomin" -> "autonomously") and still counts.
 * This is the primary retake signal: a restart re-says the same opening words.
 */
function sharedStem(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export function commonPrefix(a, b, aTruncated) {
  let i = 0;
  while (i < a.length && i < b.length) {
    if (a[i] === b[i]) { i++; continue; }
    // a's final word may be cut off mid-utterance, and the speaker may even have
    // changed the word ("autonomin-" -> "autonomously"): accept a shared stem.
    if (i === a.length - 1 && aTruncated && sharedStem(a[i], b[i]) >= 4) i++;
    break;
  }
  return i;
}

function lcsLen(a, b) {
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    const t = prev; prev = cur; cur = t; cur.fill(0);
  }
  return prev[n];
}

/**
 * Fraction of the shorter take's content words that also appear, in order, in the
 * longer one. Catches a re-take that reworded its opening ("But ultimately, here's
 * the idea..." -> "But this is the idea...") which a prefix test alone misses.
 */
export function overlapRatio(aToks, bToks) {
  const a = aToks.filter((t) => !STOP.has(t));
  const b = bToks.filter((t) => !STOP.has(t));
  const min = Math.min(a.length, b.length);
  if (min < 3) return 0;
  return lcsLen(a, b) / min;
}

/**
 * How much a single segment stutters over itself ("and just, just, and just this
 * loop"). A repeated bigram inside one segment means the speaker restarted
 * mid-line, so the segment is not a clean take even though it may be long.
 */
export function selfRepeat(toks) {
  if (toks.length < 6) return 0;
  const seen = new Set();
  let dup = 0, total = 0;
  for (let i = 0; i < toks.length - 1; i++) {
    const bg = `${toks[i]} ${toks[i + 1]}`;
    total++;
    if (seen.has(bg)) dup++; else seen.add(bg);
  }
  return total ? dup / total : 0;
}

/* --------------------------------- config --------------------------------- */

export const DEFAULTS = {
  head: 3,          // shared leading words that mean "same line, restarted"
  sim: 0.7,         // LCS-over-shorter that means the same, when the head was reworded
  lookback: 14,     // how many earlier segments a take can restart (a long stutter run)
  windowSec: 180,   // and how far back in time; beyond this it is a different beat
  fragNeighbors: 4,   // how many segments each side count as "right next to" a fragment
  fragSec: 20,        // and how many seconds
  stutter: 0.25,    // selfRepeat at or above this = the take is not clean
  shortWords: 6,    // no terminal punctuation and this short = not a finished line
};

// Fast mode is intentionally much stricter than the general detector. These
// bounds keep a match local, while the word minimums avoid treating short stock
// phrases ("thank you", "so the first thing") as proof of a retake.
export const CERTAIN_DEFAULTS = {
  certainLookback: 18,
  certainWindowSec: 180,
  certainPrefixWords: 3,
  certainDuplicateWords: 4,
  certainSimilarity: 0.85,
  certainLengthBalance: 0.7,
  certainSequenceSegments: 4,
  certainSequenceSimilarity: 0.9,
  certainSequenceLengthBalance: 0.7,
  certainJoinGapSec: 3,
};

// Sounds, not content. A segment made only of these is safe to drop on its own;
// anything else standing alone is speech and is kept.
const FILLER = new Set("um umm uh uhh uhm er err erm ah ahh hmm hm mm mmm mhm huh".split(" "));

/** True when a segment is nothing but filler sounds. */
export function isPureFiller(toks) {
  return toks.length > 0 && toks.every((t) => FILLER.has(t));
}

/** A take that cannot stand on its own as a finished line. */
export function isIncomplete(seg, cfg = DEFAULTS) {
  if (seg.truncated) return true;
  if (selfRepeat(seg.toks) >= cfg.stutter) return true;
  if (seg.terminal) return false;
  return seg.toks.length <= cfg.shortWords;
}

/**
 * Is this lone incomplete segment an abandoned attempt at a NEIGHBOUR's line?
 *
 * The distinction that matters, and the one an earlier version got wrong: a segment
 * can be short and unfinished either because the speaker gave up on it and started
 * over, or because the segmenter split a normal sentence on a 0.5s breath. The
 * evidence for the first is that a segment right next to it RE-SAYS its opening
 * words and gets further:
 *
 *   "let's now-"  ->  "let's immediately jump to how you can install these."   restart
 *   "Now it's just a question of"  ->  "quality."                              one sentence
 *
 * One shared leading word plus a neighbour that gets further is enough. With no
 * shared opening at all, the segment is speech and is kept.
 */
export function isAbandonedAttempt(all, i, cfg = DEFAULTS) {
  const s = all[i];
  if (!s || !s.toks.length) return false;
  if (!isIncomplete(s, cfg)) return false;
  const lo = Math.max(0, i - cfg.fragNeighbors);
  const hi = Math.min(all.length - 1, i + cfg.fragNeighbors);
  for (let j = lo; j <= hi; j++) {
    if (j === i) continue;
    const n = all[j];
    if (!n || !n.toks.length) continue;
    if (Math.abs(n.startSec - s.startSec) > cfg.fragSec) continue;
    if (n.toks.length < s.toks.length + 2) continue;             // must actually get further
    if (commonPrefix(s.toks, n.toks, s.truncated) >= 1) return true;
  }
  return false;
}

/* ------------------------------- run finding ------------------------------ */

/**
 * Group segments into "runs": all the takes of one line. Union-find over a bounded
 * lookback window, so this is O(n * lookback) and runs in milliseconds on a
 * full-length timeline.
 *
 * @param {Array} segs  [{index, startSec, text}] in timeline order
 * @returns {Array<Array>} runs of tokenized segments, in timeline order
 */
export function detectRuns(segs, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const T = segs.map((s) => ({ ...s, ...tokenize(s.text) }));
  const parent = T.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };

  for (let i = 0; i < T.length; i++) {
    for (let j = Math.max(0, i - cfg.lookback); j < i; j++) {
      const a = T[j], b = T[i];
      if (!a.toks.length || !b.toks.length) continue;
      if (b.startSec - a.startSec > cfg.windowSec) continue;
      const n = commonPrefix(a.toks, b.toks, a.truncated);
      const min = Math.min(a.toks.length, b.toks.length);
      const linked =
        n >= cfg.head ||                       // same opening words
        (n === min && n >= 2) ||               // one take is entirely a prefix of the other
        overlapRatio(a.toks, b.toks) >= cfg.sim; // same line, reworded opening
      if (linked) union(j, i);
    }
  }
  const groups = new Map();
  T.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  const runs = [...groups.values()].sort((a, b) => a[0].index - b[0].index);
  runs.all = T; // the tokenized segments in timeline order, for neighbour tests
  return runs;
}

function meaningfulWordCount(toks) {
  return toks.filter((t) => !STOP.has(t)).length;
}

function sameSource(a, b) {
  return !(a.mediaPath && b.mediaPath && a.mediaPath !== b.mediaPath);
}

/** Can two phrase rows be parts of one continuous spoken attempt? */
function canJoinRows(a, b, cfg) {
  if (!a || !b || a.terminal || a.truncated || !sameSource(a, b)) return false;
  const sourceGap = Number.isFinite(a.sourceOutSec) && Number.isFinite(b.sourceInSec)
    ? b.sourceInSec - a.sourceOutSec
    : null;
  if (sourceGap != null && (sourceGap < -0.05 || sourceGap > cfg.certainJoinGapSec)) return false;
  const timelineGap = Number.isFinite(a.endSec) && Number.isFinite(b.startSec)
    ? b.startSec - a.endSec
    : b.startSec - a.startSec;
  return !Number.isFinite(timelineGap) || timelineGap <= cfg.certainJoinGapSec;
}

/** Rolling 1–N row windows, stopping at completed sentences and source gaps. */
function sequenceWindows(all, cfg) {
  return all.map((_, start) => {
    const out = [];
    const toks = [];
    const indices = [];
    for (let pos = start; pos < all.length && pos < start + cfg.certainSequenceSegments; pos++) {
      if (pos > start && !canJoinRows(all[pos - 1], all[pos], cfg)) break;
      toks.push(...all[pos].toks);
      indices.push(all[pos].index);
      out.push({
        startPos: start,
        endPos: pos,
        startSec: all[start].startSec,
        toks: [...toks],
        indices: [...indices],
        terminal: all[pos].terminal,
        truncated: all[pos].truncated,
        mediaPath: all[start].mediaPath,
      });
    }
    return out;
  });
}

function sequenceEvidence(candidate, keeper, cfg) {
  if (!sameSource(candidate, keeper)) return false;
  const prefix = commonPrefix(candidate.toks, keeper.toks, candidate.truncated);
  const directPrefix =
    !keeper.truncated && !isIncomplete(keeper, cfg) &&
    candidate.toks.length >= 5 && candidate.toks.length + 2 <= keeper.toks.length &&
    prefix === candidate.toks.length;
  if (directPrefix) return true;

  const candidateWords = meaningfulWordCount(candidate.toks);
  const keeperWords = meaningfulWordCount(keeper.toks);
  if (candidateWords < 5 || keeperWords < 5) return false;
  const lengthBalance = Math.min(candidateWords, keeperWords) / Math.max(candidateWords, keeperWords);
  return (
    !isIncomplete(candidate, cfg) && !isIncomplete(keeper, cfg) &&
    lengthBalance >= cfg.certainSequenceLengthBalance &&
    overlapRatio(candidate.toks, keeper.toks) >= cfg.certainSequenceSimilarity
  );
}

/**
 * Return only retakes supported by direct, high-confidence textual evidence.
 *
 * This is the policy used by Fast mode. It deliberately does not inherit the
 * general detector's fuzzy similarity, generic shared-opening, filler, stutter,
 * or abandoned-fragment decisions. A segment is cut only when a nearby later
 * segment directly proves one of two shapes:
 *
 *   1. an earlier take is a word-for-word prefix of a longer usable take;
 *   2. two usable takes have at least 85% ordered content-word similarity
 *      and are similar in length.
 *
 * Every candidate is compared directly with its later keeper. Union-find may
 * still supply the UI group number, but transitive membership can never be the
 * evidence for a cut.
 */
export function analyzeCertainRetakes(segs, opts = {}) {
  const cfg = { ...DEFAULTS, ...CERTAIN_DEFAULTS, ...opts };
  const runs = detectRuns(segs, {
    ...cfg,
    lookback: Math.max(cfg.lookback, cfg.certainLookback),
    windowSec: Math.max(cfg.windowSec, cfg.certainWindowSec),
  });
  const posByIndex = new Map((runs.all || []).map((s, i) => [s.index, i]));
  const decisions = new Map();

  runs.forEach((run, gi) => {
    for (let i = 0; i < run.length - 1; i++) {
      const candidate = run[i];
      let evidence = null;

      for (let j = i + 1; j < run.length; j++) {
        const keeper = run[j];
        if (posByIndex.get(keeper.index) - posByIndex.get(candidate.index) > cfg.certainLookback) break;
        if (keeper.startSec - candidate.startSec > cfg.certainWindowSec) break;
        if (!sameSource(candidate, keeper)) continue;

        const prefix = commonPrefix(candidate.toks, keeper.toks, candidate.truncated);
        const directPrefix =
          !keeper.truncated && !isIncomplete(keeper, cfg) &&
          candidate.toks.length + 2 <= keeper.toks.length &&
          candidate.toks.length >= cfg.certainPrefixWords &&
          prefix === candidate.toks.length;

        const candidateWords = meaningfulWordCount(candidate.toks);
        const keeperWords = meaningfulWordCount(keeper.toks);
        const lengthBalance = Math.min(candidateWords, keeperWords) / Math.max(candidateWords, keeperWords);
        const exactRepeat =
          candidate.toks.length >= cfg.certainDuplicateWords &&
          candidate.toks.length === keeper.toks.length &&
          candidate.toks.every((word, k) => word === keeper.toks[k]);
        const nearDuplicate =
          !isIncomplete(candidate, cfg) && !isIncomplete(keeper, cfg) &&
          candidateWords >= cfg.certainDuplicateWords && keeperWords >= cfg.certainDuplicateWords &&
          lengthBalance >= cfg.certainLengthBalance &&
          overlapRatio(candidate.toks, keeper.toks) >= cfg.certainSimilarity;

        if (directPrefix || exactRepeat || nearDuplicate) {
          evidence = directPrefix
            ? "confirmed repeated prefix"
            : exactRepeat ? "confirmed exact repeat" : "confirmed high-similarity repeat";
          break;
        }
      }

      if (evidence) {
        decisions.set(candidate.index, {
          index: candidate.index,
          decision: "cut",
          group: gi,
          reason: evidence,
          confidence: 0.99,
        });
      }
    }
  });

  // Phrase splitting is deliberately fine-grained, so one spoken attempt often
  // occupies several rows while its retry occupies one differently-sized row.
  // Compare rolling windows directly and mark every row in the earlier window.
  // Windows only cross unfinished boundaries and small source gaps, preventing a
  // completed sentence from being swept into the next retake by adjacency alone.
  const all = runs.all || [];
  const windows = sequenceWindows(all, cfg);
  let sequenceGroup = runs.length;
  for (let start = 0; start < all.length; start++) {
    for (const candidate of windows[start]) {
      if (candidate.indices.length < 2 || candidate.toks.length < 5) continue;
      let matched = false;
      for (let later = candidate.endPos + 1; later < all.length; later++) {
        if (later - start > cfg.certainLookback) break;
        if (all[later].startSec - candidate.startSec > cfg.certainWindowSec) break;
        for (const keeper of windows[later]) {
          if (!sequenceEvidence(candidate, keeper, cfg)) continue;
          const group = sequenceGroup++;
          for (const index of candidate.indices) {
            decisions.set(index, {
              index,
              decision: "cut",
              group,
              reason: "confirmed multi-segment repeat",
              confidence: 0.98,
            });
          }
          matched = true;
          break;
        }
        if (matched) break;
      }
    }
  }

  // Transcription occasionally emits a tiny duplicate tail as its own row:
  // "...access to." followed by another 0.25s "to.". This is direct audio-text
  // duplication, not a semantic guess, and is safe to remove locally.
  for (let pos = 1; pos < all.length; pos++) {
    const s = all[pos];
    const prev = all[pos - 1];
    if (!sameSource(prev, s) || s.toks.length < 1 || s.toks.length > 2) continue;
    if (!Number.isFinite(s.durationSec) || s.durationSec > 0.5) continue;
    if (Number.isFinite(prev.endSec) && s.startSec - prev.endSec > 0.25) continue;
    const tail = prev.toks.slice(-s.toks.length);
    if (tail.length !== s.toks.length || !tail.every((word, i) => word === s.toks[i])) continue;
    decisions.set(s.index, {
      index: s.index,
      decision: "cut",
      group: sequenceGroup++,
      reason: "duplicate trailing word",
      confidence: 0.99,
    });
  }

  return [...decisions.values()].sort((a, b) => a.index - b.index);
}

/** Indices immediately around position `i` (context the model needs to judge a fragment). */
function neighborIndices(all, i, cfg) {
  const out = [];
  for (let j = Math.max(0, i - 1); j <= Math.min(all.length - 1, i + 1); j++) {
    if (j !== i) out.push(all[j].index);
  }
  return out;
}

/* -------------------------------- decisions ------------------------------- */

/**
 * Decide keep/cut for every segment, and flag the groups worth escalating.
 *
 * Keeper rule: a re-record supersedes what came before, so the keeper is the LAST
 * usable pass of a run. This is the single highest-value rule in the whole feature
 * and it needs no model.
 *
 * @returns {{decisions, groups, escalate}}
 *   decisions  [{index, decision:"cut", group, reason, confidence}] (cuts only)
 *   groups     [{group, indices, keeper, kind, completes, confidence}]
 *   escalate   the subset of groups an LLM should review (see planEscalation)
 */
export function analyzeRuns(segs, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const runs = detectRuns(segs, cfg);
  const decisions = [];
  const groups = [];

  const all = runs.all || [];
  const posOf = new Map(all.map((s, i) => [s.index, i]));
  runs.forEach((run, gi) => {
    if (run.length === 1) {
      const s = run[0];
      // A segment that repeats NOTHING is not a retake, so it is kept. This looks
      // like a place to also cut "obvious fragments" (short, no full stop), and an
      // earlier version did. It is wrong: segments are split on a 0.5s pause
      // (EDITAGENT_PHRASE_GAP_SEC), so half of a normal sentence has exactly that
      // shape. "Now it's just a question of" + "quality." is one line, and cutting
      // the first half destroys it. Only pure filler ("um") is cut on its own.
      const filler = isPureFiller(s.toks);
      const abandoned = !filler && isAbandonedAttempt(all, posOf.get(s.index), cfg);
      if (filler || abandoned) {
        decisions.push({
          index: s.index,
          decision: "cut",
          group: gi,
          reason: filler ? "filler" : "abandoned attempt",
          confidence: filler ? 0.9 : 0.7,
        });
        groups.push({ group: gi, indices: [s.index], keeper: null, kind: filler ? "filler" : "fragment", completes: 0, confidence: filler ? 0.9 : 0.7 });
      } else {
        // Kept, but unfinished-looking and standing alone: either half of a sentence
        // the segmenter split on a breath, or a false start with no lexical twin.
        // Cutting it blind is how good content gets destroyed, so it is kept here and
        // offered to the model WITH its neighbours, which is what makes it decidable.
        const pos = posOf.get(s.index);
        const unsure = isIncomplete(s, cfg);
        groups.push({
          group: gi,
          indices: [s.index],
          keeper: s.index,
          kind: unsure ? "loose-fragment" : "unique",
          completes: unsure ? 0 : 1,
          confidence: unsure ? 0.5 : 1,
          context: unsure ? neighborIndices(all, pos, cfg) : undefined,
        });
      }
      return;
    }
    const usable = run.filter((s) => !isIncomplete(s, cfg));
    const keeper = usable.length ? usable[usable.length - 1] : run[run.length - 1];
    const confidence = !usable.length ? 0.4 : usable.length === 1 ? 0.95 : 0.75;
    for (const s of run) {
      if (s === keeper) continue;
      decisions.push({ index: s.index, decision: "cut", group: gi, reason: "duplicate take", confidence });
    }
    groups.push({
      group: gi,
      indices: run.map((s) => s.index),
      keeper: keeper.index,
      kind: "retakes",
      completes: usable.length,
      confidence,
    });
  });

  return { decisions, groups, escalate: planEscalation(groups, segs, cfg) };
}

/**
 * Which groups are genuinely ambiguous, i.e. worth spending a model on.
 *
 *  - completes === 0: no take of the line is clean; which partials stitch together
 *    into one fluent line is a judgment call.
 *  - completes >= 2 AND the last two clean takes are NOT near-identical: they may be
 *    two DIFFERENT points (both keepers) rather than a restart.
 *
 * Everything else (one clean take in the run, or several near-identical ones) is
 * decided by the last-usable-pass rule with no model.
 *
 * `mode` widens or narrows the net: "tight" (default) escalated ~27% of the eval
 * timeline, "wide" ~62% with better error coverage. Both are one small call.
 */
export function planEscalation(groups, segs, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const wide = cfg.mode === "wide";
  const byIndex = new Map(segs.map((s) => [s.index, tokenize(s.text)]));
  const out = [];
  for (const g of groups) {
    // A loose fragment is one line plus its neighbours: cheap to ask about, and the
    // question ("false start, or half of the sentence next to it?") is exactly the
    // kind the detector cannot settle from text shape alone.
    if (g.kind === "loose-fragment") { out.push(g); continue; }
    if (g.kind !== "retakes") continue;
    if (wide || g.completes === 0) { out.push(g); continue; }
    if (g.completes < 2) continue;
    const clean = g.indices.filter((i) => !isIncomplete({ ...byIndex.get(i) }, cfg));
    const a = byIndex.get(clean[clean.length - 2]);
    const b = byIndex.get(clean[clean.length - 1]);
    if (!a || !b || overlapRatio(a.toks, b.toks) < 0.8) out.push(g);
  }
  return out;
}
