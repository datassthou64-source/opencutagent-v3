// Deterministic micro-restart detection ("and the v- and, [clears throat] and the
// universe"). Claude catches these only sometimes, so this runs on every analysis for
// free. Conservative on purpose: the abandoned attempt must contain a cut-off word
// ("the di--"). Plain repeats are left to Claude: on a real 25-min recording a
// "3+ repeated words" rule flagged rhetorical repetition ("You do not get what you want" x3).

const norm = w => String(w?.text || '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const cutOff = w => /[-–—]+$/.test(String(w?.text || '').trim());
const isWord = w => w && w.type !== 'audio_event' && norm(w);

/**
 * Returns [{ startWord, endWord, replacements, reason }]: the abandoned attempt ends right
 * before the restart, and the restart's first words are the replacement evidence.
 */
export function findMicroRestarts(words, { maxSpanWords = 6, maxSpanSec = 3 } = {}) {
  const out = [];
  for (let i = 0; i + 1 < words.length; i++) {
    if (!isWord(words[i]) || !isWord(words[i + 1])) continue;
    for (let j = i + 2; j <= i + maxSpanWords && j + 1 < words.length; j++) {
      const span = words.slice(i, j + 2);
      if (span.some(w => w.clipKey !== words[i].clipKey)) break;
      if (words[j].sourceInSec - words[i].sourceInSec > maxSpanSec) break;
      if (norm(words[i]) !== norm(words[j]) || norm(words[i + 1]) !== norm(words[j + 1])) continue;
      const attempt = words.slice(i, j);
      if (!attempt.some(cutOff)) continue;
      // Walk back along a restart chain anchored on this cut-off attempt:
      // "The four moon phases, the four moon-- the four phases" cuts both earlier tries.
      let start = i;
      for (let k = start - 2; k >= Math.max(0, start - maxSpanWords); k--) {
        if (words[k].clipKey !== words[i].clipKey || words[i].sourceInSec - words[k].sourceInSec > maxSpanSec) break;
        if (/[.?!]["'”’)\]]*$/.test(String(words[k].text || ''))) break; // a finished sentence is content, not a try
        if (norm(words[k]) === norm(words[start]) && norm(words[k + 1]) === norm(words[start + 1])) {
          if (words.slice(k, start).some(w => /[.?!]["'”’)\]]*$/.test(String(w.text || '')))) break;
          start = k;
        }
      }
      if (out.length && start <= out[out.length - 1].endWord) start = out[out.length - 1].endWord + 1;
      out.push({ startWord: start, endWord: j - 1, replacements: [{ startWord: j, endWord: j + 1 }], reason: 'Stutter restart.' });
      i = j - 1;
      break;
    }
  }
  return out;
}
