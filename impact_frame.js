// ============================================================
// impact_frame.js — impact-frame labeler, one frame index per punch
//
// A focused duplicate of punch_dir_16.js. Same candidate source (Combined
// Data via listPunchesForVideo — offensive punches only; slips/rolls and
// other defensive events are excluded), same queue / progress /
// optimistic-save machinery, but the label is the absolute frame index
// (in the source video) where the glove first touches the bag.
// Saved to the "Impact Frames" sheet via saveImpactFrame / listImpactFrames /
// deleteImpactFrame Apps Script actions.
//
// Interaction: the punch loops as a slow-motion clip (±0.5s around the event
// window). Enter captures the currently displayed frame and pauses; ←/→
// nudge by single frames; Enter/Space confirms and advances. U undoes.
// S then 1/2/3 skips with a reason (occluded / unclear / bad_clip).
//
// Reuses player.js for the video chrome, sheetUrl(), and shared `state`.
// ============================================================

const SKIP_REASONS = [
  { key: '1', reason: 'occluded', label: 'occluded' },
  { key: '2', reason: 'unclear', label: 'unclear' },
  { key: '3', reason: 'no_punch', label: 'no punch in clip' },
];

const SPEED_CYCLE = [0.25, 0.5, 1];

// Loop the labelled punch window. 0/0 lead-in/trail-out = pure punch only.
const PUNCH_LEAD_IN_SEC = 0;
const PUNCH_TRAIL_OUT_SEC = 0;

Object.assign(state, {
  knownVideos: [],          // from videos.json — only source of labelable videos
  currentStem: null,
  videoFps: null,           // from videos.json for the current stem
  candidates: [],           // all punches for the current video, chronological
  cursor: 0,
  doneKeys: new Set(),
  labelByKey: new Map(),    // key -> { impact_frame: int|null, skip_reason: string|null }
  coverageByUuid: new Map(),       // current video: punch_uuid -> Set<labeler>
  videoLoaded: false,
  labelCountsByVideo: new Map(),   // stem -> total punches labeled by anyone
  mode: 'scrub',            // 'scrub' | 'captured' | 'skipping'
  capturedFrame: null,      // absolute frame index while mode === 'captured'
  autoJumpOnSync: false,    // hop to first unlabeled punch when the sheet sync lands
  lastMediaTime: null,      // PTS of the most recently presented frame (rVFC)
});

function keyFor(c) {
  return c ? 'p:' + c.punch_uuid : null;
}

function fpsNow() {
  return state.videoFps || (1 / state.frameDuration);
}

function formatImpactLabel(v) {
  if (v === undefined) return 'unlabeled';
  if (v.skip_reason) return 'skip:' + v.skip_reason;
  return 'f ' + v.impact_frame;
}

// Offense only — slips / rolls / pull-backs / step-backs / "unsure" have no
// impact frame. Whitelist by punch family so future defense types are
// excluded automatically.
function isPunch(punchType) {
  const t = String(punchType || '').toLowerCase();
  return t.startsWith('jab') || t.startsWith('cross') ||
         t.startsWith('lead_hook') || t.startsWith('rear_hook') ||
         t.startsWith('lead_uppercut') || t.startsWith('rear_uppercut');
}

