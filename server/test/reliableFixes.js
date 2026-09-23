// Regressions from the 2026-09-23 Sean run: correct retake cuts were rejected by the
// validator, cut edges sat inside connected speech, and markers carried validator prose.
import { validateDecisions } from "../retakes/reliable.js";
import { shiftCutsToPauses } from "../retakes/reliable-session.js";
import { markerLabel } from "../retakes/review-markers.js";
import { findMicroRestarts } from "../retakes/stutters.js";
import { requireSimpleTimeline, transcriptSourceClips, expectedGeometry } from "../retakes/timeline-safety.js";

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; };

const words = Array.from({ length: 700 }, (_, index) => ({ index, text: "w" + index }));
const event = { startWord: 0, endWord: 632, eventStartWord: 0, eventEndWord: 632 };
const unit = (group, startWord, endWord, cuts, replacements) => ({
  ...event, group, startWord, endWord, status: "cut", information: "superseded_by_last_take",
  cuts, replacements, reason: "retake",
});

// The real shape: unit 0 is purely failed takes; its replacement lives in later units.
const whole = unit(0, 0, 284, [{ startWord: 0, endWord: 284 }], [{ startWord: 285, endWord: 294 }, { startWord: 381, endWord: 424 }]);
// Unit 3 trims a stutter INSIDE unit 0's replacement take (W381-424).
const stutter = unit(3, 381, 424, [{ startWord: 394, endWord: 398 }], [{ startWord: 399, endWord: 402 }]);
let r = validateDecisions([whole, stutter], [whole, stutter], words);
check("replacement in another unit of the same event is accepted", r.accepted.length === 2 && r.deferred.length === 0);

const outside = unit(1, 0, 284, [{ startWord: 0, endWord: 284 }], [{ startWord: 640, endWord: 650 }]);
r = validateDecisions([outside], [outside], words);
check("replacement outside the event is still rejected", r.accepted.length === 0 && r.deferred[0].reason === "Invalid word range.");

const cutOutsideUnit = unit(2, 0, 100, [{ startWord: 90, endWord: 120 }], [{ startWord: 200, endWord: 210 }]);
r = validateDecisions([cutOutsideUnit], [cutOutsideUnit], words);
check("a cut outside its own unit is still rejected", r.accepted.length === 0);

const eatsReplacement = unit(4, 285, 300, [{ startWord: 285, endWord: 294 }], [{ startWord: 295, endWord: 300 }]);
const needsIt = unit(5, 200, 284, [{ startWord: 200, endWord: 284 }], [{ startWord: 285, endWord: 294 }]);
r = validateDecisions([eatsReplacement, needsIt], [eatsReplacement, needsIt], words);
check("deleting a whole replacement is a conflict", r.accepted.length === 0 && r.deferred.length === 2);

// "So I watch men, I watch people" with Scribe timings: pauses after "So" and "men,".
const t = [["So", 0.00, 0.18], ["I", 0.96, 1.04], ["watch", 1.08, 1.36], ["men,", 1.44, 1.76], ["I", 2.28, 2.34], ["watch", 2.38, 2.58], ["people", 2.62, 2.94]];
const sw = t.map(([text, a, b], index) => ({ index, text, type: "word", clipKey: "0:c", sourceInSec: a, sourceOutSec: b }));
let [s] = shiftCutsToPauses(sw, [{ startWord: 2, endWord: 4, replacements: [{ startWord: 5, endWord: 6 }] }]);
check("restart cut slides to the equivalent position in the pauses", s.startWord === 1 && s.endWord === 3 && s.shiftedFrom[0] === 2);
[s] = shiftCutsToPauses(sw, [{ startWord: 2, endWord: 4, replacements: [{ startWord: 5, endWord: 6 }] }], [1]);
check("never slides onto a protected word", s.startWord === 2 && !s.shiftedFrom);
[s] = shiftCutsToPauses(sw, [{ startWord: 1, endWord: 3, replacements: [{ startWord: 4, endWord: 6 }] }]);
check("a cut already in pauses stays put", s.startWord === 1 && !s.shiftedFrom);

