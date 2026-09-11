// Pure checks for Retake V2's word document and editorially-safe frame planner.
import { applyRetakeV2, buildRetakeV2Document, planSafeWordCuts, suggestionsFromSegments } from "../retake-v2.js";

const TPS = 254016000000;
const TB = String(TPS / 30);
const tk = (sec) => String(Math.round(sec * TPS));
let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

function clip(id, srcIn, srcOut, start, itemIndex = 0) {
  return {
    id, itemIndex, mediaPath: "m.mp4", hasMedia: true, speedIsNormal: true,
    trackType: "video", trackIndex: 0,
    sourceIn: { seconds: srcIn, ticks: tk(srcIn), frame: Math.round(srcIn * 30) },
    sourceOut: { seconds: srcOut, ticks: tk(srcOut), frame: Math.round(srcOut * 30) },
    start: { seconds: start, ticks: tk(start), frame: Math.round(start * 30) },
    end: { seconds: start + srcOut - srcIn, ticks: tk(start + srcOut - srcIn), frame: Math.round((start + srcOut - srcIn) * 30) },
  };
}
const seq = { name: "S", timebase: TB, frameRate: 30, dropFrame: false };
const tokens = [
  { type: "word", text: "First.", start: 0.2, end: 0.5, speaker_id: "s0" },
  { type: "spacing", text: " ", start: 0.5, end: 1.0 },
  { type: "word", text: "bad", start: 1.0, end: 1.2, speaker_id: "s0" },
  { type: "word", text: "take.", start: 1.5, end: 1.8, speaker_id: "s0" },
  { type: "word", text: "Next.", start: 2.2, end: 2.5, speaker_id: "s0" },
];
const original = clip("V1.0", 0, 3, 5);
const doc = buildRetakeV2Document([{ clip: original, words: tokens }], seq);

check("document preserves content words, not spacing tokens", doc.words.length === 4, doc.words.map((w) => w.text));
check("sentence punctuation creates margin rows only", doc.sentences.length === 3, doc.sentences.map((s) => s.text));
check("each word keeps exact source identity", doc.words[1].sourceInSec === 1 && doc.words[1].clipId === "V1.0", doc.words[1]);
check("word has original frame-exact timeline mapping", doc.words[1].startFrame === 180, doc.words[1].startFrame);

const suggestion = suggestionsFromSegments([{
  clipId: "V1.0", mediaPath: "m.mp4", trackType: "video", trackIndex: 0,
  sourceInSec: 0.9, sourceOutSec: 1.9, decision: "cut", protected: false,
  wordCount: 2, reason: "duplicate take", group: 4,
}], doc.words);
check("candidate segment becomes one exact word suggestion", suggestion.length === 1 && suggestion[0].startWord === 1 && suggestion[0].endWord === 2, suggestion);
check("suggestion carries review reason and starts accepted", suggestion[0].reason === "duplicate take" && suggestion[0].accepted, suggestion[0]);

// The selected words are [1.0..1.8]. Safe boundaries reserve 80ms after the
// previous kept word and before the next: [0.58..2.12] source -> [5.58..7.12] TL.
const timeline = { sequence: seq, clips: [original] };
const planned = planSafeWordCuts(doc.words, [{ startWord: 1, endWord: 2 }], timeline, { padSec: 0.08 });
check("safe planner emits one interval", planned.frames.length === 1, planned);
check("start sits in air after previous kept word", planned.plans[0].startSourceSec === 0.58, planned.plans[0]);
check("end sits in air before next kept word", planned.plans[0].endSourceSec === 2.12, planned.plans[0]);
check("source interval maps through integer Premiere frames", planned.frames[0].startFrame === 167 && planned.frames[0].endFrame === 214, planned.frames[0]);

// An existing edit inside the selection must split it into separate live pieces.
const splitTimeline = {
  sequence: seq,
  clips: [clip("V1.a", 0, 1.3, 5), clip("V1.b", 1.3, 3, 6.3, 1)],
};
const split = planSafeWordCuts(doc.words, [{ startWord: 1, endWord: 2 }], splitTimeline, { padSec: 0.08 });
check("selection splits at a live clip boundary", split.frames.length === 2, split.frames);
check("split ranges remain ordered and non-overlapping", split.frames[0].endFrame <= split.frames[1].startFrame, split.frames);

const gone = planSafeWordCuts(doc.words, [{ startWord: 1, endWord: 2 }], { sequence: seq, clips: [] });
check("absent footage is counted, never cut at stale frames", gone.frames.length === 0 && gone.alreadyGone === 1, gone);

// Integration boundary: Apply reads the live timeline, batches the planned
// frames, closes gaps once, and captures the pre-edit snapshot for one-click undo.
{
  const calls = [];
  const ctx = {
    state: { revision: 0 },
    review: { reviewId: "S:1", frameRate: 30, words: doc.words },
    bridge: {
      callHost: async (action, params) => {
        if (action === "getTimelineState") {
          return {
            sequence: { ...seq, zeroPointTicks: "0", videoTrackCount: 1, audioTrackCount: 1 },
            clips: [{
              id: "V1.0", itemIndex: 0, name: "take", mediaPath: "m.mp4", trackType: "video", trackIndex: 0,
              start: { seconds: 5, ticks: tk(5) }, end: { seconds: 8, ticks: tk(8) },
              inPoint: { seconds: 0, ticks: tk(0) }, outPoint: { seconds: 3, ticks: tk(3) },
            }], gaps: [],
          };
        }
        calls.push({ action, params });
        if (action === "removeRangesBatch") return { removedIndexes: [0], failed: 0, straddling: 0 };
        if (action === "closeRangeGaps") return { ok: true, failed: 0, misaligned: 0 };
        throw new Error("unexpected host call " + action);
      },
    },
  };
  const applied = await applyRetakeV2(ctx, [{ startWord: 1, endWord: 2 }], { removeGaps: true });
  check("apply uses one batch plus one close-gaps pass", calls.length === 2 && calls[0].action === "removeRangesBatch" && calls[1].action === "closeRangeGaps", calls);
  check("apply captures a V2 undo snapshot", applied.undoable && ctx.undo && ctx.undo.kind === "retake-v2", ctx.undo);
  check("apply bumps the shared timeline revision", applied.revision === 1 && ctx.state.revision === 1, applied);
}

console.log(failures === 0 ? "\nAll Retake V2 checks passed." : `\n${failures} Retake V2 check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
