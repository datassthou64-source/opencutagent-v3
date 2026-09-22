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

/** Current all-track host engine is safe only for this deliberately narrow topology. */
export function requireSimpleTimeline(timeline) {
  const seq = timeline.sequence;
  if (!seq.id || seq.captionTrackCount !== 0) throw new Error('Auto retakes require a sequence without caption tracks and a current host script. Reload the panel.');
  const video = timeline.clips.filter(c => c.trackType === 'video');
  const audio = timeline.clips.filter(c => c.trackType === 'audio');
  if (!video.length || video.length !== audio.length || new Set(video.map(c => c.trackIndex)).size !== 1 || new Set(audio.map(c => c.trackIndex)).size !== 1) {
    throw new Error('Auto retakes support one populated video track and one matching camera-audio track. Use Analyze retakes for other layouts.');
  }
  for (const c of timeline.clips) {
    if (!c.hasMedia || !c.speedIsNormal || c.speedReversed !== false || c.trackLocked !== false || c.disabled !== false || c.transitionCount !== 0) {
      throw new Error('Auto retakes require unlocked, enabled, normal-speed media without transitions. Other layouts can use Analyze retakes.');
    }
    if (BigInt(c.end.ticks) - BigInt(c.start.ticks) !== BigInt(c.sourceOut.ticks) - BigInt(c.sourceIn.ticks)) throw new Error("Retimed source ranges need manual review.");
    const tb = BigInt(seq.timebase);
    if ([c.start, c.end].some(t => BigInt(t.ticks) % tb !== 0n)) throw new Error('Auto retakes require frame-aligned clip edges.');
  }
  const key = c => JSON.stringify([c.mediaPath, c.start.ticks, c.end.ticks, c.sourceIn.ticks, c.sourceOut.ticks]);
  const aa = audio.map(key).sort(), vv = video.map(key).sort();
  if (JSON.stringify(aa) !== JSON.stringify(vv)) throw new Error('Camera audio and video must have identical source ranges and timeline positions for automatic cuts.');
  video.sort((a, b) => a.start.seconds - b.start.seconds);
  for (let i = 1; i < video.length; i++) {
    if (BigInt(video[i].start.ticks) < BigInt(video[i - 1].end.ticks)) throw new Error('Overlapping clips need manual review.');
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
