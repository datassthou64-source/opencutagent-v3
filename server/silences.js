// Shared "silence session" state + ops for the Remove Silences tab, used by BOTH
// the panel RPC (analyzeLevels / applySilences) and the MCP tools
// (ppro_analyze_audio_levels / ppro_remove_silences_by_level) — the same way
// review.js is shared by the retake panel and tools.
//
// Loudness is measured from the source media (ffmpeg, no transcription). The
// panel computes the red "Silence" ranges live in JS as the user drags the
// controls; the server maps the final ranges to exact timeline frames (BigInt)
// and applies them in place via the batched razor-lift-close host ops.
import { getTimeline, round3, ToolError, isAborted, callHostHealing } from "./tools/util.js";
import { getLevels, sliceEnvelope } from "./audio/levels.js";
import { detectSilences, levelStats, DEFAULT_SETTINGS, PRESETS } from "./audio/silence.js";
import { sourceRangeToTimelineFrames, formatTimecode } from "./transcription/timecode.js";
import { captureUndo } from "./undo.js";
import { log } from "./log.js";

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** Pick the clips the silence tab operates on (video clips with media, 100% speed). */
function selectClips(timeline, clipId) {
  if (clipId && clipId !== "all") {
    const c = timeline.clips.find((x) => x.id === clipId);
    if (!c) throw new ToolError(`No clip "${clipId}". Call ppro_get_timeline_state for valid ids.`);
    return [c];
  }
  let clips = timeline.clips.filter((c) => c.hasMedia && c.trackType === "video");
  if (clips.length === 0) clips = timeline.clips.filter((c) => c.hasMedia);
  return clips;
}

/**
 * Extract loudness envelopes for the timeline's clips and store the session on
 * ctx.silence. Each entry carries the visible dBFS slice plus the mapping a
 * caller needs to place it on the timeline. Shared by the panel + the tools.
 */
export async function buildLevels(ctx, opts = {}, onProgress = () => {}) {
  onProgress("Reading the timeline…");
  const timeline = await getTimeline(ctx);
  const seq = timeline.sequence;
  const targets = selectClips(timeline, opts.clipId);
  if (targets.length === 0) throw new ToolError("No clips with source media on the timeline.");

  const clips = [];
  const skipped = [];
  const allDb = [];
  let hopSec = 0.02;

  for (const clip of targets) {
    if (isAborted(ctx)) throw new CancelledError();
    if (!clip.speedIsNormal) {
      skipped.push({ clip: clip.id, reason: `non-100% speed (${clip.speed}x)` });
      continue;
    }
    onProgress(`Analyzing loudness: ${clip.mediaPath.split(/[\\\/]/).pop()}…`);
    const { envelope } = await getLevels(clip.mediaPath, { cacheDir: ctx.cacheDir, refresh: !!opts.refresh });
    hopSec = envelope.hopSec;
    const slice = sliceEnvelope(envelope, clip.sourceIn.seconds, clip.sourceOut.seconds);
    for (const d of slice.db) allDb.push(d);
    clips.push({
      clipId: clip.id,
      track: clip.track,
      name: clip.name,
      timelineStartSec: round3(clip.start.seconds),
      timelineEndSec: round3(clip.end.seconds),
      sourceInSec: round3(clip.sourceIn.seconds),
      sourceOutSec: round3(clip.sourceOut.seconds),
      firstWindowSrcSec: round3(slice.firstWindowSrcSec),
      hopSec,
      db: slice.db,
    });
  }
  if (clips.length === 0) throw new ToolError("No 100%-speed media clips to analyze (all skipped).");

  const stats = levelStats(allDb);
  ctx.silence = {
    sequence: seq.name,
    frameRate: seq.frameRate,
    dropFrame: seq.dropFrame,
    hopSec,
    clips,
    stats,
    settings: { ...DEFAULT_SETTINGS, thresholdDb: stats.suggestedThresholdDb },
    skipped,
  };
  return ctx.silence;
}

/** A panel/transport-friendly view (keeps the db arrays — the panel needs them). */
export function levelsForPanel(silence) {
  return {
    sequence: silence.sequence,
    frameRate: silence.frameRate,
    dropFrame: silence.dropFrame,
    hopSec: silence.hopSec,
    clips: silence.clips,
    stats: silence.stats,
    defaults: DEFAULT_SETTINGS,
    presets: PRESETS,
    skipped: silence.skipped && silence.skipped.length ? silence.skipped : undefined,
  };
}

/**
 * Server-side silence detection across all clips in the session (used by the
 * headless tool and for reporting counts). Returns source-second ranges tagged
 * with their clip — the same shape the panel sends back to applySilences.
 */
export function computeRangesForSession(silence, settings = {}) {
  const merged = { ...silence.settings, ...settings };
  const out = [];
  for (const clip of silence.clips) {
    const ranges = detectSilences(clip.db, clip.hopSec, { ...merged, offsetSec: clip.firstWindowSrcSec });
    for (const r of ranges) out.push({ clipId: clip.clipId, srcStart: r.start, srcEnd: r.end });
  }
  return out;
}

