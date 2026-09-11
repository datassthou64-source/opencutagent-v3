// Unit checks for the deterministic retake detector (server/retakes/detect.js).
// Pure string/interval logic — no Premiere, no transcript, no model call.
// The accuracy of the whole detector against a real human-labeled timeline is
// measured separately by `npm run eval:detect` (also offline and free).
import { tokenize, commonPrefix, overlapRatio, selfRepeat, isIncomplete, detectRuns, analyzeRuns, analyzeCertainRetakes, planEscalation } from "../retakes/detect.js";
import { planGroupBatches, groupPrompt, retakeMode, analyzeRetakesFast } from "../retakes/fast.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}
const T = (s) => tokenize(s).toks;
const seg = (index, startSec, text) => ({ index, startSec, text });

/* ---- tokenize ---- */
check("dash marks a cut-off take", tokenize("and just this loop t-").truncated);
check("ellipsis marks a cut-off take", tokenize("First thing you do is head over...").truncated);
check("terminal punctuation detected", tokenize("Let's install these skills.").terminal);
check("a cut-off take is never terminal", tokenize("head over...").terminal === false);
check("parentheticals are dropped", T("(clears throat) we now have").join(" ") === "we now have");

/* ---- commonPrefix ---- */
check("shared opening words", commonPrefix(T("we now have a set"), T("we now have a set of skills"), false) === 5);
check(
  "a cut-off final word still matches by stem",
  commonPrefix(T("to now efficiently and autonomin-"), T("to now efficiently and autonomously create"), true) === 5
);
check("unrelated lines share nothing", commonPrefix(T("let's install this"), T("pricing works like so"), false) === 0);

/* ---- overlapRatio ---- */
check(
  "a reworded restart still matches",
  overlapRatio(T("But ultimately here is the idea because I built it with a webhook"), T("But this is the idea because I built it with a webhook")) > 0.8
);
check("different content does not match", overlapRatio(T("install the plugin inside claude code"), T("pricing depends on token usage")) < 0.4);

/* ---- selfRepeat ---- */
check("stutter inside one take is detected", selfRepeat(T("and just just and just this loop and just this loop")) >= 0.25);
check("a clean sentence does not read as stutter", selfRepeat(T("this workflow reads a skill file and builds the nodes")) < 0.25);

/* ---- isIncomplete ---- */
check("cut-off take is incomplete", isIncomplete(tokenize("we now have a-")));
check("bare connective is incomplete", isIncomplete(tokenize("and")));
check("finished sentence is complete", isIncomplete(tokenize("We now have a set of skills.")) === false);
check(
  "long unpunctuated line counts as usable",
  isIncomplete(tokenize("we now have a set of skills that instructs claude how to use the mcp")) === false
);

/* ---- run grouping + keeper choice ---- */
const staircase = [
  seg(0, 0, "We now have-"),
  seg(1, 3, "We now have a set of-"),
  seg(2, 8, "We now have a set of skills that help."),
  seg(3, 30, "Completely separate point about pricing today."),
];
const runs = detectRuns(staircase);
check("a restart staircase groups into one run", runs.length === 2 && runs[0].length === 3, runs.map((r) => r.map((s) => s.index)));
const a = analyzeRuns(staircase);
check("keeper is the last usable pass", a.decisions.map((d) => d.index).join(",") === "0,1", a.decisions);
check("an unrelated line is left alone", a.groups.find((g) => g.indices.includes(3)).keeper === 3);

// A run whose takes are ALL cut off: keep the furthest one, and escalate the group.
const allPartial = [seg(0, 0, "Let's immediately-"), seg(1, 4, "Let's immediately jump on to how y-")];
const ap = analyzeRuns(allPartial);
check("no clean take: the fullest pass survives", ap.decisions.map((d) => d.index).join(",") === "0");
check("no clean take: the group is escalated", ap.escalate.length === 1);

// Two consecutive DIFFERENT points that share an opening are not a restart pair,
// so the detector flags them for review instead of silently cutting one.
const twoPoints = [
  seg(0, 0, "So first we added the MCP connection to the panel."),
  seg(1, 6, "So second we installed the plugins inside Claude Code."),
];
const tp = analyzeRuns(twoPoints);
check("distinct points are not both cut", tp.decisions.length <= 1, tp.decisions);

