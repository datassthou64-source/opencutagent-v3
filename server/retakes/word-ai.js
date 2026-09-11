// Retake V2's AI-Lite path: every sentence is reviewed by Claude once, but only
// suspicious passages are sent through the more verbose word-indexed precision pass.
// The result plugs directly into Retake V2's existing {startWord,endWord} UI/apply path.
import { askClaude } from "../ai.js";
import { liveEnv } from "../config.js";
import { recordUsage } from "../usage.js";
import { mmss } from "../tools/util.js";

function intEnv(name, fallback) {
  const n = parseInt(liveEnv(name) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sentenceWords(s) {
  return Math.max(1, Number(s.endWord) - Number(s.startWord) + 1);
}

/**
 * Plan word-budgeted owner windows with context on each side. Every sentence is
 * owned exactly once; overlap is context only, so a retake crossing a boundary
 * is still visible without making two calls authoritative for the same passage.
 */
export function planWordAiChunks(sentences, ownerWords = 900, contextWords = 120) {
  const out = [];
  const n = (sentences || []).length;
  for (let ownStart = 0; ownStart < n;) {
    let ownEnd = ownStart;
    let used = 0;
    while (ownEnd < n) {
      const add = sentenceWords(sentences[ownEnd]);
      if (ownEnd > ownStart && used + add > ownerWords) break;
      used += add;
      ownEnd++;
    }

    let ctxStart = ownStart;
    let before = 0;
    while (ctxStart > 0 && before < contextWords) {
      ctxStart--;
      before += sentenceWords(sentences[ctxStart]);
    }
    let ctxEnd = ownEnd;
    let after = 0;
    while (ctxEnd < n && after < contextWords) {
      after += sentenceWords(sentences[ctxEnd]);
      ctxEnd++;
    }
    out.push({ ownStart, ownEnd, ctxStart, ctxEnd });
    ownStart = ownEnd;
  }
  return out;
}

export const DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startSentence: { type: "integer" },
          endSentence: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["startSentence", "endSentence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

export const WORD_CUT_SCHEMA = {
  type: "object",
  properties: {
    cuts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group: { type: "integer" },
          startWord: { type: "integer" },
          endWord: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["group", "startWord", "endWord", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["cuts"],
  additionalProperties: false,
};

export function discoverySystem() {
  return [
    "You are the retake editor inside OpenCutAgent for Adobe Premiere Pro.",
    "You have no tools. Return only JSON matching the schema.",
    "Review every OWNER sentence. Find possible re-recorded takes, false starts, abandoned attempts, repeated lines, stutters, and standalone spoken filler that should be removed from a raw talking-head recording.",
    "A retake repeats or re-attempts the same idea nearby; new forward-moving content must stay. Prefer the last complete fluent take, but this pass only identifies suspicious passages—the next pass chooses exact words.",
    "Be inclusive about plausible retakes, but never flag unique finished content merely because it shares common opening words.",
    "Return sentence ranges covering the whole local retake event, including the failed and successful takes. Report a group only when its FIRST suspicious sentence is in the OWNER range. CONTEXT exists only to resolve events crossing a boundary.",
  ].join("\n");
}

export function discoveryPrompt(sentences, chunk) {
  const ownerFirst = sentences[chunk.ownStart];
  const ownerLast = sentences[chunk.ownEnd - 1];
  const lines = [];
  for (let i = chunk.ctxStart; i < chunk.ctxEnd; i++) {
    const s = sentences[i];
    const owner = i >= chunk.ownStart && i < chunk.ownEnd ? "OWNER" : "CONTEXT";
    lines.push(`[S${s.index} W${s.startWord}-${s.endWord} ${mmss(s.startSec)} ${owner}] ${s.text}`);
  }
  return [
    `Discovery pass. Review all OWNER sentences S${ownerFirst.index}-S${ownerLast.index}.`,
    "Return only suspicious retake-event ranges. An empty groups array is valid.",
    "Transcript:",
    lines.join("\n"),
  ].join("\n");
}

function sentencePositionMap(sentences) {
  return new Map((sentences || []).map((s, pos) => [s.index, pos]));
}

/** Validate owner-scoped model output and merge duplicate/overlapping event ranges. */
export function normalizeDiscoveryGroups(perChunk, chunks, sentences) {
  const pos = sentencePositionMap(sentences);
  const ranges = [];
  for (let ci = 0; ci < perChunk.length; ci++) {
    const chunk = chunks[ci];
    for (const g of (perChunk[ci] && perChunk[ci].groups) || []) {
      let a = pos.get(g.startSentence);
      let b = pos.get(g.endSentence);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      if (a > b) { const t = a; a = b; b = t; }
      // One owner decides each event. This prevents overlap context from doubling it.
      if (a < chunk.ownStart || a >= chunk.ownEnd) continue;
      b = Math.min(b, chunk.ctxEnd - 1);
      ranges.push({ startPos: a, endPos: b, reason: String(g.reason || "possible retake") });
    }
  }
  ranges.sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.startPos <= last.endPos) last.endPos = Math.max(last.endPos, r.endPos);
    else merged.push({ ...r });
  }
  return merged.map((r, group) => ({ ...r, group }));
}

export function precisionSystem() {
  return [
    "You are making exact transcript cuts for Retake V2 in OpenCutAgent.",
    "You have no tools. Return only JSON matching the schema.",
    "Each group is a passage already flagged by a full-transcript AI review. Decide the exact inclusive WORD ranges to remove.",
    "Cut failed/abandoned takes, repeated versions of a line, mid-line restarts, unwanted stutters, and standalone spoken filler. Keep the final complete fluent version and all genuinely new forward-moving content.",
    "Use the narrowest natural word boundaries. You may return several cuts per group. Never cut CONTEXT words or words outside the group's ALLOWED range. If the first pass was mistaken, return no cut for that group.",
  ].join("\n");
}

function wordText(words, start, end) {
  const out = [];
  for (let i = start; i <= end; i++) {
    const w = words[i];
    if (w) out.push(`[W${w.index}]${w.text}`);
  }
  return out.join(" ");
}

export function buildPrecisionGroups(groups, sentences, words) {
  return (groups || []).map((g) => {
    const first = sentences[g.startPos];
    const last = sentences[g.endPos];
    const ctxStartPos = Math.max(0, g.startPos - 1);
    const ctxEndPos = Math.min(sentences.length - 1, g.endPos + 1);
    return {
      ...g,
      startWord: first.startWord,
      endWord: last.endWord,
      contextStartWord: sentences[ctxStartPos].startWord,
      contextEndWord: sentences[ctxEndPos].endWord,
      wordCount: sentences[ctxEndPos].endWord - sentences[ctxStartPos].startWord + 1,
      text: wordText(words, sentences[ctxStartPos].startWord, sentences[ctxEndPos].endWord),
    };
  });
}

export function planPrecisionBatches(groups, maxWords = 1000) {
  const batches = [];
  let cur = [];
  let used = 0;
  for (const g of groups || []) {
    if (cur.length && used + g.wordCount > maxWords) { batches.push(cur); cur = []; used = 0; }
    cur.push(g);
    used += g.wordCount;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export function precisionPrompt(groups) {
  const lines = [];
  for (const g of groups) {
    lines.push(`group ${g.group}, ALLOWED W${g.startWord}-W${g.endWord}:`);
    lines.push(g.text);
  }
  return [
    "Precision pass. Return exact inclusive word ranges to CUT.",
    "Do not cut a whole group when a smaller failed take or repeated phrase is the actual problem.",
    "Passages:",
    lines.join("\n"),
  ].join("\n");
}

/** Reject unsafe/out-of-group indices, then merge overlapping cuts per group. */
export function normalizeWordCuts(rawCuts, precisionGroups, words) {
  const allowed = new Map(precisionGroups.map((g) => [g.group, g]));
  const cuts = [];
  for (const c of rawCuts || []) {
    const g = allowed.get(c.group);
    let a = Number(c.startWord), b = Number(c.endWord);
    if (!g || !Number.isInteger(a) || !Number.isInteger(b)) continue;
    if (a > b) { const t = a; a = b; b = t; }
    if (a < g.startWord || b > g.endWord || !words[a] || !words[b]) continue;
    cuts.push({ group: g.group, startWord: a, endWord: b, reason: String(c.reason || "retake") });
  }
  cuts.sort((a, b) => a.group - b.group || a.startWord - b.startWord || a.endWord - b.endWord);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && last.group === c.group && c.startWord <= last.endWord + 1) last.endWord = Math.max(last.endWord, c.endWord);
    else merged.push({ ...c });
  }
  return merged;
}

async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

function addUsage(stats, raw) {
  const u = (raw && raw.usage) || {};
  stats.calls += 1;
  // Claude Code often reports cached prompt tokens separately; include them so the
  // panel does not misleadingly claim a 20-token transcript review.
  stats.inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  stats.outputTokens += u.output_tokens || 0;
}

/** Full-transcript AI discovery followed by candidate-only exact word selection. */
export async function analyzeRetakesWordAi(words, sentences, opts = {}) {
  const {
    model = "sonnet", effort = "low", token, onProgress = () => {},
    ask = askClaude, record = recordUsage,
  } = opts;
  if (!(words || []).length || !(sentences || []).length) return { suggestions: [], stats: { calls: 0, groups: 0 } };

  const startedAt = Date.now();
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, discoveryCalls: 0, precisionCalls: 0 };
  if (token && !token.children) token.children = new Set();
  const chunks = planWordAiChunks(
    sentences,
    intEnv("EDITAGENT_RETAKE_V2_CHUNK_WORDS", 900),
    intEnv("EDITAGENT_RETAKE_V2_CONTEXT_WORDS", 120)
  );
  let finished = 0;
  onProgress(`AI-Lite is reviewing the full transcript in ${chunks.length} pass(es)…`);
  const discoveryTasks = chunks.map((chunk) => async () => {
    if (token && token.aborted) return { groups: [] };
    const { data, raw } = await ask({
      prompt: discoveryPrompt(sentences, chunk), system: discoverySystem(), schema: DISCOVERY_SCHEMA,
      model, effort, token, inlineSystem: true,
    });
    addUsage(stats, raw);
    stats.discoveryCalls += 1;
    finished += 1;
    if (chunks.length > 1) onProgress(`AI-Lite reviewed ${finished}/${chunks.length} transcript pass(es)…`);
    return data;
  });
  const discovered = await pool(discoveryTasks, intEnv("EDITAGENT_RETAKE_V2_CONCURRENCY", 4));
  if (token && token.aborted) throw new Error("Cancelled");
  const groups = normalizeDiscoveryGroups(discovered, chunks, sentences);
  const precisionGroups = buildPrecisionGroups(groups, sentences, words);
  const batches = planPrecisionBatches(precisionGroups, intEnv("EDITAGENT_RETAKE_V2_PRECISION_WORDS", 1000));

  let rawCuts = [];
  if (batches.length) {
    onProgress(`AI-Lite found ${groups.length} possible retake passage(s); choosing exact words…`);
    const precisionTasks = batches.map((batch) => async () => {
      if (token && token.aborted) return { cuts: [] };
      const { data, raw } = await ask({
        prompt: precisionPrompt(batch), system: precisionSystem(), schema: WORD_CUT_SCHEMA,
        model, effort, token, inlineSystem: true,
      });
      addUsage(stats, raw);
      stats.precisionCalls += 1;
      return data;
    });
    const refined = await pool(precisionTasks, Math.min(2, intEnv("EDITAGENT_RETAKE_V2_CONCURRENCY", 4)));
    if (token && token.aborted) throw new Error("Cancelled");
    rawCuts = refined.flatMap((r) => (r && r.cuts) || []);
  }

  const cuts = normalizeWordCuts(rawCuts, precisionGroups, words);
  const suggestions = cuts.map((c, id) => ({ id, ...c, accepted: true }));
  const durationMs = Date.now() - startedAt;
  stats.groups = groups.length;
  stats.suggestions = suggestions.length;
  stats.durationMs = durationMs;
  record({
    type: "claude", purpose: "Retake V2 AI-Lite", model, effort,
    segments: sentences.length, calls: stats.calls, durationMs,
    inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, costUsd: 0,
  });
  onProgress(`AI-Lite finished: ${suggestions.length} exact word-range suggestion(s) from ${groups.length} passage(s).`);
  return { suggestions, stats };
}
