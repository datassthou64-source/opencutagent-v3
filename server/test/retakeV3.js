// Retakes V3: chunking, windows, answer validation, merge, distant repeats, full run (stubbed Claude).
import { buildChunks, planWindows, resolveWindow, mergeCuts, distantRepeats, preScanHints, analyzeRetakesV3 } from "../retakes/judge.js";

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; };

// words from "text|pauseAfter" pieces; 0.25s per word
function mk(script) {
  const words = [];
  let t = 0;
  for (const piece of script) {
    const [text, pause] = piece.split("|");
    for (const w of text.split(" ")) {
      words.push({ index: words.length, text: w, type: w.startsWith("[") ? "audio_event" : "word", clipKey: "0:c", sourceInSec: t, sourceOutSec: t + 0.2, startSec: t, endSec: t + 0.2 });
      t += 0.25;
    }
    t += Number(pause || 0);
  }
  return words;
}

const w = mk([
  "So the first thing you want to do is open the|0.8",
  "So the first thing you want to do is open the settings panel and-|1.2",
  "Okay. The first thing you want to do is open settings, then go to API keys.|0.6",
  "Paste the key and hit save.|0.5",
]);
const chunks = buildChunks(w);
check("chunks split at real pauses", chunks.length === 4 && chunks[1].text.startsWith("So the first") && chunks[1].pauseBefore > 0.7);
check("one window when the recording is short", planWindows(chunks).length === 1);
check("pre-scan hints the repeated opening", preScanHints(chunks).some(h => h.from === 0 && h.to === 1));

const win = { ownStart: 0, ownEnd: 4, ctxStart: 0, ctxEnd: 4 };
let r = resolveWindow({ cuts: [{ from: 0, to: 1, startsAt: "", endsAfter: "", keep: [2], reason: "restart", confidence: "high" }], review: [] }, win, chunks, w);
check("high-confidence cut with a later take is AUTO", r.cuts.length === 1 && r.cuts[0].startWord === 0 && r.cuts[0].endWord === chunks[1].endWord);
r = resolveWindow({ cuts: [{ from: 3, to: 3, startsAt: "", endsAfter: "", keep: [2], reason: "x", confidence: "high" }], review: [] }, win, chunks, w);
check("a cut whose keep is EARLIER goes to review", r.cuts.length === 0 && r.review[0].reason === "No later take to keep.");
r = resolveWindow({ cuts: [{ from: 3, to: 3, startsAt: "", endsAfter: "", keep: [3], reason: "x", confidence: "high" }], review: [] }, win, chunks, w);
check("keep inside the cut itself is rejected", r.cuts.length === 0);
r = resolveWindow({ cuts: [{ from: 3, to: 3, startsAt: "", endsAfter: "", keep: [2], reason: "x", confidence: "high" }].map(c => ({ ...c, keep: [4] })), review: [] }, win, chunks, w);
check("keep outside the window is ignored", r.cuts.length === 0);
r = resolveWindow({ cuts: [{ from: 1, to: 1, startsAt: "settings panel", endsAfter: "", keep: [2], reason: "x", confidence: "high" }], review: [] }, win, chunks, w);
check("startsAt places a mid-chunk cut on the exact word", r.cuts.length + r.review.length === 1 && (r.cuts[0] || r.review[0]).startWord === chunks[1].startWord + 11);
r = resolveWindow({ cuts: [{ from: 1, to: 1, startsAt: "not in there", endsAfter: "", keep: [2], reason: "x", confidence: "high" }], review: [] }, win, chunks, w);
check("unfindable words go to review, never guessed", r.cuts.length === 0 && r.review[0].reason === "Could not place the cut exactly.");
r = resolveWindow({ cuts: [{ from: 3, to: 3, startsAt: "", endsAfter: "", keep: [], reason: "x", confidence: "high" }], review: [] }, { ownStart: 0, ownEnd: 2, ctxStart: 0, ctxEnd: 4 }, chunks, w);
check("cuts starting in context (not owned) are dropped", r.cuts.length === 0 && r.review.length === 0);
const w2 = mk(["We ship on Friday.|0.6", "Tell me about pricing and plans for teams.|0.6", "Pricing starts at ten.|0.5"]);
r = resolveWindow({ cuts: [{ from: 0, to: 0, startsAt: "", endsAfter: "", keep: [1], reason: "x", confidence: "medium" }], review: [] }, { ownStart: 0, ownEnd: 3, ctxStart: 0, ctxEnd: 3 }, buildChunks(w2), w2);
check("medium confidence without matching words goes to review", r.cuts.length === 0 && r.review[0].suggested === true);
const w3 = mk(["Most of you are wrong.|0.6", "Okay let's start this over again. Take two.|0.8", "Most of you are making money in the wrong dimension.|0.5"]);
r = resolveWindow({ cuts: [{ from: 0, to: 1, startsAt: "", endsAfter: "", keep: [2], reason: "take two", confidence: "high" }], review: [] }, { ownStart: 0, ownEnd: 3, ctxStart: 0, ctxEnd: 3 }, buildChunks(w3), w3);
check("production aside counts as restart evidence", r.cuts.length === 1);