/**
 * Map source-second ranges to exact timeline frames against a fetched timeline
 * (BigInt-precise). Pure — invalid/zero-length ranges drop.
 */
export function mapRangesToFrames(timeline, ranges = []) {
  const seq = timeline.sequence;
  const byId = new Map(timeline.clips.map((c) => [c.id, c]));
  const frames = [];
  for (const r of ranges) {
    const clip = byId.get(r.clipId);
    if (!clip) continue;
    const fr = sourceRangeToTimelineFrames(r.srcStart, r.srcEnd, clip, seq.timebase);
    if (!fr || fr.endFrame - fr.startFrame < 1) continue;
    frames.push({
      clipId: r.clipId,
      startFrame: fr.startFrame,
      endFrame: fr.endFrame,
      startSec: round3(fr.startSeconds),
      endSec: round3(fr.endSeconds),
      sec: round3(fr.endSeconds - fr.startSeconds),
    });
  }
  return { seq, frames };
}

/** Fetch the live timeline and map ranges to frames. */
export async function resolveRangesToFrames(ctx, ranges = []) {
  const timeline = await getTimeline(ctx);
  return mapRangesToFrames(timeline, ranges);
}

/** A human-readable cut list (timecodes) for dry-run previews. */
export function framesToCutList(frames, seq) {
  const list = frames
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((f) => ({
      clip: f.clipId,
      from: formatTimecode(f.startFrame, seq.frameRate, seq.dropFrame),
      to: formatTimecode(f.endFrame, seq.frameRate, seq.dropFrame),
      seconds: f.sec,
    }));
  return { count: list.length, totalRemovedSeconds: round3(list.reduce((s, r) => s + r.seconds, 0)), cutList: list };
}

const MODE_RIPPLE = { remove: true, keepSpaces: false };

/** Merge frame ranges into an ascending, non-overlapping list (host requires it). */
export function mergeFrameRanges(frames) {
  const sorted = frames
    .filter((f) => f && Number.isFinite(f.startFrame) && Number.isFinite(f.endFrame))
    .map((f) => ({ ...f, startFrame: Math.round(f.startFrame), endFrame: Math.round(f.endFrame) }))
    .filter((f) => f.endFrame > f.startFrame)
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame);
  const merged = [];
  for (const f of sorted) {
    const last = merged[merged.length - 1];
    if (last && f.startFrame <= last.endFrame) last.endFrame = Math.max(last.endFrame, f.endFrame);
    else merged.push({ startFrame: f.startFrame, endFrame: f.endFrame });
  }
  return merged;
}

const APPLY_CHUNK = 50;

/**
 * Batched in-place delete, shared by the silence AND retake apply paths. The old
 * loop called removeRange once per range — one evalScript round-trip + a QE
 * razor pass + a RIPPLE delete each; the ripple shifts every downstream clip,
 * so N ranges cost O(N × clips) DOM work (~30 min on a 2h talking timeline).
 * Batched: chunked removeRangesBatch host calls (razor all edges + lift-delete,
 * nothing shifts, so chunk order is free and cancel works between chunks), then
 * ONE closeRangeGaps pass when rippling (each surviving clip moves once).
 */
export async function applyRangesBatched(ctx, frames, { ripple = true, fps = 30, chunkSize, onProgress = () => {} } = {}) {
  const merged = mergeFrameRanges(frames);

  const size = Math.max(1, Number(chunkSize) || APPLY_CHUNK);
  let applied = 0;
  let appliedSec = 0;
  let aborted = false;
  const errors = [];
  const processed = [];
  for (let i = 0; i < merged.length; i += size) {
    if (isAborted(ctx)) { aborted = true; break; }
    const chunk = merged.slice(i, i + size);
    onProgress(`Cutting ${Math.min(i + chunk.length, merged.length)}/${merged.length}…`);
    try {
      const res = await callHostHealing(ctx, "removeRangesBatch", { ranges: chunk }, { timeoutMs: 180000 });
      const idxs = (res && Array.isArray(res.removedIndexes) ? res.removedIndexes : chunk.map((_, k) => k))
        .filter((k) => Number.isInteger(k) && k >= 0 && k < chunk.length); // a malformed host reply must not corrupt the accounting
      applied += idxs.length;
      for (const k of idxs) appliedSec += (chunk[k].endFrame - chunk[k].startFrame) / fps;
      // The host no longer swallows these. A clip Premiere refused to delete, or a
      // piece whose razor landed off the requested frame, means that span is still
      // on the timeline — say so instead of reporting a clean "applied N/N".
      if (res && res.failed > 0) {
        errors.push({ at: chunk[0].startFrame, error: `Premiere refused to delete ${res.failed} clip(s) in this batch.` });
      }
      if (res && res.straddling > 0) {
        errors.push({ at: chunk[0].startFrame, error: `${res.straddling} clip(s) overlap a cut without matching it (an edit point sits inside the cut); those spans were left in place.` });
      }
      processed.push(...chunk);
    } catch (e) {
      errors.push({ at: chunk[0].startFrame, error: e.message });
      processed.push(...chunk); // unknown state — closeRangeGaps only ever closes EMPTY ranges, so including is safe
    }
  }
  // Close even after an abort/error so the timeline is left consistent (no stray gaps).
  if (ripple && applied > 0) {
    onProgress("Closing the gaps…");
    try {
      const close = await callHostHealing(ctx, "closeRangeGaps", { ranges: processed }, { timeoutMs: 600000 });
      if (close && (close.failed > 0 || close.misaligned > 0 || close.ok === false)) {
        errors.push({
          at: -1,
          error: `Premiere could not place ${Number(close.failed || 0) + Number(close.misaligned || 0)} clip(s) on their exact frame after closing gaps.`,
        });
      }
    } catch (e) {
      errors.push({ at: -1, error: `close gaps: ${e.message}` });
    }
  }
  if (errors.length) log(`applyRangesBatched: ${errors.length} error(s), first:`, errors[0].error);
  return { applied, appliedSec: round3(appliedSec), requested: merged.length, aborted, errors };
}

