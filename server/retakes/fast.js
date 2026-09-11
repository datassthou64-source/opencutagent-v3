// The fast retake path: deterministic detection first (server/retakes/detect.js),
// then ONE small Claude call over only the groups the detector is unsure about.
//
// Replaces the old shape of the problem. `analyzeRetakes` (server/ai.js) mails every
// speech segment of the timeline to `claude -p` in ~12-24 windowed calls at high effort:
// measured on this user's own log, 842 segments took 24 calls / 6m53s / 112k output
// tokens. Most of those segments are unique forward-moving speech with no duplicate
// anywhere near them, and the dominant question ("the speaker restarted this line four
// times, keep the last full pass") is decided by comparing words, not by reasoning.
//
// So: Tier 0 decides everything it can see plainly, Tier 1 spends the model only on
// genuine ambiguity (no clean take in the run; or two clean takes that might be two
// different points rather than a restart).
import { analyzeCertainRetakes, analyzeRuns } from "./detect.js";
import { askClaude } from "../ai.js";
import { liveEnv } from "../config.js";
import { recordUsage } from "../usage.js";
import { mmss } from "../tools/util.js";

function intEnv(name, def) {
  const v = parseInt(liveEnv(name) || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * Which engine "Analyze w/ Claude" uses:
 *   fast (default)  detection only. No model at all: milliseconds, zero tokens.
 *   hybrid          detection + one small call on the groups detection is unsure about.
 *   ai              the original chunked whole-timeline path (reference/fallback)
 *
 * Why "fast" is the default: a headless `claude -p` call has a floor of roughly 20-30s
 * on this setup no matter how small the question, so on a 40 second clip the AI tier
 * costs 100x what it decides. Detection is safe on its own (it only cuts a take that
 * something else repeats), so the model is opt-in for when a timeline is worth a second
 * opinion rather than a toll on every click.
 */
export function retakeMode(params = {}) {
  const raw = String(params.retake_mode || liveEnv("EDITAGENT_RETAKE_MODE") || "fast").toLowerCase();
  return ["hybrid", "fast", "ai"].includes(raw) ? raw : "fast";
}

export const GROUP_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group: { type: "integer" },
          keep: { type: "array", items: { type: "integer" } },
          reason: { type: "string" },
        },
        required: ["group", "keep"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

/**
 * System prompt for Tier 1. Deliberately ~15x smaller than retakeSystem(): the model is
 * no longer being taught to FIND retakes across a whole timeline, only to pick the
 * keeper inside a handful of already-grouped runs.
 */
export function groupSystem() {
  return [
    "You are the analysis engine inside OpenCutAgent, a video editing panel for Adobe Premiere Pro.",
    "You are running non-interactively with NO tools and NO file access. Read the data in the user's message and return ONLY the structured JSON the schema requires.",
    "Each group below is one moment in a raw talking-head recording where the speaker appears to have re-recorded the same line several times. A grouping algorithm already found them; your job is only to say which take(s) of each group to KEEP.",
    "Rules:",
    "1. If the takes are restarts of ONE line, keep exactly the last complete, fluent pass. A restart re-attempts the SAME words.",
    "2. If the takes actually move FORWARD with NEW content (different points that happen to open alike), keep ALL of them. This is why the group was flagged.",
    "3. If no single take is clean, keep the FEWEST consecutive takes that together read as one fluent line (a clean first half plus a clean second half).",
    "4. A take that ends mid-word, in a dash, or trails off is almost never the keeper unless the next kept take continues it.",
    "Some groups are a single unfinished-looking line plus its neighbours. There the question is only: did the speaker abandon that line and start over (cut it), or is it half of the sentence beside it that the transcript split on a breath (keep it)? Lines marked (context) are shown for that judgment only and must never appear in your answer.",
    "Return one entry per group with the indices to keep. Everything you do not list is cut.",
  ].join("\n");
}

/** Render the flagged groups as the model sees them. */
export function groupPrompt(groups, byIndex) {
  const lines = [];
  for (const g of groups) {
    lines.push(`group ${g.group}:`);
    const shown = new Set();
    for (const i of [...g.indices, ...(g.context || [])].sort((a, b) => a - b)) {
      if (shown.has(i)) continue;
      shown.add(i);
      const s = byIndex.get(i);
      if (!s) continue;
      // Context lines are shown so a fragment can be judged against what surrounds it,
      // but they belong to other groups, so they are never up for decision here.
      const tag = g.indices.includes(i) ? "" : "  (context, not yours to decide)";
      lines.push(`  [${i}] ${mmss(s.startSec)} ${s.text}${tag}`);
    }
  }
  return [
    `${groups.length} group(s) of possible re-takes. For each, return the indices to KEEP.`,
    "Keep one take when they are restarts of the same line; keep several only when they are genuinely different points.",
    "",
    ...lines,
  ].join("\n");
}

/** Pack groups into calls capped at `maxSegs` segments each (keeps one call small). */
export function planGroupBatches(groups, maxSegs) {
  const batches = [];
  let cur = [];
  let n = 0;
  for (const g of groups) {
    if (cur.length && n + g.indices.length > maxSegs) { batches.push(cur); cur = []; n = 0; }
    cur.push(g);
    n += g.indices.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Run async tasks with at most `limit` in flight, preserving order. */
async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/**
 * Tier 1: ask Claude which take to keep, for the flagged groups only.
 * @returns {Promise<Map<number, Set<number>>>} group id -> indices to keep
 */
export async function reviewAmbiguousGroups(groups, segs, { model, effort, token, onProgress = () => {} } = {}) {
  const keepByGroup = new Map();
  if (!groups.length) return keepByGroup;
  const byIndex = new Map(segs.map((s) => [s.index, s]));
  const batches = planGroupBatches(groups, intEnv("EDITAGENT_RETAKE_GROUP_BATCH", 120));
  const system = groupSystem();
  const startedAt = Date.now();
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (token && !token.children) token.children = new Set();

  const tasks = batches.map((batch, bi) => async () => {
    if (token && token.aborted) return;
    const { data, raw } = await askClaude({
      prompt: groupPrompt(batch, byIndex),
      system,
      schema: GROUP_SCHEMA,
      model,
      effort,
      token,
      inlineSystem: true, // keeps the CLI's cached prefix; see askClaude's note
    });
    stats.calls += 1;
    stats.inputTokens += (raw.usage && raw.usage.input_tokens) || 0;
    stats.outputTokens += (raw.usage && raw.usage.output_tokens) || 0;
    if (batches.length > 1) onProgress(`Reviewed ${bi + 1}/${batches.length} batch(es) of unclear groups.`);
    const valid = new Map(batch.map((g) => [g.group, new Set(g.indices)]));
    for (const r of data.groups || []) {
      const allowed = valid.get(r.group);
      if (!allowed) continue; // a group id we didn't ask about
      const keep = (r.keep || []).filter((i) => allowed.has(i)); // context indices are ignored
      // An empty answer would cut the entire beat; a group always keeps something.
      if (keep.length) keepByGroup.set(r.group, new Set(keep));
    }
  });

  await pool(tasks, Math.max(1, intEnv("EDITAGENT_RETAKE_GROUP_CONCURRENCY", 2)));
  if (token && token.aborted) throw new Error("Cancelled");
  recordUsage({
    type: "claude",
    purpose: "Retake analysis (fast path)",
    model: model || "latest",
    effort: effort || null,
    segments: groups.reduce((a, g) => a + g.indices.length, 0),
    calls: stats.calls,
    durationMs: Date.now() - startedAt,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    costUsd: 0,
  });
  return keepByGroup;
}

/**
 * The whole fast path. Same input and output contract as ai.js analyzeRetakes, so the
 * caller only chooses which one to call.
 *
 * @param {Array} speechSegs  [{index, startSec, text}] (empties already removed)
 * @returns {Promise<{decisions, stats}>} decisions = [{index, decision:"cut", group, reason}]
 */
export async function analyzeRetakesFast(speechSegs, { mode = "hybrid", model, effort, token, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const { decisions, groups, escalate } = analyzeRuns(speechSegs, {
    mode: String(liveEnv("EDITAGENT_RETAKE_ESCALATE") || "tight").toLowerCase() === "wide" ? "wide" : "tight",
  });
  const certainDecisions = mode === "fast" ? analyzeCertainRetakes(speechSegs) : decisions;
  const detectMs = Date.now() - t0;
  const runGroups = groups.filter((g) => g.kind === "retakes");
  const certainIndices = new Set(certainDecisions.map((d) => d.index));
  const possibleGroupIds = new Set(
    decisions.filter((d) => !certainIndices.has(d.index)).map((d) => d.group)
  );
  // Do not count every punctuation-less singleton as a "possible group". Long
  // transcripts contain hundreds of those because phrase segmentation happens
  // at breaths; only count groups where the broader detector proposed a cut.
  const reviewGroups = mode === "fast" ? possibleGroupIds.size : 0;

  if (mode === "fast") {
    onProgress(
      `Found ${certainDecisions.length} certain retake(s) in ${detectMs}ms. ` +
      `${reviewGroups} possible group(s) were left untouched for review; no AI call.`
    );
  } else {
    onProgress(
      `Found ${decisions.length} duplicate take(s) across ${runGroups.length} group(s) in ${detectMs}ms, no AI needed.`
    );
  }

  const stats = {
    detectMs,
    groups: runGroups.length,
    fastCuts: certainDecisions.length,
    candidateCuts: decisions.length,
    reviewGroups,
    escalated: mode === "fast" ? 0 : escalate.length,
    escalatedSegments: mode === "fast" ? 0 : escalate.reduce((a, g) => a + g.indices.length, 0),
    reviewed: 0,
    changed: 0,
  };

  if (mode === "fast") {
    onProgress(
      reviewGroups
        ? `Done. ${reviewGroups} possible group(s) stayed Keep because the evidence was not certain.`
        : "Done. Only direct, high-confidence repeats were cut."
    );
    return { decisions: certainDecisions, stats };
  }

  if (!escalate.length) {
    onProgress("Done. Nothing ambiguous to review.");
    return { decisions, stats };
  }

  onProgress(`Asking Claude about ${escalate.length} unclear group(s) (${stats.escalatedSegments} segments)…`);
  const keepByGroup = await reviewAmbiguousGroups(escalate, speechSegs, { model, effort, token, onProgress });
  stats.reviewed = keepByGroup.size;

  // Claude's answer REPLACES the detector's decisions for the groups it reviewed.
  const byId = new Map(groups.map((g) => [g.group, g]));
  const merged = decisions.filter((d) => !keepByGroup.has(d.group));
  for (const [gid, keep] of keepByGroup) {
    const g = byId.get(gid);
    if (!g) continue;
    const before = decisions.filter((d) => d.group === gid).map((d) => d.index).sort().join(",");
    for (const i of g.indices) {
      if (keep.has(i)) continue;
      merged.push({ index: i, decision: "cut", group: gid, reason: "duplicate take" });
    }
    const after = merged.filter((d) => d.group === gid).map((d) => d.index).sort().join(",");
    if (before !== after) stats.changed += 1;
  }
  // A group Claude was asked about but didn't answer keeps the detector's call:
  // its decisions were never filtered out of `merged` above.
  merged.sort((a, b) => a.index - b.index);
  const dedup = new Map();
  for (const d of merged) if (!dedup.has(d.index)) dedup.set(d.index, d);
  return { decisions: [...dedup.values()], stats };
}