let m = mergeCuts([{ startWord: 0, endWord: 10, replacements: [{ startWord: 20, endWord: 30 }], reason: "a" }, { startWord: 5, endWord: 15, replacements: [{ startWord: 20, endWord: 30 }], reason: "b" }]);
check("overlapping cuts from two windows merge", m.cuts.length === 1 && m.cuts[0].endWord === 15);
m = mergeCuts([{ startWord: 0, endWord: 10, replacements: [{ startWord: 11, endWord: 20 }], reason: "a" }, { startWord: 11, endWord: 20, replacements: [{ startWord: 21, endWord: 30 }], reason: "b" }]);
check("a cut whose whole keep take is cut becomes a conflict", m.cuts.length === 1 && m.conflicts.length === 1 && m.conflicts[0].startWord === 0);

// Two 20-minute windows: a sentence said at minute 1 and again at minute 40.
const long = [];
const say = (text, at) => { for (const t of text.split(" ")) { long.push({ index: long.length, text: t, type: "word", clipKey: "0:c", sourceInSec: at, sourceOutSec: at + 0.2, startSec: at, endSec: at + 0.2 }); at += 0.25; } };
say("the secret to compounding is time in the market not timing", 60);
for (let k = 0; k < 40; k++) say("filler talk number " + k + " moves forward", 120 + k * 60);
say("the secret to compounding is time in the market not timing", 2400);
const lc = buildChunks(long), lw = planWindows(lc, { windowSec: 1200, overlapSec: 120 });
check("a 42-minute recording gets 2 windows of ~20 min", lw.length === 2);
check("windows own every chunk exactly once", lw.reduce((n, x) => n + x.ownEnd - x.ownStart, 0) === lc.length);
const dr = distantRepeats(long, lc, lw);
check("far-apart repeat is found for free", dr.length === 1 && dr[0].first === 0 && dr[0].second === lc.length - 1);

// Full run with a stubbed Claude: parallel windows, then one distant-repeat call.
let calls = 0;
const ask = async ({ prompt, schema }) => {
  calls++;
  if (schema.required.includes("pairs")) return { data: { pairs: [{ id: 0, verdict: "recap", reason: "callback" }] }, raw: { usage: { input_tokens: 10, output_tokens: 5 } } };
  return { data: { cuts: [], review: [] }, raw: { usage: { input_tokens: 100, output_tokens: 10 } } };
};
const res = await analyzeRetakesV3(long, [], { ask, record: () => {} });
check("one call per window plus one distant call", calls === lw.length + 1 && res.stats.calls === calls);
check("a recap verdict creates no review marker", res.deferred.length === 0);

if (failed) { console.log(`${failed} retake-v3 check(s) failed.`); process.exit(1); }
console.log("All retake-v3 checks passed.");
