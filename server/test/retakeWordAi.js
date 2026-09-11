// Pure + stubbed-oracle checks for Retake V2 AI-Lite.
import {
  DISCOVERY_SCHEMA,
  analyzeRetakesWordAi,
  buildPrecisionGroups,
  discoveryPrompt,
  normalizeDiscoveryGroups,
  normalizeWordCuts,
  planPrecisionBatches,
  planWordAiChunks,
  precisionPrompt,
} from "../retakes/word-ai.js";

let failures = 0;
function check(label, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

const words = [];
const sentences = [];
for (let s = 0; s < 6; s++) {
  const startWord = words.length;
  words.push(
    { index: words.length, text: `word${s}a`, clipKey: "0:V1" },
    { index: words.length + 1, text: `word${s}b.`, clipKey: "0:V1" },
  );
  sentences.push({
    index: s, startWord, endWord: startWord + 1,
    startSec: s * 2, endSec: s * 2 + 1, text: `word${s}a word${s}b.`,
  });
}

const chunks = planWordAiChunks(sentences, 4, 2);
check("word budget creates three owner chunks", chunks.length === 3, chunks);
const owners = chunks.flatMap((c) => Array.from({ length: c.ownEnd - c.ownStart }, (_, i) => c.ownStart + i));
check("every sentence is owned exactly once", owners.join(",") === "0,1,2,3,4,5", owners);
check("middle chunk receives context on both sides", chunks[1].ctxStart === 1 && chunks[1].ctxEnd === 5, chunks[1]);

const prompt = discoveryPrompt(sentences, chunks[1]);
check("discovery prompt labels owner and context", prompt.includes("S2-S3") && prompt.includes("CONTEXT") && prompt.includes("OWNER"), prompt);
check("discovery prompt includes every sentence in its context window", [1, 2, 3, 4].every((i) => prompt.includes(`[S${i} `)), prompt);

const normalized = normalizeDiscoveryGroups([
  { groups: [{ startSentence: 0, endSentence: 2, reason: "restart" }] },
  { groups: [
    { startSentence: 1, endSentence: 2, reason: "context duplicate" }, // rejected: S1 is not owned here
    { startSentence: 2, endSentence: 3, reason: "same event" },
  ] },
  { groups: [] },
], chunks, sentences);
check("context-originated duplicate is rejected", normalized.length === 1, normalized);
check("overlapping discovery ranges merge for one precision review", normalized[0].startPos === 0 && normalized[0].endPos === 3, normalized[0]);

const precisionGroups = buildPrecisionGroups(normalized, sentences, words);
check("precision group keeps a strict allowed word range", precisionGroups[0].startWord === 0 && precisionGroups[0].endWord === 7, precisionGroups[0]);
check("precision context contains stable word ids", precisionGroups[0].text.includes("[W0]word0a") && precisionGroups[0].text.includes("[W9]word4b."), precisionGroups[0].text);
check("precision prompt states the allowed boundary", precisionPrompt(precisionGroups).includes("ALLOWED W0-W7"), precisionPrompt(precisionGroups));
check("precision batches keep an oversized group intact", planPrecisionBatches(precisionGroups, 2).length === 1, planPrecisionBatches(precisionGroups, 2));

const safeCuts = normalizeWordCuts([
  { group: 0, startWord: 3, endWord: 2, reason: "false start" },
  { group: 0, startWord: 7, endWord: 9, reason: "tries to cut context" },
  { group: 99, startWord: 0, endWord: 1, reason: "unknown group" },
], precisionGroups, words);
check("reversed in-range word cut is normalized", safeCuts.length === 1 && safeCuts[0].startWord === 2 && safeCuts[0].endWord === 3, safeCuts);
check("context and unknown-group cuts are rejected", safeCuts.length === 1, safeCuts);

// End-to-end orchestration with a fake Claude oracle: one full-transcript discovery
// call, then one exact-word call. This verifies the production data contract without
// consuming tokens in the test suite.
{
  const calls = [];
  let usage = null;
  const ask = async (req) => {
    calls.push(req);
    if (req.schema === DISCOVERY_SCHEMA) {
      return {
        data: { groups: [{ startSentence: 0, endSentence: 1, reason: "repeated opening" }] },
        raw: { usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 3 } },
      };
    }
    return {
      data: { cuts: [{ group: 0, startWord: 0, endWord: 1, reason: "abandoned first take" }] },
      raw: { usage: { input_tokens: 5, output_tokens: 2 } },
    };
  };
  const result = await analyzeRetakesWordAi(words, sentences, { ask, record: (e) => { usage = e; } });
  check("AI-Lite performs discovery then precision", calls.length === 2, calls.map((c) => c.schema));
  check("full transcript appears in discovery call", sentences.every((s) => calls[0].prompt.includes(`[S${s.index} `)), calls[0].prompt);
  check("AI result becomes an exact accepted V2 suggestion", result.suggestions.length === 1 && result.suggestions[0].startWord === 0 && result.suggestions[0].endWord === 1 && result.suggestions[0].accepted, result.suggestions);
  check("usage includes cached input tokens honestly", usage && usage.inputTokens === 35 && usage.outputTokens === 5 && usage.calls === 2, usage);
}

console.log(failures === 0 ? "\nAll Retake V2 AI-Lite checks passed." : `\n${failures} Retake V2 AI-Lite check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
