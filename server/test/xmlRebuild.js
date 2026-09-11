// Checks the legacy XML helpers (no Premiere): keep-span layout math (cuts
// subtract, compaction, source mapping, multi-track sync) and xmeml emission.
// Runtime applies must stay on the active sequence via the in-place path.
import { computeKeepLayout, buildXmeml } from "../rebuild.js";
import { applyRangesBatched } from "../silences.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

// 30fps; one source clip on V1 + A1: timeline [0,30]s, source [10,40]s.
const F = (sec) => ({ seconds: sec, frame: Math.round(sec * 30) });
function clip(id, trackType, trackIndex, startSec, endSec, srcInSec, opts = {}) {
  return {
    id,
    name: opts.name || "rec.mp4",
    trackType,
    trackIndex,
    mediaPath: "mediaPath" in opts ? opts.mediaPath : "/Users/me/My Videos/rec.mp4",
    hasMedia: "mediaPath" in opts ? !!opts.mediaPath : true,
    start: F(startSec),
    end: F(endSec),
    sourceIn: F(srcInSec),
    sourceOut: F(srcInSec + (endSec - startSec)),
    speed: opts.speed || 1,
    speedIsNormal: !("speed" in opts),
  };
}
const TIMELINE = {
  sequence: { name: "My Seq", frameRate: 30, dropFrame: false, videoTrackCount: 2, audioTrackCount: 1, frameSize: { width: 2560, height: 1440 } },
  clips: [clip("V1.0", "video", 0, 0, 30, 10), clip("A1.0", "audio", 0, 0, 30, 10)],
  gaps: [],
};
// cuts at [5,7]s and [20,22]s → frames [150,210], [600,660]
const CUTS = [
  { startFrame: 150, endFrame: 210 },
  { startFrame: 600, endFrame: 660 },
];

// --- layout math ---
const layout = computeKeepLayout(TIMELINE, CUTS);
const v = layout.items.filter((i) => i.trackType === "video");
const a = layout.items.filter((i) => i.trackType === "audio");
check("3 keep spans per track", v.length === 3 && a.length === 3, layout.items);
check("span 1: [0,150) stays, src 300", v[0].start === 0 && v[0].end === 150 && v[0].srcIn === 300 && v[0].srcOut === 450, v[0]);
check("span 2: [210,600) compacts to 150, src 510", v[1].start === 150 && v[1].end === 540 && v[1].srcIn === 510, v[1]);
check("span 3: [660,900) compacts to 540, src 960", v[2].start === 540 && v[2].end === 780 && v[2].srcIn === 960 && v[2].srcOut === 1200, v[2]);
check("audio mirrors video exactly (sync)", a.every((x, i) => x.start === v[i].start && x.end === v[i].end && x.srcIn === v[i].srcIn), a);
check("duration = 780 frames (26s)", layout.durationFrames === 780, layout.durationFrames);
check("removedFrames = 120 (4s)", layout.removedFrames === 120, layout.removedFrames);

// --- pre-existing gap is preserved (clip at [40,50]s, cuts before it) ---
const TL2 = { ...TIMELINE, clips: [clip("V1.0", "video", 0, 0, 30, 10), clip("V1.1", "video", 0, 40, 50, 0)] };
const lay2 = computeKeepLayout(TL2, CUTS);
const late = lay2.items.find((i) => i.origStart === 1200);
check("gap preserved: [40,50)s clip shifts only by the 4s cut", late.start === 1200 - 120 && late.end === 1500 - 120, late);

// --- unsupported timelines throw (caller falls back to razor) ---
let threw = "";
try { computeKeepLayout({ ...TIMELINE, clips: [...TIMELINE.clips, clip("V2.0", "video", 1, 0, 5, 0, { mediaPath: null, name: "Title" })] }, CUTS); } catch (e) { threw = e.message; }
check("no-media item (title) rejected", /no source media/.test(threw), threw);
threw = "";
try { computeKeepLayout({ ...TIMELINE, clips: [clip("V1.0", "video", 0, 0, 30, 10, { speed: 2 })] }, CUTS); } catch (e) { threw = e.message; }
check("speed clip rejected", /speed/.test(threw), threw);

// --- xmeml emission ---
const xml = buildXmeml({ sequenceName: "My Seq - tightened", fps: 30, width: 2560, height: 1440, layout, videoTrackCount: 2, audioTrackCount: 1 });
check("xmeml doctype + v4", /<!DOCTYPE xmeml>/.test(xml) && /<xmeml version="4">/.test(xml), xml.slice(0, 120));
check("integer timebase 30, ntsc FALSE", /<timebase>30<\/timebase><ntsc>FALSE<\/ntsc>/.test(xml), xml.match(/<rate>.*?<\/rate>/)[0]);
check("6 clipitems", (xml.match(/<clipitem /g) || []).length === 6, (xml.match(/<clipitem /g) || []).length);
check("3 tracks emitted (V1,V2 empty,A1)", (xml.match(/<track>/g) || []).length === 3, (xml.match(/<track>/g) || []).length);
check("file defined once, referenced after", (xml.match(/<file id="file-1">/g) || []).length === 1 && (xml.match(/<file id="file-1"\/>/g) || []).length === 5, xml.match(/<file[^>]*>/g));
check("pathurl percent-encodes the space", /<pathurl>file:\/\/localhost\/Users\/me\/My%20Videos\/rec.mp4<\/pathurl>/.test(xml), xml.match(/<pathurl>[^<]*/));
check("audio clipitem carries sourcetrack", /<sourcetrack><mediatype>audio<\/mediatype><trackindex>1<\/trackindex><\/sourcetrack>/.test(xml), null);
check("video+audio spans are linked", (xml.match(/<link>/g) || []).length === 12, (xml.match(/<link>/g) || []).length); // 6 clipitems × 2 members
check("frame fields are ints", /<start>150<\/start><end>540<\/end><in>510<\/in><out>900<\/out>/.test(xml), xml.match(/<start>[^<]*<\/start>/g));

// ntsc flag: 29.97 → TRUE
const xmlNtsc = buildXmeml({ sequenceName: "S", fps: 29.97, width: 1920, height: 1080, layout, videoTrackCount: 1, audioTrackCount: 1 });
check("29.97 → ntsc TRUE", /<timebase>30<\/timebase><ntsc>TRUE<\/ntsc>/.test(xmlNtsc), null);

// --- runtime routing: even a large ripple job stays in place ---
function makeCtx() {
  const calls = [];
  return {
    calls,
    bridge: {
      callHost: async (action, params) => {
        calls.push({ action, ...params });
        return { ok: true };
      },
      notifyPanel: () => {},
    },
    state: { revision: 0 },
  };
}
const FRAMES = CUTS.map((c) => ({ ...c }));

const ctxR = makeCtx();
const rr = await applyRangesBatched(ctxR, FRAMES, { ripple: true, fps: 30, timeline: TIMELINE, rebuildMin: 1 });
check("large ripple apply never exports or imports XML", !ctxR.calls.some((c) => /XmlSequence$/.test(c.action)), ctxR.calls);
check("large ripple apply razors and closes gaps in place", ctxR.calls.map((c) => c.action).join(",") === "removeRangesBatch,closeRangeGaps", ctxR.calls);
check("in-place result reports both cuts applied", !rr.rebuild && rr.applied === 2 && Math.abs(rr.appliedSec - 4) < 1e-6, rr);

console.log(failures === 0 ? "\nAll xml-rebuild checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