// A lone unfinished line with NOTHING repeating it is kept, not cut. This is the
// regression that matters: segments split on a 0.5s pause, so "Now it's just a
// question of" + "quality." is one sentence, and cutting the first half destroys it.
const sentenceHalves = analyzeRuns([seg(0, 12, "Now it's just a question of"), seg(1, 14, "quality.")]);
check("half a sentence is never cut", sentenceHalves.decisions.length === 0, sentenceHalves.decisions);
check("but it is flagged for review", sentenceHalves.escalate.some((g) => g.indices.includes(0)));
check("the flagged fragment carries its neighbours as context", (sentenceHalves.escalate.find((g) => g.indices.includes(0)).context || []).includes(1));

// A lone unfinished line that a neighbour RE-SAYS and gets further on is a real
// abandoned attempt, so it is cut without asking anyone.
const abandoned = analyzeRuns([seg(0, 0, "Let's now-"), seg(1, 4, "Let's immediately jump to how you can install these skills.")]);
check("abandoned attempt is cut", abandoned.decisions.length === 1 && abandoned.decisions[0].index === 0, abandoned.decisions);
check("the line it restarted is kept", !abandoned.decisions.some((d) => d.index === 1));

// Pure filler standing alone is always safe to drop.
const filler = analyzeRuns([seg(0, 0, "Um."), seg(1, 5, "So the first thing you do is open the panel.")]);
check("lone filler is cut", filler.decisions.length === 1 && filler.decisions[0].reason === "filler", filler.decisions);

/* ---- conservative Fast policy ---- */
const certainPrefix = analyzeCertainRetakes([
  seg(0, 0, "Pricing workflow creates video assets instantly-"),
  seg(1, 4, "Pricing workflow creates video assets instantly for every campaign today."),
]);
check("Fast cuts a clear truncated prefix", certainPrefix.map((d) => d.index).join(",") === "0", certainPrefix);

const unpunctuatedPrefix = analyzeCertainRetakes([
  seg(0, 0, "The pricing workflow creates video assets"),
  seg(1, 4, "The pricing workflow creates video assets for every campaign today."),
]);
check("Fast cuts an obvious unfinished prefix without a dash", unpunctuatedPrefix.map((d) => d.index).join(",") === "0", unpunctuatedPrefix);

const shortSpokenPrefix = analyzeCertainRetakes([
  seg(0, 0, "The oldest layer."),
  seg(1, 4, "The oldest layer of the book of Enoch says it flat."),
]);
check("Fast cuts a short spoken prefix repeated into a fuller take", shortSpokenPrefix.map((d) => d.index).join(",") === "0", shortSpokenPrefix);

const stopWordPrefix = analyzeCertainRetakes([
  seg(0, 0, "And they were."),
  seg(1, 4, "And they were in all two hundred who descended in the days of Jared."),
]);
check("Fast recognizes a repeated short function-word prefix", stopWordPrefix.map((d) => d.index).join(",") === "0", stopWordPrefix);

const certainRepeat = analyzeCertainRetakes([
  seg(0, 0, "Creative workflow builds campaign assets for customers."),
  seg(1, 5, "Creative workflow builds campaign assets for customers."),
]);
check("Fast cuts the earlier exact completed repeat", certainRepeat.map((d) => d.index).join(",") === "0", certainRepeat);

const nearRepeat = analyzeCertainRetakes([
  seg(0, 0, "Creative teams build targeted campaign assets quickly for every customer workflow."),
  seg(1, 6, "Creative teams build targeted campaign assets instantly for every customer workflow."),
]);
check("Fast cuts a very high-similarity completed repeat", nearRepeat.map((d) => d.index).join(",") === "0", nearRepeat);

const lightlyReworded = analyzeCertainRetakes([
  seg(0, 0, "So the oldest layer of Enoch gives you the names and all the gifts"),
  seg(1, 12, "The oldest layer of Enoch gives you the names and the gifts"),
]);
check("Fast cuts a lightly reworded usable take without punctuation", lightlyReworded.map((d) => d.index).join(",") === "0", lightlyReworded);

const splitRetake = analyzeCertainRetakes([
  { ...seg(0, 0, "Number three, what these gifts actually give you access to"), endSec: 2, sourceOutSec: 2 },
  { ...seg(1, 2, "for how to"), endSec: 3, sourceInSec: 2, sourceOutSec: 3 },
  { ...seg(2, 10, "three, what these gifts actually give you access to."), endSec: 13, sourceInSec: 10, sourceOutSec: 13 },
]);
check("Fast cuts every row of an earlier split retake", splitRetake.map((d) => d.index).join(",") === "0,1", splitRetake);