// ─── candidate fetch (Combined Data, offensive punches) ────────────────────
// Mirrors dump_labels.py's timestamp parser since the Sheet stores mm:ss(.mmm)
// or numeric seconds.
function parseTimestamp(ts) {
  if (ts === null || ts === undefined) return NaN;
  const s = String(ts).trim().replace(/^['"]|['"]$/g, '').replace(',', '.');
  if (s.indexOf(':') !== -1) {
    const parts = s.split(':');
    try {
      if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
      if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } catch (_) { return NaN; }
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : NaN;
}

async function fetchPunchCandidates(videoStem) {
  const url = sheetUrl({ action: 'listPunchesForVideo', video: videoStem });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listPunchesForVideo HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listPunchesForVideo: ' + (body.message || 'unknown'));
  const out = [];
  for (const r of body.punches || []) {
    if (!isPunch(r.label)) continue;
    const start = parseTimestamp(r.start_sec);
    const end   = parseTimestamp(r.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      punch_uuid: r.punch_uuid,
      video_name: r.video_name,
      punch_type: r.label,
      stance: (r.stance || '').toLowerCase(),
      start_sec: start,
      end_sec: end,
    });
  }
  out.sort((a, b) => a.start_sec - b.start_sec);   // chronological
  return out;
}

// ─── sheet sync (Impact Frames) ────────────────────────────────────────────
async function fetchImpactFrames(video, labeler) {
  const url = sheetUrl({ action: 'listImpactFrames', video, labeler });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listImpactFrames HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listImpactFrames: ' + (body.message || 'unknown'));
  return body.rows;
}
async function saveImpactFrame({ labeler, video, punch_uuid, impact_frame, skip_reason }) {
  const params = { action: 'saveImpactFrame', labeler, video, punch_uuid };
  params.impact_frame = (impact_frame === null || impact_frame === undefined) ? '' : String(impact_frame);
  params.skip_reason = skip_reason || '';
  params.fps = String(Math.round(fpsNow() * 1000) / 1000);
  const url = sheetUrl(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error('saveImpactFrame HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('saveImpactFrame: ' + (body.message || 'unknown'));
  return body;
}
async function deleteImpactFrame({ labeler, punch_uuid }) {
  const url = sheetUrl({ action: 'deleteImpactFrame', labeler, punch_uuid });
  const res = await fetch(url);
  if (!res.ok) throw new Error('deleteImpactFrame HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('deleteImpactFrame: ' + (body.message || 'unknown'));
  return body;
}

// ─── UI helpers ────────────────────────────────────────────────────────────
function setStatus(text, cls) {
  const el = document.getElementById('impact-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'err');
  if (cls) el.classList.add(cls);
}
function setCurrentLine(text) {
  const el = document.getElementById('impact-current');
  if (el) el.textContent = text;
}
function setModeBadge(text) {
  const el = document.getElementById('video-mode');
  if (el) el.textContent = text;
}

function describeCandidate(c, totalLabel, labelTxt) {
  if (!c) return '';
  const type = c.punch_type || '?';
  const stance = c.stance ? ` · ${c.stance}` : '';
  const window = `${c.start_sec.toFixed(2)}–${c.end_sec.toFixed(2)}s`;
  return `${type}${stance} · ${window} · ${labelTxt} · ${totalLabel}`;
}

// ─── frame HUD + state banner (on-video) ───────────────────────────────────
function displayedFrameNow() {
  const video = document.getElementById('video-player');
  if (!video) return null;
  const f = fpsNow();
  if (state.lastMediaTime !== null && state.lastMediaTime !== undefined) {
    return Math.round(state.lastMediaTime * f);
  }
  return Math.floor(video.currentTime * f + 1e-3);
}

function clipFrameBounds() {
  const lw = state.loopWindow;
  if (!lw) return null;
  const f = fpsNow();
  const start = Math.max(0, Math.floor(lw.start * f + 1e-3));
  const end = Math.floor(lw.end * f + 1e-3);
  return { start, end, total: end - start + 1 };
}

function updateHud() {
  const hud = document.getElementById('impact-hud');
  if (!hud) return;
  const bounds = clipFrameBounds();
  const abs = displayedFrameNow();
  if (!bounds || abs === null) {
    hud.textContent = '— no punch —';
    return;
  }
  const fpsTxt = (Math.round(fpsNow() * 10) / 10) + 'fps';
  if (abs < bounds.start || abs > bounds.end) {
    hud.textContent = `outside clip · abs ${abs} · ${fpsTxt}`;
    return;
  }
  const rel = abs - bounds.start + 1;
  hud.textContent = `clip ${rel}/${bounds.total} · abs ${abs} · ${fpsTxt}`;
}

function setBanner(text, cls) {
  const banner = document.getElementById('impact-banner');
  if (!banner) return;
  if (!text) {
    banner.className = 'hidden';
    banner.textContent = '';
    return;
  }
  banner.textContent = text;
  banner.className = cls || '';
}

function updateCapturePanel() {
  const el = document.getElementById('impact-state');
  if (!el) return;
  el.classList.toggle('captured', state.mode === 'captured');
  if (state.mode === 'captured') {
    el.innerHTML = `Captured <b>frame ${state.capturedFrame}</b>.<br>` +
      '<b>&larr;/&rarr;</b> nudge · <b>Enter</b>/<b>Space</b> confirm · <b>Esc</b> cancel';
  } else if (state.mode === 'skipping') {
    el.innerHTML = 'Skip reason: <b>1</b> occluded · <b>2</b> unclear · <b>3</b> no punch in clip · <b>Esc</b> cancel';
  } else {
    const c = state.candidates[state.cursor];
    const existing = c ? state.labelByKey.get(keyFor(c)) : undefined;
    if (existing !== undefined) {
      // Already-labelled punch: unmissable on-video banner + colored panel text.
      const isSkip = !!existing.skip_reason;
      setBanner(isSkip ? `SKIPPED: ${existing.skip_reason}` : `LABELED f ${existing.impact_frame}`,
                isSkip ? 'skipping' : 'captured');
      el.innerHTML = `Saved: <b class="${isSkip ? 'lbl-skip' : 'lbl-done'}">${formatImpactLabel(existing)}</b>.<br>` +
        '<b>Enter</b> re-captures (overwrites) · <b>U</b> clears';
    } else {
      setBanner(null);
      el.innerHTML = c ? 'Play the loop, hit <b>Enter</b> on the impact frame.' : '—';
    }
  }
}

// player.js probes this hook on every time update.
function updateVideoOverlay() {
  updateHud();
}

// ─── candidate generation ────────────────────────────────────────────────
async function tryGenerateCandidates() {
  if (!state.currentStem) {
    setCurrentLine('— pick a video name to begin —');
    setModeBadge('no video');
    return;
  }
  if (!state.videoLoaded) {
    setCurrentLine('Video name set: "' + state.currentStem + '". Now load the local .mp4 file.');
    return;
  }
  const known = state.knownVideos.find(v => v.stem === state.currentStem);
  state.videoFps = (known && known.rounds && known.rounds[0]) ? known.rounds[0].fps : null;
  state.cursor = 0;
  state.doneKeys = new Set();
  state.labelByKey = new Map();
  state.coverageByUuid = new Map();
  enterScrub();
  setStatus('—');

  state.candidates = [];
  setModeBadge('fetching…');
  setCurrentLine('Loading punches from Combined Data for "' + state.currentStem + '"…');
  try {
    state.candidates = await fetchPunchCandidates(state.currentStem);
  } catch (e) {
    setModeBadge('error');
    setCurrentLine('Failed to load punches: ' + e.message);
    setStatus(e.message, 'err');
    return;
  }
  if (state.candidates.length === 0) {
    setModeBadge('0 punches');
    setCurrentLine('No labelled punches in Combined Data for "' + state.currentStem + '".');
    redrawProgress();
    return;
  }
  setModeBadge(state.candidates.length + ' punches');
  redrawProgress();
  // Loop the first punch immediately — don't make the labeler sit through the
  // (slow) sheet sync; it fills in existing labels in the background and then
  // hops to the first unlabeled punch.
  state.cursor = 0;
  seekToCurrent();
  state.autoJumpOnSync = true;
  syncFromSheet();
}

async function syncFromSheet() {
  if (!state.currentStem || !state.candidates.length) return;
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) {
    setStatus('Type your name above before labelling.', 'err');
    return;
  }
  try {
    setStatus('Loading existing labels…');
    // Pull every labeler's rows for this video: the in-video UX (progress,
    // next-unlabeled) reflects only YOUR labels, but the dropdown count is the
    // total of punches labeled by anyone (deduped by punch_uuid).
    const rows = await fetchImpactFrames(state.currentStem, '');
    state.doneKeys = new Set();
    state.labelByKey = new Map();
    state.coverageByUuid = new Map();
    for (const r of rows) {
      let who = state.coverageByUuid.get(r.punch_uuid);
      if (!who) { who = new Set(); state.coverageByUuid.set(r.punch_uuid, who); }
      who.add(r.labeler);
      if (r.labeler === labeler) {
        const k = 'p:' + r.punch_uuid;
        state.doneKeys.add(k);
        state.labelByKey.set(k, { impact_frame: r.impact_frame, skip_reason: r.skip_reason });
      }
    }
    setStatus(`Loaded ${state.doneKeys.size} of your label(s) · ${state.coverageByUuid.size} labeled in total.`, 'ok');
    updateOptionCount(state.currentStem, state.coverageByUuid.size);
    // On initial load, hop to the first unlabeled punch — unless the labeler
    // already started navigating/capturing while the sync was in flight, or
    // it IS the punch already looping (no pointless loop restart).
    if (state.autoJumpOnSync && state.mode === 'scrub') {
      const firstIdx = state.candidates.findIndex(cc => !state.doneKeys.has(keyFor(cc)));
      if (firstIdx !== state.cursor) advanceToNextUnlabeled(0);   // also handles all-labelled
    }
    // Refresh the current punch's text with any label the sync brought in,
    // but don't re-seek — the punch is already looping (and the labeler may
    // be mid-capture).
    const c = state.candidates[state.cursor];
    if (c) {
      const total = `${state.cursor + 1}/${state.candidates.length}`;
      setCurrentLine(describeCandidate(c, total, formatImpactLabel(state.labelByKey.get(keyFor(c)))));
    }
    updateCapturePanel();
    redrawProgress();
  } catch (e) {
    setStatus("Couldn't fetch labels: " + e.message, 'err');
  }
  state.autoJumpOnSync = false;
}

function advanceToNextUnlabeled(fromIdx) {
  const N = state.candidates.length;
  if (N === 0) return;
  for (let i = 0; i < N; i++) {
    const idx = (fromIdx + i) % N;
    const c = state.candidates[idx];
    if (!state.doneKeys.has(keyFor(c))) {
      state.cursor = idx;
      seekToCurrent();
      return;
    }
  }
  state.cursor = N;
  setCurrentLine('All punches labelled for this video — pick another, or use Prev to review.');
}

function enterScrub() {
  state.mode = 'scrub';
  state.capturedFrame = null;
  setBanner(null);
  updateCapturePanel();
}

function seekToCurrent() {
  if (!state.candidates.length) return;
  enterScrub();
  if (state.cursor >= state.candidates.length) {
    state.loopWindow = null;
    updateHud();
    return;
  }
  const c = state.candidates[state.cursor];
  const video = document.getElementById('video-player');
  const start = Math.max(0, c.start_sec - PUNCH_LEAD_IN_SEC);
  let end = c.end_sec + PUNCH_TRAIL_OUT_SEC;
  if (video && !isNaN(video.duration) && video.duration > 0) end = Math.min(end, video.duration);
  state.loopWindow = { start, end };

  if (video && !isNaN(video.duration) && video.duration > 0) {
    video.currentTime = Math.min(Math.max(0, start), video.duration);
    if (video.paused) {
      const pp = video.play();
      if (pp && typeof pp.catch === 'function') pp.catch(() => {});
    }
  }
  const label = state.labelByKey.get(keyFor(c));
  const total = `${state.cursor + 1}/${state.candidates.length}`;
  setCurrentLine(describeCandidate(c, total, formatImpactLabel(label)));
  updateCapturePanel();
  updateHud();
}

// ─── capture / confirm / skip / undo ───────────────────────────────────────
function requireLabeler() {
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) {
    setStatus('Type your name first.', 'err');
    document.getElementById('labeler-input').focus();
    return null;
  }
  return labeler;
}

function captureFrame() {
  state.autoJumpOnSync = false;
  if (!state.currentStem || !state.candidates.length) {
    setStatus('Pick a video and load the file first.', 'err'); return;
  }
  const c = state.candidates[state.cursor];
  if (!c) return;
  const video = document.getElementById('video-player');
  const bounds = clipFrameBounds();
  let frame = displayedFrameNow();
  if (frame === null || !bounds) return;
  frame = Math.max(bounds.start, Math.min(bounds.end, frame));

  if (video && !video.paused) {
    video.pause();
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = 'Play';
  }
  state.mode = 'captured';
  state.capturedFrame = frame;
  seekToCapturedFrame();
  setBanner(`CAPTURED f ${frame} — ←/→ nudge · Enter confirm · Esc cancel`, 'captured');
  updateCapturePanel();
}

function seekToCapturedFrame() {
  const video = document.getElementById('video-player');
  if (!video || state.capturedFrame === null) return;
  // Mid-frame target so the seek reliably lands inside the frame's display
  // interval instead of on a boundary that floats could put either side of.
  video.currentTime = (state.capturedFrame + 0.5) / fpsNow();
}

function nudgeCaptured(delta) {
  const bounds = clipFrameBounds();
  if (!bounds || state.capturedFrame === null) return;
  state.capturedFrame = Math.max(bounds.start, Math.min(bounds.end, state.capturedFrame + delta));
  seekToCapturedFrame();
  setBanner(`CAPTURED f ${state.capturedFrame} — ←/→ nudge · Enter confirm · Esc cancel`, 'captured');
  updateCapturePanel();
}

function captureOrConfirm() {
  if (state.mode === 'captured') confirmCapture();
  else if (state.mode === 'scrub') captureFrame();
}

function confirmCapture() {
  if (state.mode !== 'captured' || state.capturedFrame === null) return;
  const labeler = requireLabeler();
  if (!labeler) return;
  persistLabel(labeler, { impact_frame: state.capturedFrame, skip_reason: null });
}

function beginSkip() {
  state.autoJumpOnSync = false;
  if (!state.currentStem || !state.candidates.length) return;
  const video = document.getElementById('video-player');
  if (video && !video.paused) {
    video.pause();
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = 'Play';
  }
  state.mode = 'skipping';
  state.capturedFrame = null;
  setBanner('SKIP: [1] occluded · [2] unclear · [3] no punch · [Esc] cancel', 'skipping');
  updateCapturePanel();
}

function skipWith(reason) {
  if (!state.currentStem || !state.candidates.length) return;
  const labeler = requireLabeler();
  if (!labeler) return;
  persistLabel(labeler, { impact_frame: null, skip_reason: reason });
}

function cancelToScrub() {
  enterScrub();
  const video = document.getElementById('video-player');
  if (video && video.paused && state.loopWindow) {
    const pp = video.play();
    if (pp && typeof pp.catch === 'function') pp.catch(() => {});
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = 'Pause';
  }
}

// Optimistic local update — advance immediately, save in the background,
// roll back on failure so the item resurfaces on the next sweep.
function persistLabel(labeler, label) {
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = keyFor(c);
  state.doneKeys.add(k);
  state.labelByKey.set(k, label);
  let who = state.coverageByUuid.get(c.punch_uuid);
  if (!who) { who = new Set(); state.coverageByUuid.set(c.punch_uuid, who); }
  who.add(labeler);
  state.pendingSaves = (state.pendingSaves || 0) + 1;
  redrawProgress();
  updateOptionCount(state.currentStem, state.coverageByUuid.size);
  setStatus('saving ' + formatImpactLabel(label) + '… (' + state.pendingSaves + ' pending)');

  gotoNext();

  saveImpactFrame({
    labeler,
    video: state.currentStem,
    punch_uuid: c.punch_uuid,
    impact_frame: label.impact_frame,
    skip_reason: label.skip_reason,
  }).then(() => {
    state.pendingSaves = Math.max(0, (state.pendingSaves || 1) - 1);
    setStatus(state.pendingSaves === 0 ? 'Saved.'
      : state.pendingSaves + ' save' + (state.pendingSaves === 1 ? '' : 's') + ' pending…',
      state.pendingSaves === 0 ? 'ok' : null);
  }).catch((e) => {
    state.pendingSaves = Math.max(0, (state.pendingSaves || 1) - 1);
    state.doneKeys.delete(k);
    state.labelByKey.delete(k);
    const who2 = state.coverageByUuid.get(c.punch_uuid);
    if (who2) { who2.delete(labeler); if (who2.size === 0) state.coverageByUuid.delete(c.punch_uuid); }
    redrawProgress();
    updateOptionCount(state.currentStem, state.coverageByUuid.size);
    setStatus('Save failed for ' + k + ': ' + e.message, 'err');
  });
}

// U: clear the current punch's saved label so it can be relabelled.
// (Esc — not U — backs out of a pending capture or the skip menu.)
async function undoAction() {
  if (state.mode === 'captured' || state.mode === 'skipping') {
    setStatus('Esc cancels the pending capture.', null);
    return;
  }
  if (!state.currentStem) return;
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) return;
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = keyFor(c);
  if (!state.doneKeys.has(k)) {
    setStatus('Nothing to undo on this punch.', null);
    return;
  }
  state.doneKeys.delete(k);
  state.labelByKey.delete(k);
  const who = state.coverageByUuid.get(c.punch_uuid);
  if (who) { who.delete(labeler); if (who.size === 0) state.coverageByUuid.delete(c.punch_uuid); }
  redrawProgress();
  updateOptionCount(state.currentStem, state.coverageByUuid.size);
  updateCapturePanel();
  const total = `${state.cursor + 1}/${state.candidates.length}`;
  setCurrentLine(describeCandidate(c, total, 'unlabeled'));
  try {
    await deleteImpactFrame({ labeler, punch_uuid: c.punch_uuid });
    setStatus("Cleared this punch's label — relabel now.", 'ok');
  } catch (e) {
    setStatus('Clear failed: ' + e.message, 'err');
  }
}

function gotoPrev() {
  state.autoJumpOnSync = false;
  if (!state.candidates.length) return;
  state.cursor = Math.max(0, state.cursor - 1);
  seekToCurrent();
}

// Sequential next — moves to the following punch whether or not it's labelled.
function gotoNext() {
  state.autoJumpOnSync = false;
  if (!state.candidates.length) return;
  state.cursor = Math.min(state.candidates.length - 1, state.cursor + 1);
  seekToCurrent();
}

function gotoFirst() {
  state.autoJumpOnSync = false;
  if (!state.candidates.length) return;
  state.cursor = 0;
  seekToCurrent();
}

function gotoNextUnlabeled() {
  state.autoJumpOnSync = false;
  advanceToNextUnlabeled(state.cursor + 1);
}

function cycleSpeed() {
  const cur = state.playbackRate || 0.25;
  const i = SPEED_CYCLE.indexOf(cur);
  setSpeed(SPEED_CYCLE[(i + 1) % SPEED_CYCLE.length]);
}

function redrawProgress() {
  const N = state.candidates.length;
  const labelled = state.doneKeys.size;
  const bar = document.getElementById('impact-bar');
  if (bar) bar.style.width = N ? (100 * labelled / N).toFixed(1) + '%' : '0%';
  const pt = document.getElementById('impact-progress-text');
  if (pt) pt.textContent = N ? labelled + ' / ' + N + ' labelled' : 'no candidates';
  let framed = 0;
  const skips = {};
  for (const v of state.labelByKey.values()) {
    if (v.skip_reason) skips[v.skip_reason] = (skips[v.skip_reason] || 0) + 1;
    else framed++;
  }
  const parts = [];
  if (framed) parts.push('impact: ' + framed);
  for (const s of SKIP_REASONS) if (skips[s.reason]) parts.push(s.reason + ': ' + skips[s.reason]);
  document.getElementById('impact-dist').textContent = parts.length ? parts.join(' · ') : '—';
}

// ─── calibration export — one CSV per labeler ──────────────────────────────
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportPerLabelerCsvs() {
  setStatus('Fetching all impact labels…');
  let rows;
  try {
    rows = await fetchImpactFrames('', '');
  } catch (e) {
    setStatus('Export failed: ' + e.message, 'err');
    return;
  }
  const byLabeler = new Map();
  for (const r of rows) {
    let list = byLabeler.get(r.labeler);
    if (!list) { list = []; byLabeler.set(r.labeler, list); }
    list.push(r);
  }
  if (byLabeler.size === 0) {
    setStatus('No impact labels to export yet.', 'err');
    return;
  }
  const header = ['labeler', 'video', 'punch_uuid', 'impact_frame', 'fps', 'skip_reason', 'ts'];
  let delay = 0;
  for (const [labeler, list] of byLabeler) {
    const lines = [header.join(',')];
    for (const r of list) {
      lines.push(header.map(h => csvCell(r[h])).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'impact_frames_' + labeler.replace(/[^\w-]+/g, '_') + '.csv';
    // Stagger the clicks — browsers drop back-to-back programmatic downloads.
    setTimeout(() => { a.click(); URL.revokeObjectURL(url); }, delay);
    delay += 300;
  }
  setStatus('Exported ' + byLabeler.size + ' labeler CSV(s).', 'ok');
}

// ─── dropdown / counts ──────────────────────────────────────────────────────
async function loadVideosConfig() {
  try {
    const res = await fetch('./videos.json', { cache: 'no-cache' });
    if (!res.ok) return { videos: [] };
    return await res.json();
  } catch {
    return { videos: [] };
  }
}

// Total punches labeled by ANY labeler, per video (deduped by punch_uuid so a
// punch labeled by several people still counts once). Drives the dropdown count.
async function fetchTotalCounts() {
  const counts = new Map();
  try {
    const url = sheetUrl({ action: 'listImpactFrames', labeler: '' });
    const res = await fetch(url);
    if (!res.ok) return counts;
    const body = await res.json();
    if (body.status !== 'ok') return counts;
    const uuidsByVideo = new Map();
    for (const r of body.rows || []) {
      let s = uuidsByVideo.get(r.video);
      if (!s) { s = new Set(); uuidsByVideo.set(r.video, s); }
      s.add(r.punch_uuid);
    }
    for (const [video, s] of uuidsByVideo) counts.set(video, s.size);
  } catch {}
  return counts;
}

function buildOptionText(stem, baseText, count) {
  let suffix = '';
  if (count > 0) suffix = ' · ' + count + ' labeled';
  return stem + ' (' + baseText + ')' + suffix;
}

function updateOptionCount(stem, count) {
  if (!stem) return;
  state.labelCountsByVideo.set(stem, count);
  const sel = document.getElementById('video-select');
  if (!sel) return;
  for (const opt of sel.querySelectorAll('option[data-stem]')) {
    if (opt.dataset.stem !== stem) continue;
    opt.textContent = buildOptionText(stem, opt.dataset.base || '', count);
    opt.classList.toggle('labeled', count > 0);
    return;
  }
}

function populateVideoSelect(cachedVideos, counts) {
  const sel = document.getElementById('video-select');
  if (!sel) return;
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— pick a video —';
  sel.appendChild(placeholder);

  const cachedActive = cachedVideos.filter(v => !v.heldOut);
  if (!cachedActive.length) return;
  const grp = document.createElement('optgroup');
  grp.label = 'Cached videos · impact frames';
  for (const v of cachedActive.slice().sort((a, b) => a.stem.localeCompare(b.stem))) {
    const opt = document.createElement('option');
    opt.value = v.stem;
    const n = (v.rounds || []).length;
    const baseText = n + ' round' + (n === 1 ? '' : 's');
    const count = counts.get(v.stem) || 0;
    opt.dataset.stem = v.stem;
    opt.dataset.base = baseText;
    opt.textContent = buildOptionText(v.stem, baseText, count);
    if (count > 0) opt.classList.add('labeled');
    grp.appendChild(opt);
  }
  sel.appendChild(grp);
}

async function refreshCountsAndDropdown() {
  const map = await fetchTotalCounts();
  state.labelCountsByVideo = map;
  populateVideoSelect(state.knownVideos, map);
}

// ─── wire-up ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupPlayer();
  setSpeed(0.25);   // slow motion by default; persists across video loads

  const labelerInput = document.getElementById('labeler-input');
  try { labelerInput.value = localStorage.getItem('orient_labeler_name') || ''; } catch {}
  labelerInput.addEventListener('change', async () => {
    try { localStorage.setItem('orient_labeler_name', labelerInput.value.trim()); } catch {}
    await refreshCountsAndDropdown();
    if (state.currentStem && state.candidates.length) syncFromSheet();
  });

  const cfg = await loadVideosConfig();
  state.knownVideos = cfg.videos || [];
  await refreshCountsAndDropdown();

  const selectEl = document.getElementById('video-select');
  selectEl.addEventListener('change', () => {
    state.currentStem = selectEl.value || null;
    if (!state.currentStem) { setModeBadge('no video'); return; }
    tryGenerateCandidates();
  });

  const video = document.getElementById('video-player');
  video.addEventListener('loadedmetadata', () => {
    state.videoLoaded = true;
    state.lastMediaTime = null;
    tryGenerateCandidates();
  });

  // Track the PTS of the most recently *presented* frame — this is what
  // "currently displayed frame" means for capture, exact even at 0.25x.
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const onFrame = (now, metadata) => {
      state.lastMediaTime = metadata.mediaTime;
      updateHud();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
  video.addEventListener('seeked', updateHud);

  // Loop the clip window while playing in scrub mode. Snap back to start when
  // playback runs past end; paused frame-stepping is never yanked back.
  video.addEventListener('timeupdate', () => {
    const lw = state.loopWindow;
    if (!lw || state.mode !== 'scrub' || video.paused) return;
    if (video.currentTime > lw.end + 0.05) video.currentTime = lw.start;
  });

  document.getElementById('btn-capture').addEventListener('click', captureOrConfirm);
  document.getElementById('btn-undo').addEventListener('click', undoAction);
  document.getElementById('btn-skip-occluded').addEventListener('click', () => skipWith('occluded'));
  document.getElementById('btn-skip-unclear').addEventListener('click', () => skipWith('unclear'));
  document.getElementById('btn-skip-nopunch').addEventListener('click', () => skipWith('no_punch'));
  document.getElementById('btn-first').addEventListener('click', gotoFirst);
  document.getElementById('btn-prev').addEventListener('click', gotoPrev);
  document.getElementById('btn-next').addEventListener('click', gotoNext);
  document.getElementById('btn-next-unlabeled').addEventListener('click', gotoNextUnlabeled);
  document.getElementById('btn-export').addEventListener('click', exportPerLabelerCsvs);

  // Buttons keep focus after a click; blur them so Enter/Space keep driving
  // the capture flow instead of re-clicking the focused button.
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (btn) btn.blur();
  });

  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (state.mode === 'skipping') {
      const m = SKIP_REASONS.find(s => s.key === e.key);
      if (m) { e.preventDefault(); skipWith(m.reason); return; }
      if (e.key === 'Escape' || e.key === 's' || e.key === 'S') { e.preventDefault(); cancelToScrub(); return; }
      return;
    }

    if (e.key === 'Enter') { e.preventDefault(); captureOrConfirm(); return; }
    if (e.key === ' ') {
      e.preventDefault();
      if (state.mode === 'captured') confirmCapture();
      else togglePlay();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (state.mode === 'captured') nudgeCaptured(-1); else stepFrames(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (state.mode === 'captured') nudgeCaptured(1); else stepFrames(1);
      return;
    }
    if (e.key === 'Escape') {
      if (state.mode === 'captured') { e.preventDefault(); cancelToScrub(); }
      return;
    }
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undoAction(); return; }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); beginSkip(); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); gotoNext(); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); gotoPrev(); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); gotoFirst(); return; }
    if (e.key === 'g' || e.key === 'G') { e.preventDefault(); gotoNextUnlabeled(); return; }
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); cycleSpeed(); return; }
  });

  setStatus('—');
  setCurrentLine('— pick a video to begin —');
});