const mk = (txt) => txt.split(" ").map((text, index) => ({ index, text: text.replace(/_/g, " "), type: text.startsWith("[") ? "audio_event" : "word", clipKey: "0:c", sourceInSec: index * 0.3, sourceOutSec: index * 0.3 + 0.2 }));
let st = findMicroRestarts(mk("distributed, and the v- and, [clears_throat] and the universe hands"));
check("stutter with a cut-off word is found", st.length === 1 && st[0].startWord === 1 && st[0].endWord === 5 && st[0].replacements[0].startWord === 6);
st = findMicroRestarts(mk("You do not get what you want. You do not get what you are."));
check("rhetorical three-word repeat is left to Claude", st.length === 0);
st = findMicroRestarts(mk("so The four moon phases, the four moon-- the four phases of"));
check("restart chain anchored on a cut-off cuts every earlier try", st.length === 1 && st[0].startWord === 1 && st[0].endWord === 7);
st = findMicroRestarts(mk("is the old video. Is-- The freak out is the old way"));
check("a chain never reaches back across a finished sentence", st.length === 1 && st[0].startWord === 4);
st = findMicroRestarts(mk("want. And the light-- And the dial moves"));
check("cut-off restart is found", st.length === 1 && st[0].startWord === 1 && st[0].endWord === 3);
st = findMicroRestarts(mk("I watch men, I watch women every day"));
check("rhetorical parallel is left alone", st.length === 0);

check("join-failure marker says so", markerLabel({ category: "Audio boundary", replacements: [{}] }).name === "Remove? (check join)");
check("low-confidence cut gets a low marker", markerLabel({ replacements: [{}], confidence: "low" }).name === "Remove? (low)");
check("medium-confidence cut gets a medium marker", markerLabel({ replacements: [{}], confidence: "medium" }).name === "Remove? (medium)");
check("uncuttable stutter still gets a low marker", markerLabel({ group: 100394, category: "Audio boundary", replacements: [{}] }).name === "Stutter? (low)");
const label = markerLabel({ reason: "Word references must be ordered inclusive indices within W0-W284; context cannot..." });
check("validator prose never reaches a marker", label.name === "Pending review" && label.note === "Possible retake.");

// 2026-09-23 Master Youtube 1: nested multicam on V1, external mp3 on A1 (one frame
// shorter). Was refused as "Layout not supported"; A1 alone is the transcript.
const TB = 10594584000n, tc = f => ({ ticks: String(BigInt(f) * TB), seconds: Number(BigInt(f) * TB) / 254016000000 });
const clip = (trackType, trackIndex, name, mediaPath, s, e, src, extra = {}) => ({ trackType, trackIndex, name, mediaPath, hasMedia: !!mediaPath,
  isNested: !mediaPath, start: tc(s), end: tc(e), sourceIn: tc(src), sourceOut: tc(src + e - s), speedIsNormal: true, speedReversed: false,
  trackLocked: false, disabled: false, transitionCount: 0, ...extra });
const nestTl = { sequence: { id: "s", timebase: String(TB), captionTrackCount: 0 }, clips: [
  clip("video", 0, "Multicam setup", null, 0, 69539, 13990),
  clip("audio", 0, "Master Youtube 1.mp3", "/m.mp3", 0, 69538, 0),
] };
let err = null; try { requireSimpleTimeline(nestTl); } catch (e) { err = e.message; }
check("nested V1 + external A1 is accepted for auto retakes", err === null);
check("A1 is the only transcript source under a nested V1", transcriptSourceClips(nestTl).map(c => c.mediaPath).join() === "/m.mp3");
const withCam = { ...nestTl, clips: [...nestTl.clips, clip("audio", 1, "A CAM", "/cam.mp4", 0, 69539, 30000)] };
check("camera audio on A2 is cut along but not transcribed twice", transcriptSourceClips(withCam).length === 1 && transcriptSourceClips(withCam)[0].trackIndex === 0);
err = null; try { requireSimpleTimeline(withCam); } catch (e) { err = e.message; }
check("extra aligned audio track is accepted", err === null);
const g = expectedGeometry(nestTl, [{ startFrame: 100, endFrame: 200 }], true);
check("ripple shifts nested V1 and A1 identically", g.filter(x => x.start === String(100n * TB)).length === 2);
const title = { ...nestTl, clips: [...nestTl.clips, clip("video", 1, "Title", null, 0, 50, 0, { isNested: false })] };
err = null; try { requireSimpleTimeline(title); } catch (e) { err = e.message; }
check("a title (no media, not nested) is still refused, naming the clip", /V2 "Title"/.test(err || "") || /video2 "Title"/.test(err || ""));
const slow = { ...nestTl, clips: [clip("video", 0, "Multicam setup", null, 0, 69539, 13990, { speedIsNormal: false }), nestTl.clips[1]] };
err = null; try { requireSimpleTimeline(slow); } catch (e) { err = e.message; }
check("a retimed nest is still refused", /100% forward speed/.test(err || ""));

if (failed) { console.log(`${failed} reliable-fix check(s) failed.`); process.exit(1); }
console.log("All reliable-fix checks passed.");