const forwardSplit = analyzeCertainRetakes([
  { ...seg(0, 0, "Now it is just a question of"), endSec: 2, sourceOutSec: 2 },
  { ...seg(1, 2, "quality."), endSec: 3, sourceInSec: 2, sourceOutSec: 3 },
  { ...seg(2, 8, "A separate point about publishing consistently."), endSec: 11, sourceInSec: 8, sourceOutSec: 11 },
]);
check("Fast does not cut ordinary forward-moving split speech", analyzeCertainRetakes(forwardSplit).length === 0, analyzeCertainRetakes(forwardSplit));

const duplicateTail = analyzeCertainRetakes([
  { ...seg(0, 0, "These gifts actually give you access to."), endSec: 2, durationSec: 2 },
  { ...seg(1, 2, "to."), endSec: 2.3, durationSec: 0.3 },
]);
check("Fast cuts a sub-half-second duplicated trailing word", duplicateTail.map((d) => d.index).join(",") === "1", duplicateTail);

const multicamDuplicate = analyzeCertainRetakes([
  { ...seg(0, 0, "Creative workflow builds campaign assets for customers."), mediaPath: "/media/a-cam.mov" },
  { ...seg(1, 1, "Creative workflow builds campaign assets for customers."), mediaPath: "/media/b-cam.mov" },
]);
check("Fast never treats matching multicamera media as retakes", multicamDuplicate.length === 0, multicamDuplicate);

const conservativeCases = analyzeCertainRetakes([
  seg(0, 0, "So first we added the MCP connection to the panel."),
  seg(1, 6, "So first we added the editing controls to the timeline."),
  seg(2, 12, "Let's immediately-"),
  seg(3, 16, "Let's immediately jump on to how y-"),
  seg(4, 22, "Um."),
  seg(5, 26, "This workflow reads a skill file and builds all nodes."),
  seg(6, 31, "This workflow uses a skill file to build every node."),
]);
check("Fast leaves shared openings, partials, filler, and rewording untouched", conservativeCases.length === 0, conservativeCases);

/* ---- escalation policy ---- */
const wide = planEscalation(a.groups, staircase, { mode: "wide" });
check("wide mode escalates every multi-take group", wide.length >= 1);

/* ---- fast path: batching, prompt, and the no-AI mode ---- */
const g = (id, ...idx) => ({ group: id, indices: idx, kind: "retakes" });
check("groups pack into size-capped batches", planGroupBatches([g(1, 1, 2, 3), g(2, 4, 5), g(3, 6)], 4).length === 2);
check("one oversized group still gets its own batch", planGroupBatches([g(1, 1, 2, 3, 4, 5)], 2).length === 1);

const promptSegs = [seg(0, 0, "We now have-"), seg(1, 5, "We now have a set of skills.")];
const prompt = groupPrompt([g(7, 0, 1)], new Map(promptSegs.map((s) => [s.index, s])));
check("prompt lists the group and its takes", prompt.includes("group 7:") && prompt.includes("[1] 0:05 We now have a set of skills."));
check("prompt does not leak unrelated segments", !prompt.includes("[2]"));

check("mode defaults to fast (no AI call per click)", retakeMode({}) === "fast");
check("mode can be overridden per call", retakeMode({ retake_mode: "fast" }) === "fast");
check("an unknown mode falls back to fast", retakeMode({ retake_mode: "banana" }) === "fast");
check("hybrid can be asked for explicitly", retakeMode({ retake_mode: "hybrid" }) === "hybrid");

// "fast" mode must never reach for the model, even when groups are ambiguous.
const fastOut = await analyzeRetakesFast(
  [seg(0, 0, "Let's immediately-"), seg(1, 4, "Let's immediately jump on to how y-"), seg(2, 30, "A totally separate point about pricing.")],
  { mode: "fast" }
);
check("fast mode leaves an uncertain all-partial run untouched", fastOut.decisions.length === 0, fastOut.decisions);
check("fast mode reports possible groups for manual review", fastOut.stats.reviewGroups >= 1, fastOut.stats);
check("fast mode never reports a Claude escalation", fastOut.stats.escalated === 0, fastOut.stats);
check("fast mode reports it reviewed nothing", fastOut.stats.reviewed === 0);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll retake-detector checks passed");
process.exit(failures ? 1 : 0);
