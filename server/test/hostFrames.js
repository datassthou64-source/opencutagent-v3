// Execute the real ExtendScript host file in a tiny Premiere-shaped VM. This
// regression targets the black-frame failure directly: a downstream clip starts
// on the right nominal frame but carries a subframe tick residue. Closing a
// 10-frame cut must land it on the exact target tick, not preserve the residue.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TPS = 254016000000;
const TB = TPS / 30;
let failures = 0;

function check(label, condition, got) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!condition) failures++;
}

class Time {
  constructor(ticks = 0) { this._ticks = Number(ticks); }
  get ticks() { return String(this._ticks); }
  set ticks(value) { this._ticks = Number(value); }
  get seconds() { return this._ticks / TPS; }
  set seconds(value) { this._ticks = Math.round(Number(value) * TPS); }
}

function clip(startTicks, endTicks) {
  return {
    name: "clip",
    start: new Time(startTicks),
    end: new Time(endTicks),
    inPoint: new Time(startTicks),
    outPoint: new Time(endTicks),
    move(delta) {
      const ticks = Number(delta.ticks);
      this.start.ticks = Number(this.start.ticks) + ticks;
      this.end.ticks = Number(this.end.ticks) + ticks;
    },
  };
}

function items(values) {
  const out = {};
  Object.defineProperty(out, "numItems", { get: () => values.length });
  values.forEach((value, index) => { out[index] = value; });
  return out;
}

function tracks(values) {
  const out = { numTracks: values.length };
  values.forEach((value, index) => { out[index] = value; });
  return out;
}

const residue = 1234;
const left = clip(0, 20 * TB);
const right = clip(30 * TB + residue, 100 * TB + residue);
const sequence = {
  timebase: String(TB),
  zeroPoint: "0",
  name: "Frame test",
  videoDisplayFormat: 104,
  videoTracks: tracks([{ clips: items([left, right]) }]),
  audioTracks: tracks([]),
};

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../cep-panel/host/premiere.jsx"), "utf8");
const context = vm.createContext({ $, Time, app: { project: { activeSequence: sequence } } });
function $() {}
vm.runInContext(source, context, { filename: "premiere.jsx" });

const response = JSON.parse(context.$.editagent.dispatch("closeRangeGaps", {
  ranges: [{ startFrame: 20, endFrame: 30 }],
}));
const result = response.result;

check("host closeRangeGaps succeeds", response.status === "OK" && result.ok === true, response);
check("downstream start lands on the exact target frame tick", Number(right.start.ticks) === 20 * TB, right.start.ticks);
check("subframe residue is removed from the downstream end too", Number(right.end.ticks) === 90 * TB, right.end.ticks);
check("host reports one verified frame placement", result.moved === 1 && result.failed === 0 && result.misaligned === 0, result);

// 29.97 sequences can use either ruler. The display enum, not fps alone,
// decides whether timecodes are drop-frame.
sequence.timebase = String((TPS * 1001) / 30000);
sequence.videoDisplayFormat = 103;
const ndf = JSON.parse(context.$.editagent.dispatch("getTimelineState", {}));
check("29.97 non-drop display stays non-drop", ndf.result.sequence.dropFrame === false, ndf.result.sequence);
sequence.videoDisplayFormat = 102;
const df = JSON.parse(context.$.editagent.dispatch("getTimelineState", {}));
check("29.97 drop display is detected as drop-frame", df.result.sequence.dropFrame === true, df.result.sequence);

console.log(failures === 0 ? "\nAll host frame-grid checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
