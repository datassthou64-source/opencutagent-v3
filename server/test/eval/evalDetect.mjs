// Offline eval for the DETERMINISTIC retake detector (server/retakes/detect.js),
// scored against the same human-labeled fixture as the LLM path (evalRetakes.mjs)
// with the same metrics, so the two are directly comparable.
//
// Costs nothing and takes milliseconds, so it can run on every change:
//   node server/test/eval/evalDetect.mjs
//   node server/test/eval/evalDetect.mjs -v                 # list every disagreement
//   node server/test/eval/evalDetect.mjs --mode wide        # wider LLM escalation net
//   node server/test/eval/evalDetect.mjs --sim 0.65 --head 3
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRuns } from "../../retakes/detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const num = (n, d) => { const v = flag(n, null); return v == null ? d : Number(v); };
const fixture = flag("fixture", "retakes-n8n");
const verbose = argv.includes("-v");
const C = { red: (s) => `\x1b[31m${s}\x1b[0m`, grn: (s) => `\x1b[32m${s}\x1b[0m`, yel: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

const segLines = readFileSync(join(HERE, "fixtures", `${fixture}.segments.txt`), "utf8").split("\n");
const golden = JSON.parse(readFileSync(join(HERE, "fixtures", `${fixture}.golden.json`), "utf8"));
const segs = [];
for (const line of segLines) {
  const m = line.match(/^\[(\d+)\]\s+(\S+)\s+([\s\S]*)$/);
  if (!m) continue;
  const [mm, ss] = m[2].split(":").map(Number);
  segs.push({ index: +m[1], time: m[2], startSec: mm * 60 + ss, text: m[3].trim() });
}
const goldenCut = new Set();
const beatOf = new Map();
for (const [[s, e], keepers] of golden.beats) {
  const k = new Set(keepers);
  for (let i = s; i <= e; i++) { if (!k.has(i)) goldenCut.add(i); beatOf.set(i, { range: [s, e] }); }
}
// Word-empty lines are auto-cut deterministically by the server, same as the LLM eval.
const isEmpty = (t) => t.replace(/\([^)]*\)/g, " ").replace(/[^A-Za-z0-9]+/g, " ").trim().length === 0;
const speech = segs.filter((s) => !isEmpty(s.text));
const speechIdx = new Set(speech.map((s) => s.index));

const opts = { mode: flag("mode", "tight") };
for (const k of ["head", "sim", "lookback", "windowSec", "stutter", "shortWords", "fragNeighbors", "fragSec"]) {
  const v = num(k, null); if (v != null) opts[k] = v;
}
const t0 = process.hrtime.bigint();
const { decisions, groups, escalate } = analyzeRuns(speech, opts);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const cut = new Set(decisions.filter((d) => d.decision === "cut").map((d) => d.index));

const gCut = new Set([...goldenCut].filter((i) => speechIdx.has(i)));
let TP = 0, FP = 0, FN = 0;
const missed = [], over = [];
for (const s of speech) {
  const g = gCut.has(s.index), a = cut.has(s.index);
  if (g && a) TP++; else if (!g && a) { FP++; over.push(s); } else if (g && !a) { FN++; missed.push(s); }
}
const p = TP / (TP + FP || 1), r = TP / (TP + FN || 1), f1 = (2 * p * r) / (p + r || 1);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// Beat-level: what the user feels. Kept more than golden = duplicates still on the
// timeline; kept fewer = good content lost. Ignores WHICH identical take was kept.
const beat = new Map();
for (const s of speech) {
  const b = beatOf.get(s.index); if (!b) continue;
  const key = b.range.join("-");
  const st = beat.get(key) || { g: 0, a: 0 };
  if (!goldenCut.has(s.index)) st.g++;
  if (!cut.has(s.index)) st.a++;
  beat.set(key, st);
}
let leftover = 0, lost = 0, dirty = 0, overB = 0;
for (const st of beat.values()) { const d = st.a - st.g; if (d > 0) { leftover += d; dirty++; } else if (d < 0) { lost += -d; overB++; } }

console.log(`\n${C.b("══ Deterministic retake eval ══")} fixture=${fixture} speech=${speech.length} ${C.dim(`(${ms.toFixed(1)}ms, 0 tokens, 0 API calls)`)}`);
console.log(`golden cuts ${gCut.size}   detector cuts ${cut.size}   groups ${groups.length}`);
console.log(`${C.b("recall")}    ${pct(r)} ${C.dim(`(caught ${TP}/${gCut.size} real retakes)`)}`);
console.log(`${C.b("precision")} ${pct(p)} ${C.dim(`(${FP} over-cuts)`)}`);
console.log(`${C.b("F1")}        ${pct(f1)}`);
console.log(`\n${C.b("── beat-level (the user-facing score) ──")}`);
console.log(`${C.b("leftover duplicates")}: ${leftover} ${C.dim(`across ${dirty} beats`)}`);
console.log(`${C.b("lost good content")}:    ${lost} ${C.dim(`across ${overB} beats`)}`);

const escSegs = escalate.reduce((a, g) => a + g.indices.length, 0);
const escWords = escalate.reduce((a, g) => a + g.indices.reduce((w, i) => w + (speech.find((s) => s.index === i)?.text.split(/\s+/).length || 0), 0), 0);
const escErrors = escalate.reduce((a, g) => a + g.indices.filter((i) => gCut.has(i) !== cut.has(i)).length, 0);
console.log(`\n${C.b("── LLM escalation")} (mode=${opts.mode}) ──`);
console.log(`${escalate.length} ambiguous group(s), ${escSegs} segments (${pct(escSegs / speech.length)} of the timeline), ~${Math.round(escWords * 1.4)} tokens = one small call`);
console.log(C.dim(`covers ${escErrors}/${missed.length + over.length} of the detector's disagreements with golden`));

if (verbose) {
  console.log(`\n${C.red(C.b(`✗ MISSED (${missed.length})`))}${C.dim(" golden=cut, detector kept:")}`);
  for (const s of missed) console.log(`  ${C.dim(`[${s.index}] ${s.time}`)} ${s.text.slice(0, 92)}`);
  console.log(`\n${C.yel(C.b(`⚠ OVER-CUT (${over.length})`))}${C.dim(" golden=keep, detector cut:")}`);
  for (const s of over) console.log(`  ${C.dim(`[${s.index}] ${s.time}`)} ${s.text.slice(0, 92)}`);
}
console.log("");
