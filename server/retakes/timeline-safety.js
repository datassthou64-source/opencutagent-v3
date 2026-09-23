import { createHash } from 'node:crypto';

export function geometry(timeline) {
  return timeline.clips.map(c => ({
    trackType: c.trackType, trackIndex: c.trackIndex, mediaPath: c.mediaPath,
    start: String(c.start.ticks), end: String(c.end.ticks),
    sourceIn: String(c.sourceIn.ticks), sourceOut: String(c.sourceOut.ticks),
  })).sort((a, b) => a.trackType.localeCompare(b.trackType) || a.trackIndex - b.trackIndex || (BigInt(a.start) < BigInt(b.start) ? -1 : BigInt(a.start) > BigInt(b.start) ? 1 : 0));
}
export function timelineFingerprint(timeline) {
  return createHash('sha256').update(JSON.stringify({
    sequence: timeline.sequence,
    clips: timeline.clips.map(c => ({ ...c, name: undefined })),
  })).digest('hex');
}

/**
 * Clips whose audio is the transcript: the camera video's own media when it has any,
 * otherwise the lowest populated audio track (e.g. A1 under a nested/multicam V1).
 */
export function transcriptSourceClips(timeline) {
  const video = timeline.clips.filter(c => c.hasMedia && c.trackType === 'video');
  if (video.length) return video;
  const audio = timeline.clips.filter(c => c.hasMedia && c.trackType === 'audio');
  if (!audio.length) return [];
  const lowest = Math.min(...audio.map(c => c.trackIndex));
  return audio.filter(c => c.trackIndex === lowest);
}

/**
 * Cuts are whole timeline frame ranges razored and lifted on EVERY track, then closed by
 * one uniform shift, so sync holds for any track layout. What the engine cannot do safely
 * is retimed, reversed, transitioned, locked, disabled or overlapping clips, or items that
 * are neither source media nor a nested sequence (titles, generators, adjustment layers).
 */
export function requireSimpleTimeline(timeline) {
  const seq = timeline.sequence;
  if (!seq.id || seq.captionTrackCount !== 0) throw new Error('Auto retakes require a sequence without caption tracks and a current host script. Reload the panel.');
  if (!transcriptSourceClips(timeline).length) throw new Error('Auto retakes need a video or audio track with source media to transcribe. Use Analyze retakes for other layouts.');
  const tb = BigInt(seq.timebase);
  for (const c of timeline.clips) {
    const where = `${c.track || c.trackType + (c.trackIndex + 1)} "${c.name || ''}"`;
    if (!c.hasMedia && !c.isNested) throw new Error(`Auto retakes can only cut source media or nested sequences; ${where} is neither (title, graphic or adjustment layer?). Use Analyze retakes.`);
    if (!c.speedIsNormal || c.speedReversed !== false) throw new Error(`Auto retakes require 100% forward speed; ${where} is retimed. Use Analyze retakes.`);
    if (c.trackLocked !== false || c.disabled !== false) throw new Error(`Auto retakes require unlocked, enabled clips; ${where} is locked or disabled.`);
    if (c.transitionCount !== 0) throw new Error(`Auto retakes require tracks without transitions; ${where} has one.`);
    if (BigInt(c.end.ticks) - BigInt(c.start.ticks) !== BigInt(c.sourceOut.ticks) - BigInt(c.sourceIn.ticks)) throw new Error("Retimed source ranges need manual review.");
    if ([c.start, c.end].some(t => BigInt(t.ticks) % tb !== 0n)) throw new Error('Auto retakes require frame-aligned clip edges.');
  }
  const byTrack = new Map();
  for (const c of timeline.clips) {
    const k = c.trackType + c.trackIndex;
    if (!byTrack.has(k)) byTrack.set(k, []);
    byTrack.get(k).push(c);
  }
  for (const clips of byTrack.values()) {
    clips.sort((a, b) => a.start.seconds - b.start.seconds);
    for (let i = 1; i < clips.length; i++) {
      if (BigInt(clips[i].start.ticks) < BigInt(clips[i - 1].end.ticks)) throw new Error('Overlapping clips need manual review.');
    }
  }
}

/** Exact expected geometry for lift or ripple, used BEFORE the next mutation. */
export function expectedGeometry(timeline, frames, ripple) {
  const tb = BigInt(timeline.sequence.timebase);
  const cuts = frames.map(r => ({ a: BigInt(r.startFrame) * tb, b: BigInt(r.endFrame) * tb }));
  const result = [];
  for (const c of timeline.clips) {
    const origin = BigInt(c.start.ticks), end = BigInt(c.end.ticks), source = BigInt(c.sourceIn.ticks);
    let spans = [{ a: origin, b: end }];
    for (const cut of cuts) spans = spans.flatMap(s => {
      if (cut.b <= s.a || cut.a >= s.b) return [s];
      const parts = [];
      if (s.a < cut.a) parts.push({ a: s.a, b: cut.a });
      if (cut.b < s.b) parts.push({ a: cut.b, b: s.b });
      return parts;
    });
    for (const s of spans) {
      const shift = ripple ? cuts.filter(r => r.b <= s.a).reduce((sum, r) => sum + r.b - r.a, 0n) : 0n;
      result.push({ ...c, start: { ticks: String(s.a - shift) }, end: { ticks: String(s.b - shift) },
        sourceIn: { ticks: String(source + s.a - origin) }, sourceOut: { ticks: String(source + s.b - origin) } });
    }
  }
  return geometry({ clips: result });
}
