// Bounded source-audio checks; no video render, upload, or whole-file decode.
import { spawn } from 'node:child_process';

function capture(bin, args, token, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (token?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (token) { if (!token.children) token.children = new Set(); token.children.add(child); }
    const chunks = []; let bytes = 0, stderr = '', failure = null;
    const timer = setTimeout(() => { failure = 'Audio boundary check timed out.'; child.kill('SIGKILL'); }, 20000);
    child.stdout.on('data', b => {
      bytes += b.length;
      if (bytes > limit) { failure = 'Audio boundary response exceeded its limit.'; child.kill('SIGKILL'); }
      else chunks.push(b);
    });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-1000); });
    const done = () => { clearTimeout(timer); token?.children?.delete(child); };
    child.on('error', e => { done(); reject(e); });
    child.on('close', code => {
      done();
      if (token?.aborted) reject(new Error('Cancelled'));
      else if (failure || code !== 0) reject(new Error(failure || stderr || 'Cannot inspect source audio.'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Require a quiet 30ms neighborhood at an internal join. This is evidence, not phoneme recognition. */
export async function checkAcousticBoundaries(suggestion, words, timeline, token, cache = new Map(), skip = {}) {
  const frames = suggestion.frames;
  if (!frames?.length) return { ok: false, reason: 'No frozen cut frames.' };
  const first = words[suggestion.startWord], last = words[suggestion.endWord];
  const clips = timeline.clips.filter(c => c.trackType === first.trackType && c.trackIndex === first.trackIndex && c.mediaPath === first.mediaPath && c.sourceIn.seconds <= first.sourceInSec && c.sourceOut.seconds >= last.sourceOutSec);
  if (clips.length !== 1) return { ok: false, reason: 'Cannot uniquely locate source audio for this cut.' };
  const clip = clips[0], media = clip.mediaPath;
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
  try {
    const channelKey = 'channels:' + media;
    if (!cache.has(channelKey)) {
      const raw = await capture(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=channels', '-of', 'json', media], token, 64000);
      const streams = JSON.parse(raw.toString()).streams || [];
      cache.set(channelKey, streams.length === 1 ? streams[0].channels : null);
    }
    const channels = cache.get(channelKey);
    if (channels !== 1 && channels !== 2) return { ok: false, reason: 'Boundary check requires a mono or stereo source audio stream.' };
    const fps = 254016000000 / Number(timeline.sequence.timebase);
    const db = x => 20 * Math.log10(Math.max(x, 1e-8));
    const toSource = frame => clip.sourceIn.seconds + frame / fps - clip.start.seconds;
    const prev = words[suggestion.startWord - 1], next = words[suggestion.endWord + 1];
    const checks = [];
    for (const f of frames) for (const edge of ['start', 'end']) {
      const frame = edge === 'start' ? f.startFrame : f.endFrame;
      if (skip[edge]) continue; // edge shared with an adjacent cut; it disappears
      // A clip edge has no neighboring retained audio inside this occurrence.
      if ((edge === 'start' && frame === clip.start.frame) || (edge === 'end' && frame === clip.end.frame)) continue;
      // Search the pause between removed and retained speech for a quiet frame instead of
      // testing one fixed frame. Bounds (timeline seconds) never cross a retained word or
      // leave a removed word partly in; the planner's frame is always a candidate.
      const neighbor = edge === 'start' ? prev : next;
      const sameClip = neighbor && neighbor.clipKey === first.clipKey;
      const lo = edge === 'start' ? (sameClip ? neighbor.endSec : clip.start.seconds) : last.endSec;
      const hi = edge === 'start' ? first.startSec : (sameClip ? neighbor.startSec : clip.end.seconds);
      // ASR timing for the removed sound can overshoot (a throat clear "ending" inside the
      // next word's onset), so also look up to OVERSHOOT_SEC into the removed side. Such a
      // candidate is kept only if the sliver it leaves behind is quiet (checked below).
      const OVERSHOOT_SEC = 0.15;
      const searchLo = edge === 'end' ? lo - OVERSHOOT_SEC : lo, searchHi = edge === 'start' ? hi + OVERSHOOT_SEC : hi;
      const candidates = new Set([frame]);
      for (let c = Math.ceil(searchLo * fps); c <= Math.floor(searchHi * fps); c++) {
        if (Math.abs(c - frame) / fps <= 1.0 && c > clip.start.frame && c < clip.end.frame) candidates.add(c);
      }
      const list = [...candidates].sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame) || a - b);
      const times = list.map(toSource);
      const t0 = Math.min(...times), t1 = Math.max(...times);
      const key = `${media}:${t0.toFixed(6)}:${t1.toFixed(6)}`;
      let pcm = cache.get(key);
      if (!pcm) {
        const start = Math.max(0, t0 - 0.35), duration = t1 - t0 + 0.7;
        const raw = await capture(ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(start), '-i', media, '-t', String(duration), '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', String(channels), '-f', 'f32le', '-'], token);
        const count = Math.floor(raw.length / (4 * channels));
        const peaks = new Float32Array(count);
        let localPeak = 0;
        for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) {
          const value = Math.abs(raw.readFloatLE((i * channels + c) * 4));
          if (!Number.isFinite(value)) throw new Error('Invalid PCM sample.');
          if (value > peaks[i]) peaks[i] = value;
          if (value > localPeak) localPeak = value;
        }
        pcm = { start, count, peaks, localPeak };
        cache.set(key, pcm);
      }
      const peakDb = db(pcm.localPeak);
      // Quiet overall excerpts pass only at a conservative absolute level.
      // Otherwise require the join to be 30dB below nearby peak and <= -36dBFS.
      const threshold = peakDb <= -55 ? -55 : Math.min(-36, peakDb - 30);
      const leftoverMax = Math.min(-30, peakDb - 12);
      const peakBetween = (ta, tb) => {
        let p = 0;
        const a = Math.max(0, Math.floor((Math.min(ta, tb) - pcm.start) * 16000)), b = Math.min(pcm.count - 1, Math.ceil((Math.max(ta, tb) - pcm.start) * 16000));
        for (let i = a; i <= b; i++) if (pcm.peaks[i] > p) p = pcm.peaks[i];
        return db(p);
      };
      const bound = toSource((edge === 'end' ? lo : hi) * fps);
      const half = 0.015 * 16000;
      let best = null;
      for (let k = 0; k < list.length; k++) {
        const center = (times[k] - pcm.start) * 16000;
        if (center - half < 0 || center + half >= pcm.count) continue;
        let boundaryPeak = 0;
        for (let i = Math.floor(center - half); i <= Math.ceil(center + half); i++) if (pcm.peaks[i] > boundaryPeak) boundaryPeak = pcm.peaks[i];
        const edgeDb = db(boundaryPeak);
        // Inside the removed word: the part left behind must be near-silent.
        const inside = edge === 'end' ? times[k] < bound : times[k] > bound;
        if (inside && list[k] !== frame && peakBetween(times[k], bound) > leftoverMax) continue;
        if (!best || edgeDb < best.edgeDb) best = { frame: list[k], sourceTime: times[k], edgeDb };
        if (edgeDb <= threshold) { best = { frame: list[k], sourceTime: times[k], edgeDb }; break; } // closest quiet frame wins
      }
      if (!best) throw new Error('Insufficient audio around the join.');
      const result = { ok: best.edgeDb <= threshold, sourceTime: best.sourceTime, edgeDb: best.edgeDb, threshold,
        ...(best.frame !== frame ? { movedFromFrame: frame, movedToFrame: best.frame } : {}) };
      checks.push({ edge, ...result });
      if (!result.ok) return { ok: false, reason: 'Speech or noise reaches this cut boundary; kept for listening.', checks };
      if (edge === 'start') f.startFrame = best.frame; else f.endFrame = best.frame;
    }
    return { ok: true, checks };
  } catch (e) {
    if (token?.aborted) throw e;
    return { ok: false, reason: `Audio boundary could not be checked: ${e.message}` };
  }
}
