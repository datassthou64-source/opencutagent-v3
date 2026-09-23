export const REVIEW_SENTINEL = 'OpenCutAgent:RetakeReview:v1';

const SUGGESTED_CUT = new Set(['Audio boundary', 'Dependent edit', 'Final plan']);
const JOIN = new Set(['Audio boundary', 'Dependent edit']);
/** Short marker text; the confidence level is always in the name. */
export function markerLabel(d) {
  if (Number(d.group) >= 100000) return { name: 'Stutter? (low)', note: 'Possible stutter. Could not cut cleanly.' };
  if (SUGGESTED_CUT.has(d.category) || d.replacements?.length) {
    if (d.confidence === 'low') return { name: 'Remove? (low)', note: 'Unsure retake.' };
    if (d.confidence === 'medium' && !JOIN.has(d.category)) return { name: 'Remove? (medium)', note: 'Likely retake.' };
    if (JOIN.has(d.category)) return { name: 'Remove? (check join)', note: 'Retake. The cut point has sound on it.' };
    return { name: 'Remove?', note: 'Suggested cut.' };
  }
  if (d.category === 'Distant repetition') return { name: 'Pending review', note: 'Possible repeat.' };
  if (d.category === 'Timeline layout') return { name: 'Pending review', note: 'Layout not supported.' };
  return { name: 'Pending review', note: 'Possible retake.' };
}

/** Map retained portions through the exact, verified removal map. Never use stale ruler times. */
export function planReviewMarkers(deferred, words, before, removedFrames = []) {
  const fps = 254016000000 / Number(before.sequence.timebase);
  const cuts = removedFrames.map(r => ({ a: r.startFrame / fps, b: r.endFrame / fps }));
  const shift = t => t - cuts.filter(c => c.b <= t).reduce((n, c) => n + c.b - c.a, 0);
  const seen = new Set(), markers = [];
  for (const d of deferred) {
    const first = words[d.startWord], last = words[d.endWord];
    const a = Number.isFinite(d.startSec) ? d.startSec : first?.startSec;
    const b = Number.isFinite(d.endSec) ? d.endSec : last?.endSec;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    let parts = [{ a, b: Math.max(b, a + 1 / fps) }];
    for (const cut of cuts) parts = parts.flatMap(p => {
      if (cut.b <= p.a || cut.a >= p.b) return [p];
      return [...(p.a < cut.a ? [{ a: p.a, b: cut.a }] : []), ...(cut.b < p.b ? [{ a: cut.b, b: p.b }] : [])];
    });
    for (const p of parts) {
      const startSec = shift(p.a), endSec = shift(p.b);
      const key = `${startSec.toFixed(6)}:${endSec.toFixed(6)}:${d.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Short editor-facing labels only; the full reason lives in the panel and diagnostics.
      const { name, note } = markerLabel(d);
      markers.push({ startSec, endSec, name, colorIndex: 2, comment: `${REVIEW_SENTINEL}\n${note}` });
    }
  }
  return markers;
}