/**
 * Map source-second ranges to timeline frames and apply them. mode:
 *  - "remove"     ripple-delete (close the gap)         [default]
 *  - "keepSpaces" lift-delete   (leave the gap)
 *  - "mute"       silence the span, keep the picture
 *  - "keep"       no-op (preview only)
 * remove/keepSpaces go through the batched razor→lift→close path (applyRangesBatched);
 * mute stays a per-range loop (razors + disables, no shifting, rarely hundreds).
 */
export async function applySilenceRanges(ctx, { ranges = [], mode = "remove", transition = "none", chunkSize } = {}, onProgress = () => {}) {
  if (mode === "keep") {
    return { applied: 0, requested: 0, removedSeconds: 0, mode, message: "Keep mode. Nothing was removed." };
  }
  const timeline = await getTimeline(ctx); // snapshot source (before any edit) + range mapping
  const { seq, frames } = mapRangesToFrames(timeline, ranges);

  if (frames.length === 0) {
    return { applied: 0, requested: 0, removedSeconds: 0, mode, message: "No silence ranges resolved to the timeline." };
  }

  const ripple = MODE_RIPPLE[mode];
  let applied = 0;
  let appliedSec = 0;
  let aborted = false;
  let requested = frames.length;
  let errors = [];
  if (mode === "mute") {
    frames.sort((a, b) => b.startFrame - a.startFrame);
    for (let i = 0; i < frames.length; i++) {
      if (isAborted(ctx)) { aborted = true; break; }
      onProgress(`Muting ${i + 1}/${frames.length}…`);
      try {
        await ctx.bridge.callHost("muteRange", { startFrame: frames[i].startFrame, endFrame: frames[i].endFrame });
        applied += 1;
        appliedSec += frames[i].sec;
      } catch (e) {
        errors.push({ at: frames[i].startFrame, error: e.message });
      }
    }
  } else {
    const res = await applyRangesBatched(ctx, frames, { ripple, fps: seq.frameRate, chunkSize, onProgress });
    applied = res.applied;
    appliedSec = res.appliedSec;
    aborted = res.aborted;
    requested = res.requested;
    errors = res.errors;
  }
  const removedSeconds = round3(appliedSec);
  if (applied > 0) {
    ctx.state.revision += 1;
    captureUndo(ctx, "silence", timeline, { mode, applied });
  }

  // Transition styles (J/L-cut, crossfades) are recorded but v1 applies clean
  // cuts — adding sync-correct split edits/crossfades over many ripple points is
  // not yet verified, so we never risk a desynced edit. None is the tested path.
  const transitionNote =
    transition && transition !== "none"
      ? ` Transition "${transition}" was recorded; v1 applies clean cuts (add crossfades in Premiere if wanted).`
      : "";

  return {
    applied,
    requested,
    removedSeconds,
    mode,
    ripple,
    transition,
    aborted,
    undoable: applied > 0,
    errors: errors.length ? errors : undefined,
    revision: ctx.state.revision,
    message:
      (aborted ? "Stopped after " : `${mode === "mute" ? "Muted" : "Removed"} `) +
      `${applied}${aborted ? "" : "/" + requested} silence range(s)` +
      (mode === "remove" ? (aborted ? "" : " and closed the gaps") : mode === "keepSpaces" ? " (gaps left in place)" : "") +
      `. ~${removedSeconds}s.` +
      (errors.length ? ` ${errors.length} error(s). First: ${errors[0].error}` : "") +
      transitionNote +
      (applied > 0 ? " Use Undo to revert." : ""),
  };
}

/** Push silence settings (e.g. an AI-suggested threshold) to the panel, live. */
export function pushSilenceConfig(ctx, config) {
  try {
    ctx.bridge.notifyPanel({ type: "silenceConfig", ...config });
  } catch {
    /* panel may be closed; ignore */
  }
}
