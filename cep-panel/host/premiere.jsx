/*
 * premiere.jsx — ALL Premiere host operations for OpenCutAgent.
 *
 * This is the single host-specific file (the UXP-portability boundary): the
 * server, bridge, panel transport, and skill never change if this is ported.
 *
 * Design note (content-filter & robustness friendly): we do NOT embed a JSON
 * polyfill. The panel sends params as a native ExtendScript object literal
 * (browser JSON.stringify output is valid ExtendScript), so no JSON.parse is
 * needed here. We only SERIALIZE results, via a small custom stringifier below.
 *
 * ExtendScript is ES3: var only, no arrow functions, no Array.forEach, etc.
 */

$.editagent = (function () {
  var TPS = 254016000000; // Premiere ticks per second

  /* ---------- filter-safe JSON serialization (output only) ---------- */

  function escString(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (code === 8) out += "\\b";
      else if (code === 9) out += "\\t";
      else if (code === 10) out += "\\n";
      else if (code === 12) out += "\\f";
      else if (code === 13) out += "\\r";
      else if (code < 32) {
        var h = code.toString(16);
        while (h.length < 4) h = "0" + h;
        out += "\\u" + h;
      } else out += c;
    }
    return out;
  }

  function stringify(v, depth) {
    if (depth == null) depth = 0;
    if (depth > 8) return '"[truncated]"';
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return '"' + escString(v) + '"';
    if (t === "function") return "null";
    if (v instanceof Array) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stringify(v[i], depth + 1));
      return "[" + parts.join(",") + "]";
    }
    // object
    var op = [];
    for (var k in v) {
      if (!v.hasOwnProperty(k)) continue;
      var val;
      try {
        val = v[k];
      } catch (e) {
        continue;
      }
      if (typeof val === "function") continue;
      op.push('"' + escString(String(k)) + '":' + stringify(val, depth + 1));
    }
    return "{" + op.join(",") + "}";
  }

  /* ---------- timecode helpers ---------- */

  function pad2(n) {
    n = Math.floor(n);
    return (n < 10 ? "0" : "") + n;
  }

  function framesToTC(frame, nominal, drop) {
    if (drop) return framesToTCDrop(frame, nominal);
    var f = frame % nominal;
    var tot = Math.floor(frame / nominal);
    var s = tot % 60;
    var m = Math.floor(tot / 60) % 60;
    var h = Math.floor(tot / 3600);
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + ":" + pad2(f);
  }

  function framesToTCDrop(frame, nominal) {
    var dropPerMin = nominal === 60 ? 4 : 2;
    var fp10 = nominal * 60 * 10 - 9 * dropPerMin;
    var fpm = nominal * 60 - dropPerMin;
    var d = Math.floor(frame / fp10);
    var m = frame % fp10;
    var f = frame;
    if (m > dropPerMin) f += dropPerMin * 9 * d + dropPerMin * Math.floor((m - dropPerMin) / fpm);
    else f += dropPerMin * 9 * d;
    var fr = f % nominal;
    var s = Math.floor(f / nominal) % 60;
    var mm = Math.floor(f / (nominal * 60)) % 60;
    var hh = Math.floor(f / (nominal * 3600)) % 24;
    return pad2(hh) + ":" + pad2(mm) + ":" + pad2(s) + ";" + pad2(fr);
  }

  function detectDropFrame(seq, fps) {
    // The display format is authoritative: 29.97/59.94 may be drop OR non-drop.
    // Older builds that do not expose it fall back to the legacy rate check.
    try {
      var display = Number(seq.videoDisplayFormat);
      if (display === 102 || display === 106) return true;
      if (display === 103 || display === 107) return false;
    } catch (e) {}
    // Tight fallback tolerance keeps a ~30.00003 sequence non-drop.
    return Math.abs(fps - 30000 / 1001) < 0.005 || Math.abs(fps - 60000 / 1001) < 0.005;
  }

  /* ---------- DOM helpers ---------- */

  function makeTime(sec) {
    var t = new Time();
    t.seconds = sec;
    return t;
  }

  function requireSeq() {
    if (!app.project) throw new Error("No project is open in Premiere.");
    var seq = app.project.activeSequence;
    if (!seq) throw new Error("No active sequence. Open a sequence in the timeline, then retry.");
    return seq;
  }

  function getTrack(type, index) {
    var seq = requireSeq();
    var tracks = type === "video" ? seq.videoTracks : seq.audioTracks;
    return tracks[index];
  }

  function secToTicksStr(sec) {
    return String(Math.round(sec * TPS));
  }

  /* ---------- integer-frame helpers (the cut path runs on these) ----------
     Everything that razors, deletes or ripples must agree on WHICH FRAME it is
     talking about. Reading positions as clip.start.seconds and moving clips by a
     seconds offset loses that: seconds are floats, the sequence timebase is often
     non-integer (a "30 fps" sequence is 30.00003), and a move by a fractional
     frame lands a clip a hair off the grid. Premiere then snaps it, and the
     leftover sliver shows up as an unselectable 1-frame black gap between scenes.
     Ticks are exact integers (254016000000 per second, seq.timebase per frame),
     so frame = ticks / timebase is exact and a move of N frames is N * timebase
     ticks with no rounding anywhere. */

  function tickFrames(ticks, timebase) {
    // ticks is a string of an exact integer; Number() is lossless well past any
    // real sequence length (2^53 ticks ~ 10h at 30fps).
    return Math.round(Number(ticks) / timebase);
  }

  function clipFrames(clip, timebase) {
    return { s: tickFrames(clip.start.ticks, timebase), e: tickFrames(clip.end.ticks, timebase) };
  }

  function timeFromTicks(ticks) {
    var t = new Time();
    try {
      t.ticks = String(Math.round(ticks));
      return t;
    } catch (e) {}
    var t2 = new Time();
    t2.seconds = ticks / TPS;
    return t2;
  }

  // A Time of exactly N frames (N may be negative, for a ripple move left).
  // Falls back to seconds if this build refuses a ticks assignment.
  function frameTime(frames, timebase) {
    return timeFromTicks(Math.round(frames) * timebase);
  }

  // QE's razor takes a formatted ruler timecode, not a raw Time. Let Premiere
  // format an exact frame-tick position using the sequence's own display mode;
  // the manual formatter is only a compatibility fallback for older builds.
  function frameToSequenceTC(seq, frame, timebase, nominal, drop) {
    try {
      var at = frameTime(frame, timebase);
      var oneFrame = frameTime(1, timebase);
      return at.getFormatted(oneFrame, seq.videoDisplayFormat);
    } catch (e) {
      return framesToTC(frame, nominal, drop);
    }
  }

  // Move to an ABSOLUTE frame target. A relative whole-frame move preserves any
  // pre-existing subframe residue; this corrects that residue as part of the
  // move, then verifies Premiere actually accepted the exact target.
  function moveClipToFrame(clip, targetFrame, timebase) {
    targetFrame = Math.round(targetFrame);
    var targetTicks = targetFrame * timebase;
    var beforeTicks = Number(clip.start.ticks);
    clip.move(timeFromTicks(targetTicks - beforeTicks));
    var afterTicks = Number(clip.start.ticks);
    return {
      ok: Math.abs(afterTicks - targetTicks) <= 1,
      targetFrame: targetFrame,
      actualFrame: tickFrames(afterTicks, timebase),
      tickError: afterTicks - targetTicks
    };
  }

  /* ---------- handlers ---------- */

  function ping() {
    return { pong: true, app: app.appName ? app.appName : "Premiere", version: app.version ? app.version : "" };
  }

  function collectTrackClips(tracks, type, clipsOut, gapsOut, timebase) {
    var prefix = type === "video" ? "V" : "A";
    for (var i = 0; i < tracks.numTracks; i++) {
      var track = tracks[i];
      var n = track.clips.numItems;
      var prevEndFrame = 0;
      for (var j = 0; j < n; j++) {
        var clip = track.clips[j];
        var startSec = clip.start.seconds;
        var endSec = clip.end.seconds;
        var f = clipFrames(clip, timebase);
        if (f.s > prevEndFrame) {
          gapsOut.push({
            trackType: type,
            trackIndex: i,
            start: { ticks: String(prevEndFrame * timebase), seconds: (prevEndFrame * timebase) / TPS },
            end: { ticks: String(clip.start.ticks), seconds: startSec }
          });
        }
        var mediaPath = "", nested = false;
        try {
          if (clip.projectItem) mediaPath = clip.projectItem.getMediaPath();
        } catch (e) {}
        // A nested/multicam sequence has no media path but razors and moves like any clip.
        try { nested = !mediaPath && !!clip.projectItem && !!clip.projectItem.isSequence(); } catch (eNest) {}
        var locked = null, disabled = null, transitions = null, speed = null, reversed = null;
        try { locked = !!track.isLocked(); } catch (eLock) {}
        try { disabled = !!clip.disabled; } catch (eDisabled) {}
        try { transitions = track.transitions.numItems; } catch (eTransitions) {}
        try { speed = clip.getSpeed(); } catch (eSpeed) {}
        try { reversed = !!clip.isSpeedReversed(); } catch (eReverse) {}
        clipsOut.push({
          trackLocked: locked,
          disabled: disabled,
          transitionCount: transitions,
          speed: speed,
          speedReversed: reversed,
          id: prefix + (i + 1) + "." + j,
          name: clip.name,
          trackType: type,
          trackIndex: i,
          itemIndex: j,
          mediaPath: mediaPath,
          isNested: nested,
          start: { ticks: String(clip.start.ticks), seconds: startSec },
          end: { ticks: String(clip.end.ticks), seconds: endSec },
          inPoint: { ticks: String(clip.inPoint.ticks), seconds: clip.inPoint.seconds },
          outPoint: { ticks: String(clip.outPoint.ticks), seconds: clip.outPoint.seconds }
        });
        prevEndFrame = Math.max(prevEndFrame, f.e);
      }
    }
  }

  function getTimelineState() {
    var seq = requireSeq();
    var timebase = String(seq.timebase);
    var fps = TPS / Number(timebase);
    var clips = [];
    var gaps = [];
    collectTrackClips(seq.videoTracks, "video", clips, gaps, Number(timebase));
    collectTrackClips(seq.audioTracks, "audio", clips, gaps, Number(timebase));
    var fsH = null, fsV = null;
    try { fsH = seq.frameSizeHorizontal; fsV = seq.frameSizeVertical; } catch (eFS) {}
    return {
      sequence: {
        name: seq.name,
        id: String(seq.sequenceID),
        captionTrackCount: seq.captionTracks ? seq.captionTracks.numTracks : 0,
        timebase: timebase,
        frameRate: fps,
        zeroPointTicks: String(seq.zeroPoint),
        dropFrame: detectDropFrame(seq, fps),
        videoTrackCount: seq.videoTracks.numTracks,
        audioTrackCount: seq.audioTracks.numTracks,
        frameSizeHorizontal: fsH,
        frameSizeVertical: fsV
      },
      clips: clips,
      gaps: gaps
    };
  }

  // Validate the expected geometry in the SAME synchronous host operation as
  // the mutation, so an intervening manual edit cannot redirect the cuts.
  function assertRetakeGeometry(p, cutting) {
    var seq = requireSeq();
    if (p.expectedSequenceId && String(seq.sequenceID) !== p.expectedSequenceId) throw new Error("Active sequence changed; no operation performed.");
    if (p.expectedTimebase && String(seq.timebase) !== p.expectedTimebase) throw new Error("Sequence timebase changed; no operation performed.");
    if (!p.expectedGeometry) return;
    var current = getTimelineState().clips, wanted = p.expectedGeometry, byKey = {}, i;
    if (current.length !== wanted.length) throw new Error("Timeline changed before the operation; no operation performed.");
    for (i = 0; i < wanted.length; i++) {
      var e = wanted[i];
      byKey[e.trackType + ":" + e.trackIndex + ":" + e.start] = e;
    }
    for (i = 0; i < current.length; i++) {
      var c = current[i], k = c.trackType + ":" + c.trackIndex + ":" + c.start.ticks, target = byKey[k];
      if (!target || (c.mediaPath || null) !== target.mediaPath || String(c.end.ticks) !== target.end || String(c.inPoint.ticks) !== target.sourceIn || String(c.outPoint.ticks) !== target.sourceOut) throw new Error("Timeline geometry changed; no operation performed.");
      if (cutting && (c.trackLocked !== false || c.disabled !== false || c.speedReversed !== false || c.transitionCount !== 0)) throw new Error("Track state changed; no cuts performed.");
      delete byKey[k];
    }
  }

  function duplicateRetakeSequence(p) {
    var original = requireSeq();
    if (String(original.sequenceID) !== p.expectedSequenceId) throw new Error("Active sequence changed before duplication.");
    var known = {}, sequences = app.project.sequences, i;
    for (i = 0; i < sequences.numSequences; i++) known[String(sequences[i].sequenceID)] = true;
    original.clone(); // The return value varies by Premiere version; identify new IDs instead.
    var found = [];
    for (i = 0; i < sequences.numSequences; i++) if (!known[String(sequences[i].sequenceID)]) found.push(sequences[i]);
    if (found.length !== 1) throw new Error("Could not uniquely identify the duplicate; no cuts performed.");
    var copy = found[0];
    copy.name = original.name + " - Retakes " + new Date().getTime();
    app.project.openSequence(copy.sequenceID);
    if (String(requireSeq().sequenceID) !== String(copy.sequenceID)) throw new Error("Could not activate the duplicate; no cuts performed.");
    return { sequenceId: String(copy.sequenceID), name: copy.name };
  }

  function trimClip(p) {
    var seq = requireSeq();
    var timebase = Number(seq.timebase);
    var track = p.trackType === "video" ? seq.videoTracks[p.trackIndex] : seq.audioTracks[p.trackIndex];
    var clip = track.clips[p.itemIndex];
    if (!clip) throw new Error("Clip not found at " + p.trackType + " track " + p.trackIndex + " item " + p.itemIndex + ".");
    function requestedTime(frame, sec) {
      if (frame != null) return frameTime(frame, timebase);
      if (sec != null) return frameTime(tickFrames(secToTicksStr(sec), timebase), timebase);
      return null;
    }
    // All four requested edges are snapped to the active sequence frame grid.
    var sourceIn = requestedTime(p.sourceInFrame, p.sourceInSec);
    var sourceOut = requestedTime(p.sourceOutFrame, p.sourceOutSec);
    var timelineStart = requestedTime(p.timelineStartFrame, p.timelineStartSec);
    var timelineEnd = requestedTime(p.timelineEndFrame, p.timelineEndSec);
    if (sourceIn) clip.inPoint = sourceIn;
    if (sourceOut) clip.outPoint = sourceOut;
    if (timelineStart) clip.start = timelineStart;
    if (timelineEnd) clip.end = timelineEnd;
    return {
      ok: true,
      start: clip.start.seconds,
      end: clip.end.seconds,
      inPoint: clip.inPoint.seconds,
      outPoint: clip.outPoint.seconds
    };
  }

  function closeGapsOnTrack(track, type, trackIndex, minGap, details, timebase) {
    // Frames, not seconds: a gap is a whole number of frames and closing it must
    // move the clip by exactly that many, or the clip lands off the frame grid and
    // the "closed" gap survives as a 1-frame black sliver.
    var fps = TPS / timebase;
    var items = [];
    var n = track.clips.numItems;
    for (var j = 0; j < n; j++) {
      var c = track.clips[j];
      var f = clipFrames(c, timebase);
      items.push({ clip: c, start: f.s, end: f.e });
    }
    items.sort(function (a, b) {
      return a.start - b.start;
    });
    var minGapFrames = Math.max(1, Math.round(minGap * fps));
    var cursor = 0;
    var closed = 0;
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var gap = it.start - cursor;
      if (gap >= minGapFrames) {
        var target = it.start - gap;
        try {
          var placed = moveClipToFrame(it.clip, target, timebase);
          details.push({
            track: (type === "video" ? "V" : "A") + (trackIndex + 1),
            frames: gap,
            seconds: gap / fps,
            aligned: placed.ok
          });
          if (placed.ok) closed++;
        } catch (e) {
          details.push({
            track: (type === "video" ? "V" : "A") + (trackIndex + 1),
            frames: gap,
            seconds: gap / fps,
            aligned: false,
            error: String(e && e.message ? e.message : e)
          });
        }
        try { cursor = clipFrames(it.clip, timebase).e; } catch (e2) { cursor = it.end; }
      } else {
        cursor = it.end;
      }
    }
    return closed;
  }

  function removeGaps(p) {
    var seq = requireSeq();
    var timebase = Number(seq.timebase);
    var minGap = p.minGapSec != null ? p.minGapSec : 0.0005;
    var details = [];
    var closed = 0;
    var doType = p.trackType != null ? p.trackType : null;
    var onlyIndex = p.trackIndex != null ? p.trackIndex : null;
    if (doType === null || doType === "video") {
      var vt = seq.videoTracks;
      for (var i = 0; i < vt.numTracks; i++) {
        if (onlyIndex !== null && onlyIndex !== i) continue;
        closed += closeGapsOnTrack(vt[i], "video", i, minGap, details, timebase);
      }
    }
    if (doType === null || doType === "audio") {
      var at = seq.audioTracks;
      for (var a = 0; a < at.numTracks; a++) {
        if (onlyIndex !== null && onlyIndex !== a) continue;
        closed += closeGapsOnTrack(at[a], "audio", a, minGap, details, timebase);
      }
    }
    return { count: closed, closed: details };
  }

  function removeMiddle(tracks, startFrame, timebase, ripple) {
    var removed = 0;
    for (var i = 0; i < tracks.numTracks; i++) {
      var track = tracks[i];
      for (var j = 0; j < track.clips.numItems; j++) {
        var c = track.clips[j];
        var cf = tickFrames(c.start.ticks, timebase);
        if (cf === startFrame) {
          try {
            // ripple=true closes the gap (downstream shifts left); false lifts (leaves a gap).
            c.remove(ripple, true);
            removed++;
          } catch (e) {}
          break;
        }
      }
    }
    return removed;
  }

  function removeRange(p) {
    var ripple = p.ripple === false ? false : true;
    var seq = requireSeq();
    var timebase = Number(seq.timebase);
    var fps = TPS / timebase;
    var drop = detectDropFrame(seq, fps);
    var nominal = Math.round(fps);
    var zpFrames = tickFrames(seq.zeroPoint, timebase);
    var startTC = frameToSequenceTC(seq, p.startFrame + zpFrames, timebase, nominal, drop);
    var endTC = frameToSequenceTC(seq, p.endFrame + zpFrames, timebase, nominal, drop);

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    var i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
      try {
        var qv = qeSeq.getVideoTrackAt(i);
        qv.razor(startTC);
        qv.razor(endTC);
      } catch (e) {}
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      try {
        var qa = qeSeq.getAudioTrackAt(i);
        qa.razor(startTC);
        qa.razor(endTC);
      } catch (e2) {}
    }

    var removed = 0;
    removed += removeMiddle(seq.videoTracks, p.startFrame, timebase, ripple);
    removed += removeMiddle(seq.audioTracks, p.startFrame, timebase, ripple);
    return { ok: true, startTC: startTC, endTC: endTC, tracksAffected: removed, ripple: ripple };
  }

  // ---- batched range removal (fast Apply All) ----
  // The per-range removeRange loop cost one evalScript round-trip + a QE razor
  // pass + a RIPPLE delete per silence; the ripple shifts every downstream clip,
  // so N ranges do O(N × clips) DOM work (~30 min for a 2h talk). Batched:
  // razor ALL edges first (a razor never shifts anything, so every timecode
  // stays valid), lift-delete every piece inside a range (constant cost, no
  // shifting), then closeRangeGaps moves each surviving clip left exactly ONCE.
  // p.ranges must be ascending and non-overlapping (the server merges).

  function removeRangesBatch(p) {
    assertRetakeGeometry(p, true);
    var seq = requireSeq();
    if (p.expectedSequenceId && String(seq.sequenceID) !== p.expectedSequenceId) throw new Error("Active sequence changed; no operation performed.");
    var timebase = Number(seq.timebase);
    var fps = TPS / timebase;
    var drop = detectDropFrame(seq, fps);
    var nominal = Math.round(fps);
    var zpFrames = tickFrames(seq.zeroPoint, timebase);
    var ranges = p.ranges || [];
    var i;

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();

    function razorTrack(qtrack) {
      if (!qtrack) return;
      for (var k = 0; k < ranges.length; k++) {
        try { qtrack.razor(frameToSequenceTC(seq, ranges[k].startFrame + zpFrames, timebase, nominal, drop)); } catch (e) {}
        try { qtrack.razor(frameToSequenceTC(seq, ranges[k].endFrame + zpFrames, timebase, nominal, drop)); } catch (e2) {}
      }
    }
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
      var qv = null;
      try { qv = qeSeq.getVideoTrackAt(i); } catch (e3) {}
      razorTrack(qv);
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      var qa = null;
      try { qa = qeSeq.getAudioTrackAt(i); } catch (e4) {}
      razorTrack(qa);
    }

    // Last range starting at or before cs (ascending, non-overlapping → binary search).
    function findRange(cs) {
      var lo = 0, hi = ranges.length - 1, found = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (ranges[mid].startFrame <= cs) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found;
    }

    var removedIdx = {};
    var pieces = 0;
    var failed = 0;
    var straddling = 0;
    function liftTrack(track) {
      // descending index so removals never invalidate the still-pending indices;
      // lift (remove(false)) leaves a gap, so no other clip moves.
      for (var k = track.clips.numItems - 1; k >= 0; k--) {
        var c = track.clips[k];
        var cf = clipFrames(c, timebase);
        var cs = cf.s, ce = cf.e;
        if (ce <= cs) continue;
        var idx = findRange(cs);
        var r = idx >= 0 ? ranges[idx] : null;
        // EXACT containment only. This used to allow a 1-frame overhang on each
        // side ("cs >= startFrame - 1 && ce <= endFrame + 1"), which swallowed a
        // neighbouring 1-frame sliver whenever an earlier pass had left an edit
        // point right next to the cut. closeRangeGaps then rippled by the
        // REQUESTED width, so the extra emptied frame survived as a gap too small
        // to see or select. Compensating in the ripple is NOT an option: tracks
        // over-delete independently, so a per-track shift would desync A from V.
        // Matching exactly keeps hole == range on every track, which is the only
        // way the single uniform shift stays correct.
        if (r && cs >= r.startFrame && ce <= r.endFrame) {
          try {
            c.remove(false, true);
            removedIdx[idx] = true;
            pieces++;
          } catch (e) { failed++; } // surfaced by the server instead of vanishing
          continue;
        }
        // Overlaps a range without being contained: the razor didn't land where we
        // asked. Deleting it would take footage the user never marked, so leave it
        // alone and report it (closeRangeGaps sees the range still occupied and
        // skips the shift, so the timeline stays consistent).
        var nxt = idx + 1 < ranges.length ? ranges[idx + 1] : null;
        if ((r && ce > r.startFrame && cs < r.endFrame) || (nxt && ce > nxt.startFrame && cs < nxt.endFrame)) straddling++;
      }
    }
    for (i = 0; i < seq.videoTracks.numTracks; i++) liftTrack(seq.videoTracks[i]);
    for (i = 0; i < seq.audioTracks.numTracks; i++) liftTrack(seq.audioTracks[i]);

    var removedIndexes = [];
    for (i = 0; i < ranges.length; i++) if (removedIdx[i]) removedIndexes.push(i);
    return {
      ok: true, requested: ranges.length, removedIndexes: removedIndexes,
      pieces: pieces, failed: failed, straddling: straddling
    };
  }

  // Close ONLY the gaps removeRangesBatch left: per track, a range counts toward
  // the shift when it is actually EMPTY there — self-verifying, so a piece that
  // failed to razor/delete keeps its span and nothing mis-shifts (matches the
  // old per-track ripple semantics). Pre-existing gaps are untouched.
  function closeRangeGaps(p) {
    assertRetakeGeometry(p, true);
    var seq = requireSeq();
    if (p.expectedSequenceId && String(seq.sequenceID) !== p.expectedSequenceId) throw new Error("Active sequence changed; no operation performed.");
    var timebase = Number(seq.timebase);
    var ranges = p.ranges || []; // ascending, non-overlapping
    // Integer frames throughout: clip edges come from ticks and the shift is a
    // whole number of frames, so a range's hole and the ripple that closes it are
    // the same width BY CONSTRUCTION. The old code did this in seconds with a
    // half-frame slack to absorb float noise; any leftover fraction became an
    // invisible black sliver between the scenes. There is no fraction to absorb
    // now, so the slack is gone too.
    var moved = 0;
    var failed = 0;
    var misaligned = 0;

    function closeTrack(track) {
      var items = [];
      var j;
      for (j = 0; j < track.clips.numItems; j++) {
        var c = track.clips[j];
        var f = clipFrames(c, timebase);
        items.push({ clip: c, s: f.s, e: f.e });
      }
      items.sort(function (a, b) { return a.s - b.s; });

      // frames each range contributes on THIS track (0 while still occupied)
      var durs = [];
      var k = 0;
      for (var r = 0; r < ranges.length; r++) {
        var rs = ranges[r].startFrame;
        var re = ranges[r].endFrame;
        while (k < items.length && items[k].e <= rs) k++;
        durs.push(k < items.length && items[k].s < re ? 0 : re - rs);
      }

      // shift each clip left once by the emptied frames before it; ascending
      // is safe (earlier clips shift by no more and have already moved).
      var cum = 0, ri = 0;
      for (j = 0; j < items.length; j++) {
        while (ri < ranges.length && ranges[ri].endFrame <= items[j].s) { cum += durs[ri]; ri++; }
        if (cum > 0) {
          var target = items[j].s - cum;
          try {
            var placed = moveClipToFrame(items[j].clip, target, timebase);
            if (placed.ok) moved++;
            else misaligned++;
          } catch (e) { failed++; }
        }
      }
    }
    var i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) closeTrack(seq.videoTracks[i]);
    for (i = 0; i < seq.audioTracks.numTracks; i++) closeTrack(seq.audioTracks[i]);
    return {
      ok: failed === 0 && misaligned === 0,
      moved: moved,
      failed: failed,
      misaligned: misaligned,
      ranges: ranges.length
    };
  }

  // Mute a timeline range on the AUDIO tracks only (keep the picture): razor at
  // both edges, then disable the audio item(s) now sitting inside the span. Used
  // by the Remove Silences "Mute silences" mode. Best-effort: TrackItem.disabled
  // is version-dependent, so each disable is guarded.
  function muteRange(p) {
    var seq = requireSeq();
    var timebase = Number(seq.timebase);
    var fps = TPS / timebase;
    var drop = detectDropFrame(seq, fps);
    var nominal = Math.round(fps);
    var zpFrames = tickFrames(seq.zeroPoint, timebase);
    var startTC = frameToSequenceTC(seq, p.startFrame + zpFrames, timebase, nominal, drop);
    var endTC = frameToSequenceTC(seq, p.endFrame + zpFrames, timebase, nominal, drop);

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    var i;
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      try {
        var qa = qeSeq.getAudioTrackAt(i);
        qa.razor(startTC);
        qa.razor(endTC);
      } catch (e) {}
    }

    var muted = 0;
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      var track = seq.audioTracks[i];
      for (var j = 0; j < track.clips.numItems; j++) {
        var c = track.clips[j];
        var mf = clipFrames(c, timebase);
        var cs = mf.s, ce = mf.e;
        // Exact containment only: every razor boundary and comparison is a frame.
        if (ce > cs && cs >= p.startFrame && ce <= p.endFrame) {
          try {
            c.disabled = true;
            muted++;
          } catch (e2) {}
        }
      }
    }
    return { ok: true, startTC: startTC, endTC: endTC, muted: muted };
  }

  // Move Premiere's playhead (CTI) to a timeline position (seconds, 0-relative).
  // Lets the panel's "click the waveform to seek" jump the sequence there.
  function setPlayhead(p) {
    var seq = requireSeq();
    seq.setPlayerPosition(secToTicksStr(p.seconds != null ? p.seconds : 0));
    return { ok: true, seconds: p.seconds != null ? p.seconds : 0 };
  }

  // Read the playhead (CTI) position, 0-relative seconds (matches clip.start.seconds;
  // the sequence zeroPoint is display-only). The Retakes tab polls this to highlight
  // the segment under the playhead while you scrub.
  function getPlayhead() {
    var seq = requireSeq();
    var t = seq.getPlayerPosition();
    return { seconds: t.seconds, ticks: String(t.ticks) };
  }

  // ---- one-click Undo: restore the timeline to a pre-apply snapshot ----

  function samePath(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    var na = String(a).replace(/\\/g, "/").toLowerCase();
    var nb = String(b).replace(/\\/g, "/").toLowerCase();
    return na === nb;
  }

  // Does the track's current layout already equal the snapshot originals?
  function trackMatches(cur, originals) {
    if (cur.length !== originals.length) return false;
    var used = [];
    for (var k = 0; k < originals.length; k++) {
      var o = originals[k];
      var found = false;
      for (var m = 0; m < cur.length; m++) {
        if (used[m]) continue;
        if (samePath(cur[m].mediaPath, o.mediaPath) && Math.abs(cur[m].inP - o.inSec) < 0.05 && Math.abs(cur[m].outP - o.outSec) < 0.05) {
          used[m] = true;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  // Restore the timeline from a snapshot of clips captured before an apply.
  // Two-phase: plan read-only (bail with ok:false if anything can't be matched,
  // changing NOTHING), then execute right-to-left so resizes never overlap. The
  // server verifies afterward and Cmd+Z is the guaranteed fallback.
  function restoreTimeline(p) {
    var seq = requireSeq();
    var timebase = Number(seq.timebase);
    var clips = p.clips || [];
    var byKey = {};
    var i, k, m;
    for (i = 0; i < clips.length; i++) {
      var oc = clips[i];
      var key = oc.trackType + ":" + oc.trackIndex;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(oc);
    }

    // PHASE 1 — plan (read-only)
    var plans = [];
    for (var key1 in byKey) {
      if (!byKey.hasOwnProperty(key1)) continue;
      var parts = key1.split(":");
      var type = parts[0];
      var idx = Number(parts[1]);
      var tracks = type === "video" ? seq.videoTracks : seq.audioTracks;
      if (idx >= tracks.numTracks) return { ok: false, reason: "track " + key1 + " is gone" };
      var track = tracks[idx];

      var originals = byKey[key1].slice();
      originals.sort(function (a, b) { return a.startSec - b.startSec; });

      var cur = [];
      for (var j = 0; j < track.clips.numItems; j++) {
        var c = track.clips[j];
        var mp = "";
        try { if (c.projectItem) mp = c.projectItem.getMediaPath(); } catch (e) {}
        cur.push({ clip: c, mediaPath: mp, inP: c.inPoint.seconds, outP: c.outPoint.seconds, used: false });
      }

      if (trackMatches(cur, originals)) continue; // unchanged track — leave it alone

      var ops = [];
      for (k = 0; k < originals.length; k++) {
        var o = originals[k];
        var survivor = null;
        var extras = [];
        for (m = 0; m < cur.length; m++) {
          var it = cur[m];
          if (it.used) continue;
          // a kept piece from the same media whose source range is within the original
          if (samePath(it.mediaPath, o.mediaPath) && it.inP >= o.inSec - 0.5 && it.outP <= o.outSec + 0.5) {
            it.used = true;
            if (!survivor) survivor = it;
            else extras.push(it);
          }
        }
        if (!survivor) return { ok: false, reason: "missing a piece to rebuild a clip on " + key1 };
        ops.push({ survivor: survivor, extras: extras, o: o });
      }
      for (var u = 0; u < cur.length; u++) {
        if (!cur[u].used) return { ok: false, reason: "unrecognized clip on " + key1 + " (timeline changed since the apply)" };
      }
      plans.push({ ops: ops });
    }

    // PHASE 2 — execute (right-to-left so a survivor never overlaps one to its right)
    var resized = 0, removed = 0, restoredTracks = 0;
    for (i = 0; i < plans.length; i++) {
      var planOps = plans[i].ops;
      if (!planOps.length) continue;
      restoredTracks++;
      for (k = planOps.length - 1; k >= 0; k--) {
        var op = planOps[k];
        for (var e = 0; e < op.extras.length; e++) {
          try { op.extras[e].clip.remove(false, true); removed++; } catch (ex) {}
        }
        var clip2 = op.survivor.clip;
        // New snapshots carry exact ticks. Older ones are snapped to the active
        // sequence frame grid rather than restored through floating seconds.
        clip2.inPoint = op.o.inTicks != null
          ? timeFromTicks(Number(op.o.inTicks))
          : frameTime(tickFrames(secToTicksStr(op.o.inSec), timebase), timebase);
        clip2.outPoint = op.o.outTicks != null
          ? timeFromTicks(Number(op.o.outTicks))
          : frameTime(tickFrames(secToTicksStr(op.o.outSec), timebase), timebase);
        clip2.start = op.o.startTicks != null
          ? timeFromTicks(Number(op.o.startTicks))
          : frameTime(tickFrames(secToTicksStr(op.o.startSec), timebase), timebase);
        clip2.end = op.o.endTicks != null
          ? timeFromTicks(Number(op.o.endTicks))
          : frameTime(tickFrames(secToTicksStr(op.o.endSec), timebase), timebase);
        resized++;
      }
    }
    return { ok: true, restoredTracks: restoredTracks, resized: resized, removed: removed };
  }

  // ---- re-insert a removed Cut segment (Retakes tab) ----
  // Insert (ripple) a source range back onto V1+A1 at targetSeconds, restoring the
  // linked V/A from the source project item. Supports the single-recording shape;
  // verified server-side via reconcile, with Cmd+Z as the human fallback.

  function findProjectItemByPath(path) {
    // Prefer a project item already referenced on the timeline (most reliable).
    var seq = app.project.activeSequence;
    var i, j;
    if (seq) {
      for (i = 0; i < seq.videoTracks.numTracks; i++) {
        var tr = seq.videoTracks[i];
        for (j = 0; j < tr.clips.numItems; j++) {
          var c = tr.clips[j];
          try { if (c.projectItem && samePath(c.projectItem.getMediaPath(), path)) return c.projectItem; } catch (e) {}
        }
      }
    }
    return walkForPath(app.project.rootItem, path); // else walk the project bin
  }

  function walkForPath(item, path) {
    if (!item) return null;
    var n = 0;
    try { n = item.children ? item.children.numItems : 0; } catch (e) { n = 0; }
    for (var k = 0; k < n; k++) {
      var ch = item.children[k];
      try { if (ch && ch.getMediaPath && samePath(ch.getMediaPath(), path)) return ch; } catch (e2) {}
      var deep = walkForPath(ch, path);
      if (deep) return deep;
    }
    return null;
  }

  // Steer a project item's source in/out to [inSec,outSec] for the next insert.
  // setInPoint/setOutPoint signatures vary by version, so try the common forms;
  // placed timeline items keep their own in/out, so this is safe best-effort.
  function setItemInOut(pItem, inSec, outSec, inTicks, outTicks) {
    var forms = [
      function () { pItem.setInPoint(String(inTicks), 4); pItem.setOutPoint(String(outTicks), 4); },
      function () { pItem.setInPoint(inSec, 4); pItem.setOutPoint(outSec, 4); },
      function () { pItem.setInPoint(inSec); pItem.setOutPoint(outSec); },
      function () { pItem.setInPoint(makeTime(inSec), 4); pItem.setOutPoint(makeTime(outSec), 4); },
      function () { pItem.setInPoint(secToTicksStr(inSec), 4); pItem.setOutPoint(secToTicksStr(outSec), 4); }
    ];
    for (var i = 0; i < forms.length; i++) { try { forms[i](); return true; } catch (e) {} }
    return false;
  }

  function setTargetTracks(seq, vIdx) {
    var saved = { v: [], a: [] };
    var i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
      var vt = seq.videoTracks[i];
      try { saved.v.push(vt.isTargeted()); } catch (e) { saved.v.push(null); }
      try { vt.setTargeted(i === vIdx, true); } catch (e2) {}
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      var at = seq.audioTracks[i];
      try { saved.a.push(at.isTargeted()); } catch (e3) { saved.a.push(null); }
      try { at.setTargeted(i === 0, true); } catch (e4) {}
    }
    return saved;
  }

  function restoreTargetTracks(seq, saved) {
    if (!saved) return;
    var i;
    for (i = 0; i < seq.videoTracks.numTracks && i < saved.v.length; i++) {
      if (saved.v[i] != null) { try { seq.videoTracks[i].setTargeted(saved.v[i], true); } catch (e) {} }
    }
    for (i = 0; i < seq.audioTracks.numTracks && i < saved.a.length; i++) {
      if (saved.a[i] != null) { try { seq.audioTracks[i].setTargeted(saved.a[i], true); } catch (e2) {} }
    }
  }

  function reinsertSegment(p) {
    var seq = requireSeq();
    if (typeof seq.insertClip !== "function") {
      throw new Error("This Premiere build has no sequence.insertClip — re-insert isn't supported here.");
    }
    var timebase = Number(seq.timebase);
    var vIdx = p.trackIndex != null ? p.trackIndex : 0;

    var pItem = findProjectItemByPath(p.mediaPath);
    if (!pItem) throw new Error("Couldn't find the source clip in the project to re-insert.");

    // Snap target + source range to whole frames so the insert lands on a clip edge
    // (never one frame inside a neighbor, which would split it).
    function snapFrame(sec) { return tickFrames(secToTicksStr(sec), timebase); }
    var targetFrame = p.targetFrame != null ? Math.round(p.targetFrame) : snapFrame(p.targetSeconds != null ? p.targetSeconds : 0);
    var targetTicks = targetFrame * timebase;
    var targetSec = targetTicks / TPS;
    var inTicks = p.sourceInTicks != null ? Number(p.sourceInTicks) : snapFrame(p.sourceInSec) * timebase;
    var outTicks = p.sourceOutTicks != null ? Number(p.sourceOutTicks) : snapFrame(p.sourceOutSec) * timebase;
    var inSec = inTicks / TPS;
    var outSec = outTicks / TPS;

    var savedIn = null, savedOut = null;
    try { savedIn = pItem.getInPoint(); } catch (e) {}
    try { savedOut = pItem.getOutPoint(); } catch (e) {}
    setItemInOut(pItem, inSec, outSec, inTicks, outTicks);

    var targeting = setTargetTracks(seq, vIdx);
    var err = null;
    try {
      seq.insertClip(pItem, frameTime(targetFrame, timebase), vIdx, 0);
    } catch (e1) {
      // some builds reject explicit track indices — retry relying on targeting
      try { seq.insertClip(pItem, frameTime(targetFrame, timebase)); } catch (e2) { err = String(e2 && e2.message ? e2.message : e2); }
    }
    restoreTargetTracks(seq, targeting);
    if (savedIn != null && savedOut != null) {
      try { setItemInOut(pItem, savedIn.seconds, savedOut.seconds, savedIn.ticks, savedOut.ticks); } catch (e3) {}
    }

    if (err) throw new Error("insertClip failed: " + err);

    // Report the clip now sitting at the target so the server can sanity-check.
    var placed = null;
    var vt2 = seq.videoTracks[vIdx];
    if (vt2) {
      for (var j = 0; j < vt2.clips.numItems; j++) {
        var c2 = vt2.clips[j];
        if (tickFrames(c2.start.ticks, timebase) === targetFrame) {
          placed = { start: c2.start.seconds, end: c2.end.seconds, inPoint: c2.inPoint.seconds, outPoint: c2.outPoint.seconds };
          break;
        }
      }
    }
    return { ok: true, targetSeconds: targetSec, targetFrame: targetFrame, placed: placed };
  }

  // ---- Soft Apply: non-destructive colored markers (Retakes tab) ----
  // TrackItem (timeline clip) label colors aren't settable via the API (Adobe DVAPR-4217788),
  // so we annotate the timeline with SEQUENCE MARKERS (color + name + comments + duration).
  // Every marker we create carries a sentinel at the START of its comments, so clear/replace
  // only ever touches OUR markers — never the user's own.

  function collectTaggedMarkers(markers, sentinel) {
    var mine = [];
    var mk = null;
    try { mk = markers.getFirstMarker(); } catch (e) { return mine; }
    while (mk) {
      var c = "";
      try { c = mk.comments ? String(mk.comments) : ""; } catch (e2) { c = ""; }
      if (c.indexOf(sentinel) === 0) mine.push(mk);
      try { mk = markers.getNextMarker(mk); } catch (e3) { mk = null; }
    }
    return mine;
  }

  function deleteTaggedMarkers(markers, sentinel) {
    // Collect first, then delete — deleting mid-walk breaks getNextMarker().
    var mine = collectTaggedMarkers(markers, sentinel);
    var removed = 0;
    for (var i = 0; i < mine.length; i++) {
      try { markers.deleteMarker(mine[i]); removed++; } catch (e) {}
    }
    return removed;
  }

  function setMarkerSpan(mk, endSec) {
    // marker.end wants a Seconds value (not a replacement Time); fall back to .end.seconds.
    try { mk.end = endSec; return true; } catch (e) {}
    try { mk.end.seconds = endSec; return true; } catch (e2) {}
    return false;
  }

  function markerIndexOf(markers, target) {
    // Position of `target` within the collection (for the 2-arg setColorByIndex form),
    // computed so a fallback NEVER recolors someone else's marker.
    var idx = 0, mk = null;
    try { mk = markers.getFirstMarker(); } catch (e) { return -1; }
    while (mk) {
      if (mk === target) return idx;
      idx++;
      try { mk = markers.getNextMarker(mk); } catch (e2) { return -1; }
    }
    return -1;
  }

  function setMarkerColor(markers, mk, colorIndex) {
    if (colorIndex == null) return false;
    // setColorByIndex is version-finicky: most builds take just (colorIndex) called on the
    // marker (works in the CEP/ExtendScript sample); some signatures want (colorIndex,
    // markerIndex). Try the safe 1-arg form first; the 2-arg fallback passes the marker's
    // OWN index so it can't touch a user marker. If neither works the marker is simply left
    // its default color (still labeled). The Phase-0 probe confirms which form colors.
    try { mk.setColorByIndex(colorIndex); return true; } catch (e) {}
    try {
      var oi = markerIndexOf(markers, mk);
      if (oi >= 0) { mk.setColorByIndex(colorIndex, oi); return true; }
    } catch (e2) {}
    return false;
  }

  function clearEditMarkers(p) {
    var seq = requireSeq();
    var sentinel = p && p.sentinel ? String(p.sentinel) : "OpenCutAgent";
    var removed = deleteTaggedMarkers(seq.markers, sentinel);
    removed += deleteTaggedMarkers(seq.markers, "EditAgent"); // pre-rename markers
    return { removed: removed };
  }

  function applyEditMarkers(p) {
    var seq = requireSeq();
    var markers = seq.markers;
    var sentinel = p && p.sentinel ? String(p.sentinel) : "OpenCutAgent";
    var list = p && p.markers ? p.markers : [];

    // Idempotent: drop our previous markers first so re-running replaces cleanly.
    var cleared = deleteTaggedMarkers(markers, sentinel);
    if (!p.scopeOnly) cleared += deleteTaggedMarkers(markers, "EditAgent"); // pre-rename markers

    var created = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var mk = null;
      try { mk = markers.createMarker(m.startSec); } catch (e) { continue; }
      if (!mk) continue;
      try { if (m.name != null) mk.name = String(m.name); } catch (e2) {}
      try { mk.comments = String(m.comment != null ? m.comment : sentinel); } catch (e3) {}
      if (m.endSec != null && m.endSec > m.startSec) setMarkerSpan(mk, m.endSec);
      setMarkerColor(markers, mk, m.colorIndex);
      created++;
    }
    return { created: created, cleared: cleared };
  }

  function applyReviewMarkers(p) {
    assertRetakeGeometry(p, false);
    if (p.sentinel !== "OpenCutAgent:RetakeReview:v1") throw new Error("Invalid review marker scope.");
    p.scopeOnly = true;
    var list = p.markers || [], i;
    // Validate everything before clearing the old run's markers.
    for (i = 0; i < list.length; i++) {
      if (!isFinite(list[i].startSec) || !isFinite(list[i].endSec) || list[i].startSec < 0 || list[i].endSec < list[i].startSec || String(list[i].comment).indexOf(p.sentinel) !== 0) throw new Error("Invalid review marker.");
    }
    var result = applyEditMarkers(p), seq = requireSeq();
    var actual = collectTaggedMarkers(seq.markers, p.sentinel), records = [];
    for (i = 0; i < actual.length; i++) {
      try { records.push({ startSec: actual[i].start.seconds, endSec: actual[i].end.seconds, name: actual[i].name, comment: actual[i].comments }); } catch (e) {}
    }
    var sort = function(a,b) { return a.startSec - b.startSec || a.endSec - b.endSec || (a.comment < b.comment ? -1 : a.comment > b.comment ? 1 : 0); };
    records.sort(sort); list.sort(sort);
    var ok = records.length === list.length && result.created === list.length;
    var epsilon = Number(seq.timebase) / TPS;
    for (i = 0; ok && i < list.length; i++) {
      ok = Math.abs(records[i].startSec - list[i].startSec) <= epsilon && Math.abs(records[i].endSec - list[i].endSec) <= epsilon && records[i].name === list[i].name && records[i].comment === list[i].comment;
    }
    result.verified = ok;
    return result;
  }

  // ---- XML round-trip export (fast apply that PRESERVES effects) ----
  // Premiere serializes the REAL sequence to FCP7 XML (Motion/opacity/volume
  // filters, transitions — everything the format can carry); the server edits
  // timing only and reimports. 2-arg form FIRST: (path, suppressDialog) —
  // without it Premiere pops a modal "Translation Report" alert for benign
  // untranslatables (e.g. the intrinsic "MPEG Source Settings" effect, which
  // the export drops anyway). Fallback to the 1-arg form on old builds.
  function exportXmlSequence(p) {
    var seq = requireSeq();
    if (!p || !p.path) throw new Error("exportXmlSequence: missing path");
    var err = null;
    var ok = false;
    try {
      ok = seq.exportAsFinalCutProXML(p.path, 1) !== false;
    } catch (e) {
      try {
        ok = seq.exportAsFinalCutProXML(p.path) !== false;
      } catch (e2) {
        err = String(e2 && e2.message ? e2.message : e2);
      }
    }
    var f = new File(p.path);
    if (!f.exists) throw new Error("Premiere did not write the XML export" + (err ? ": " + err : "."));
    return { ok: true, path: p.path, bytes: f.length };
  }

  // ---- XML rebuild import (TimeBolt-style fast apply) ----
  // The server generates an FCP7 XML (xmeml) of the FINISHED, tightened
  // sequence; importing it is ONE native Premiere operation that takes seconds
  // regardless of cut count (vs thousands of razor/remove/move DOM calls). The
  // original sequence is never touched. We import, then find + open the newest
  // sequence with the expected name.
  function importXmlSequence(p) {
    var proj = app.project;
    if (!proj) throw new Error("No project is open in Premiere.");
    var before = proj.sequences.numSequences;
    var imported = false;
    var err = null;
    try {
      imported = proj.importFiles([p.path], true, proj.rootItem, false);
    } catch (e) {
      try { imported = proj.importFiles([p.path]); } catch (e2) { err = String(e2 && e2.message ? e2.message : e2); }
    }
    var after = proj.sequences.numSequences;

    // newest sequence matching the name (last match wins — reruns duplicate names)
    var target = null;
    for (var i = 0; i < after; i++) {
      var s = proj.sequences[i];
      try { if (String(s.name) === String(p.sequenceName)) target = s; } catch (e3) {}
    }
    var opened = false;
    if (target) {
      try { opened = proj.openSequence(target.sequenceID) === true; } catch (e4) {}
      if (!opened) { try { proj.activeSequence = target; opened = true; } catch (e5) {} }
    }
    return {
      ok: after > before || !!target,
      imported: after - before,
      opened: opened,
      sequenceName: target ? String(target.name) : null,
      error: err
    };
  }

  function runScript(p) {
    var r = eval(p.jsx); // escape hatch — runs arbitrary ExtendScript by design
    return r === undefined ? null : r;
  }

  var handlers = {
    ping: ping,
    getTimelineState: getTimelineState,
    trimClip: trimClip,
    removeGaps: removeGaps,
    removeRange: removeRange,
    duplicateRetakeSequence: duplicateRetakeSequence,
    removeRangesBatch: removeRangesBatch,
    closeRangeGaps: closeRangeGaps,
    muteRange: muteRange,
    setPlayhead: setPlayhead,
    getPlayhead: getPlayhead,
    reinsertSegment: reinsertSegment,
    restoreTimeline: restoreTimeline,
    applyEditMarkers: applyEditMarkers,
    applyReviewMarkers: applyReviewMarkers,
    clearEditMarkers: clearEditMarkers,
    exportXmlSequence: exportXmlSequence,
    importXmlSequence: importXmlSequence,
    runScript: runScript
  };

  function dispatch(action, params) {
    try {
      if (!params) params = {};
      var fn = handlers[action];
      if (!fn) return stringify({ status: "FAILURE", error: "Unknown action: " + action });
      var result = fn(params);
      return stringify({ status: "OK", result: result === undefined ? null : result });
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      if (e && e.line != null) msg += " (line " + e.line + ")";
      return stringify({ status: "FAILURE", error: msg });
    }
  }

  return { dispatch: dispatch };
})();
