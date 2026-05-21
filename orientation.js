// ============================================================
// orientation.js — boxer facing-direction labeler page
//
// Reuses player.js for video player chrome + shared sheetUrl(). Two
// labeling modes share the same UI:
//
//   FRAME MODE (default)
//     Candidates = 5s-bucket sample frames from videos.json round meta,
//     shuffled deterministically per video. Each labels facing direction
//     at one specific frame. Saved to "Orientation Labels" sheet keyed by
//     (labeler, video, round, frame).
//
//   PUNCH MODE
//     Candidates = every labelled punch in Combined Data for the chosen
//     video (one per punch_uuid). Labels facing direction at the punch
//     (the boxer doesn't move within a punch — labeler picks any frame in
//     the window). Saved to "Punch Directions" sheet keyed by
//     (labeler, punch_uuid). Feeds boxing_ai/orientation_model/
//     07_punch_directions.py to test the ankle-arrow hypothesis.
//
// The candidate object carries a `kind` field — every per-candidate op
// (seek / save / fetch / delete / progress-key) dispatches on it.
// ============================================================

const BIN_KEYS = {
  "1": -45, "2": null, "3":  45,
  "4": -90, "5":   0, "6":  90,
  "7":-135, "8": 180, "9": 135,
};
const ANGLE_LIST = [0, 45, -45, 90, -90, 135, -135, -180];

Object.assign(state, {
  knownVideos: [],          // from videos.json — only source of labelable videos
  currentStem: null,
  currentMode: null,        // 'cached' (frame mode) | 'punch' | null
  mode: 'frame',            // user-chosen mode: 'frame' | 'punch'
  cachedVideo: null,        // videos.json entry for current stem
  punches: [],              // raw punches from Combined Data (punch mode)
  candidates: [],
  cursor: 0,
  doneKeys: new Set(),
  labelByKey: new Map(),
  videoLoaded: false,
  // stem → count of THIS labeler's existing labels for that video. Populated
  // once at startup (and whenever the labeler name changes); kept live as
  // applyKey / clearCurrent / syncFromSheet adjust the current video's count.
  // Frame and punch modes track separate maps so dropdown counts don't bleed.
  labelCountsByVideo: new Map(),         // frame-mode counts
  punchLabelCountsByVideo: new Map(),    // punch-mode counts
});

// ─── candidate dispatch helpers ────────────────────────────────────────────
// Every per-candidate operation dispatches on `kind`. Keeping the dispatch
// in one place means adding a third candidate type later means touching
// exactly these helpers, not every call site.

function keyFor(c) {
  if (!c) return null;
  if (c.kind === 'frame') return 'f:' + c.round + ':' + c.frame;
  if (c.kind === 'punch') return 'p:' + c.punch_uuid;
  return null;
}

function describeCandidate(c, totalLabel, labelTxt) {
  if (!c) return '';
  if (c.kind === 'frame') {
    return `round ${c.round} · frame ${c.frame} · ${labelTxt} · ${totalLabel}`;
  }
  // c.kind === 'punch'
  const type = c.punch_type || '?';
  const stance = c.stance ? ` · ${c.stance}` : '';
  const window = `${c.start_sec.toFixed(2)}–${c.end_sec.toFixed(2)}s`;
  return `${type}${stance} · ${window} · ${labelTxt} · ${totalLabel}`;
}

// ─── PRNG + frame samplers ─────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Frame mode: build from videos.json round meta.
function pickCachedCandidates(video, bucketSec = 5, cap = 100) {
  const seed = hashString(video.stem) >>> 0;
  const rng = mulberry32(seed);
  const candidates = [];
  for (const r of video.rounds || []) {
    const fps = Number(r.fps), n_frames = Number(r.n_frames);
    if (!(fps > 0) || !(n_frames > 0)) continue;
    const roundSec = n_frames / fps;
    const nBuckets = Math.max(1, Math.floor(roundSec / bucketSec));
    const framesPerBucket = n_frames / nBuckets;
    for (let b = 0; b < nBuckets; b++) {
      const lo = Math.floor(b * framesPerBucket);
      const hi = Math.min(n_frames - 1, Math.floor((b + 1) * framesPerBucket) - 1);
      if (hi < lo) continue;
      candidates.push({
        kind: 'frame',
        round: r.round ?? 0,
        frame: lo + Math.floor(rng() * (hi - lo + 1)),
      });
    }
  }
  if (candidates.length > cap) {
    shuffle(candidates, mulberry32(seed ^ 0xC0FFEE));
    candidates.length = cap;
  }
  shuffle(candidates, mulberry32(seed ^ 0xBADC0DE));
  return candidates;
}

// Punch mode: parse a mm:ss(.mmm) or numeric-seconds value into seconds.
// Mirrors dump_labels.py's parser since the Sheet stores either form.
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

// Punch mode: fetch Combined Data for the chosen video via Apps Script,
// shape each row into a candidate. Order = Sheet order so the labeler
// goes through the round chronologically (least cognitive context-switch).
async function fetchPunchCandidates(videoStem) {
  const url = sheetUrl({ action: 'listPunchesForVideo', video: videoStem });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listPunchesForVideo HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listPunchesForVideo: ' + (body.message || 'unknown'));
  const out = [];
  for (const r of body.punches || []) {
    const start = parseTimestamp(r.start_sec);
    const end   = parseTimestamp(r.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      kind: 'punch',
      punch_uuid: r.punch_uuid,
      video_name: r.video_name,
      punch_type: r.label,
      stance: (r.stance || '').toLowerCase(),
      start_sec: start,
      end_sec: end,
    });
  }
  // Stable chronological order.
  out.sort((a, b) => a.start_sec - b.start_sec);
  return out;
}

// ─── sheet sync ──────────────────────────────────────────────────────────
// Frame-mode (Orientation Labels sheet) — list/save/delete by (round, frame).
async function fetchOrientationLabels(video, labeler) {
  const url = sheetUrl({ action: 'listOrientation', video, labeler });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listOrientation HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listOrientation: ' + (body.message || 'unknown'));
  return body.rows;
}
async function saveOrientationLabel({ labeler, video, round, frame, label }) {
  const params = { action: 'saveOrientation', labeler, video, round, frame };
  params.label = (label === null || label === undefined) ? '' : String(label);
  const url = sheetUrl(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error('saveOrientation HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('saveOrientation: ' + (body.message || 'unknown'));
  return body;
}
async function deleteOrientationLabel({ labeler, video, round, frame }) {
  const url = sheetUrl({ action: 'deleteOrientation', labeler, video, round, frame });
  const res = await fetch(url);
  if (!res.ok) throw new Error('deleteOrientation HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('deleteOrientation: ' + (body.message || 'unknown'));
  return body;
}

// Punch-mode (Punch Directions sheet) — list/save/delete by punch_uuid.
async function fetchPunchDirections(video, labeler) {
  const url = sheetUrl({ action: 'listPunchDirections', video, labeler });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listPunchDirections HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listPunchDirections: ' + (body.message || 'unknown'));
  return body.rows;
}
async function savePunchDirection({ labeler, video, punch_uuid, label }) {
  const params = { action: 'savePunchDirection', labeler, video, punch_uuid };
  params.label = (label === null || label === undefined) ? '' : String(label);
  const url = sheetUrl(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error('savePunchDirection HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('savePunchDirection: ' + (body.message || 'unknown'));
  return body;
}
async function deletePunchDirection({ labeler, punch_uuid }) {
  const url = sheetUrl({ action: 'deletePunchDirection', labeler, punch_uuid });
  const res = await fetch(url);
  if (!res.ok) throw new Error('deletePunchDirection HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('deletePunchDirection: ' + (body.message || 'unknown'));
  return body;
}

// Dispatch helpers — every per-candidate op resolves through these.
function saveForCandidate(c, label, labeler) {
  if (c.kind === 'frame') {
    return saveOrientationLabel({
      labeler, video: state.currentStem,
      round: c.round, frame: c.frame, label,
    });
  }
  return savePunchDirection({
    labeler, video: state.currentStem,
    punch_uuid: c.punch_uuid, label,
  });
}
function deleteForCandidate(c, labeler) {
  if (c.kind === 'frame') {
    return deleteOrientationLabel({
      labeler, video: state.currentStem, round: c.round, frame: c.frame,
    });
  }
  return deletePunchDirection({ labeler, punch_uuid: c.punch_uuid });
}

// ─── UI helpers ──────────────────────────────────────────────────────────
function setStatus(text, cls) {
  const el = document.getElementById('orient-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'err');
  if (cls) el.classList.add(cls);
}
function setCurrentLine(text) {
  const el = document.getElementById('orient-current');
  if (el) el.textContent = text;
}
function setModeBadge(text) {
  const el = document.getElementById('video-mode');
  if (el) el.textContent = text;
}

// ─── candidate generation / regeneration ─────────────────────────────────
async function tryGenerateCandidates() {
  // Both name AND a loaded video are required. If either is missing,
  // we wait — the relevant listener will call back into here.
  if (!state.currentStem) {
    setCurrentLine('— type or pick a video name to begin —');
    setModeBadge('no video');
    return;
  }
  if (!state.videoLoaded) {
    setCurrentLine('Video name set: "' + state.currentStem + '". Now load the local .mp4 file.');
    return;
  }

  const known = state.knownVideos.find(v => v.stem === state.currentStem);
  if (!known) {
    state.currentMode = null;
    state.cachedVideo = null;
    state.candidates = [];
    setModeBadge('no cache');
    setCurrentLine('No Vision skeleton cache for "' + state.currentStem +
      '". Extract Apple Vision pose, regenerate videos.json, and redeploy.');
    return;
  }
  state.cachedVideo = known;
  state.cursor = 0;
  state.doneKeys = new Set();
  state.labelByKey = new Map();
  setStatus('—');

  if (state.mode === 'punch') {
    state.currentMode = 'punch';
    state.candidates = [];
    setModeBadge('punch · fetching…');
    setCurrentLine('Loading punches from Combined Data for "' + state.currentStem + '"…');
    try {
      state.candidates = await fetchPunchCandidates(state.currentStem);
    } catch (e) {
      setModeBadge('punch · error');
      setCurrentLine('Failed to load punches: ' + e.message);
      setStatus(e.message, 'err');
      return;
    }
    if (state.candidates.length === 0) {
      setModeBadge('punch · 0 punches');
      setCurrentLine('No labelled punches in Combined Data for "' + state.currentStem + '".');
      redrawProgress();
      return;
    }
    setModeBadge('punch · ' + state.candidates.length + ' punches');
  } else {
    // Frame mode — existing 5s-bucket sampling from cache meta.
    state.currentMode = 'cached';
    state.candidates = pickCachedCandidates(known);
    setModeBadge('frame · ' + state.candidates.length + ' candidates');
  }

  redrawProgress();
  // Fetch any existing labels for this (labeler, video, mode).
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
    const rows = state.mode === 'punch'
      ? await fetchPunchDirections(state.currentStem, labeler)
      : await fetchOrientationLabels(state.currentStem, labeler);
    state.doneKeys = new Set();
    state.labelByKey = new Map();
    for (const r of rows) {
      const k = state.mode === 'punch'
        ? 'p:' + r.punch_uuid
        : 'f:' + r.round + ':' + r.frame;
      state.doneKeys.add(k);
      state.labelByKey.set(k, r.label);
    }
    setStatus(`Loaded ${rows.length} prior label(s) for "${labeler}".`, 'ok');
    // Reconcile dropdown count for this video — the initial all-videos
    // fetch may be stale if labels were saved from another browser session.
    updateOptionCount(state.currentStem, state.doneKeys.size);
    advanceToNextUnlabeled(0);
    redrawProgress();
  } catch (e) {
    setStatus("Couldn't fetch labels: " + e.message, 'err');
  }
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
  setCurrentLine('All candidates labelled for this video — pick another, or use Prev to review.');
}

function seekToCurrent() {
  if (!state.candidates.length) return;
  if (state.cursor >= state.candidates.length) return;
  const c = state.candidates[state.cursor];
  const video = document.getElementById('video-player');

  let t = null;
  if (c.kind === 'frame') {
    const r = (state.cachedVideo.rounds || []).find(x => (x.round ?? 0) === c.round);
    if (!r) { setCurrentLine('No meta for round ' + c.round); return; }
    const startSec = Number(r.actual_start_sec ?? r.start_sec ?? 0);
    const fps = Number(r.fps);
    t = startSec + (c.frame + 0.5) / fps;
  } else {
    // Punch mode — seek to the middle of the window so the labeler sees
    // the punch at peak commitment rather than the wind-up frame.
    t = 0.5 * (c.start_sec + c.end_sec);
  }

  if (video && !isNaN(video.duration) && video.duration > 0 && t != null) {
    video.currentTime = Math.min(Math.max(0, t), video.duration);
  }
  const label = state.labelByKey.get(keyFor(c));
  let labelTxt;
  if (label === undefined) labelTxt = 'unlabeled';
  else if (label === null) labelTxt = 'skipped';
  else labelTxt = (label > 0 ? '+' : '') + label + '°';
  const total = `${state.cursor + 1}/${state.candidates.length}`;
  setCurrentLine(describeCandidate(c, total, labelTxt));
  updateButtonHighlight();
}

function updateButtonHighlight() {
  const c = state.candidates[state.cursor];
  const existingLabel = c ? state.labelByKey.get(keyFor(c)) : undefined;
  for (const btn of document.querySelectorAll('.orient-btn')) {
    const key = btn.dataset.key;
    const angle = BIN_KEYS[key];
    const matches = existingLabel === undefined ? false
      : existingLabel === null ? angle === null
      : Number(existingLabel) === Number(angle);
    btn.classList.toggle('selected', matches);
  }
}

function applyKey(key) {
  if (!state.currentStem || !state.candidates.length) {
    setStatus('Pick a video and load the file first.', 'err'); return;
  }
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) {
    setStatus('Type your name first.', 'err');
    document.getElementById('labeler-input').focus();
    return;
  }
  if (!(key in BIN_KEYS)) return;
  const angle = BIN_KEYS[key];
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = keyFor(c);

  // Optimistic local update — labeler advances immediately. The save is
  // fire-and-forget; if it fails we surface the error and roll back the
  // local state so the same item surfaces again on the next sweep.
  state.doneKeys.add(k);
  state.labelByKey.set(k, angle);
  state.pendingSaves = (state.pendingSaves || 0) + 1;
  updateButtonHighlight();
  redrawProgress();
  updateOptionCount(state.currentStem, state.doneKeys.size);
  setStatus('saving ' + (angle === null ? 'skip' : angle + '°') + '… (' + state.pendingSaves + ' pending)');

  // Advance to next unlabelled candidate immediately — don't wait for the
  // network. Apps Script POSTs typically take 300–800ms; cold-starts
  // worse. Blocking on them is what made labelling feel sluggish.
  advanceToNextUnlabeled(state.cursor + 1);

  // Fire the save in the background. saveForCandidate dispatches on c.kind.
  saveForCandidate(c, angle, labeler).then(() => {
    state.pendingSaves = Math.max(0, (state.pendingSaves || 1) - 1);
    if (state.pendingSaves === 0) {
      setStatus('Saved.', 'ok');
    } else {
      setStatus(state.pendingSaves + ' save' + (state.pendingSaves === 1 ? '' : 's') + ' pending…');
    }
  }).catch((e) => {
    state.pendingSaves = Math.max(0, (state.pendingSaves || 1) - 1);
    // Roll back so the labeler sees this item again on the next pass.
    state.doneKeys.delete(k);
    state.labelByKey.delete(k);
    redrawProgress();
    updateOptionCount(state.currentStem, state.doneKeys.size);
    setStatus('Save failed for ' + k + ': ' + e.message, 'err');
  });
}

async function clearCurrent() {
  if (!state.currentStem) return;
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) return;
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = keyFor(c);
  state.doneKeys.delete(k);
  state.labelByKey.delete(k);
  updateButtonHighlight();
  redrawProgress();
  updateOptionCount(state.currentStem, state.doneKeys.size);
  try {
    await deleteForCandidate(c, labeler);
    setStatus("Cleared this candidate's label.", 'ok');
  } catch (e) {
    setStatus('Clear failed: ' + e.message, 'err');
  }
}

function gotoPrev() {
  if (!state.candidates.length) return;
  state.cursor = Math.max(0, state.cursor - 1);
  seekToCurrent();
}

function redrawProgress() {
  const N = state.candidates.length;
  const labelled = state.doneKeys.size;
  const bar = document.getElementById('orient-bar');
  if (bar) bar.style.width = N ? (100 * labelled / N).toFixed(1) + '%' : '0%';
  const pt = document.getElementById('orient-progress-text');
  if (pt) pt.textContent = N ? labelled + ' / ' + N + ' labelled' : 'no candidates';
  const dist = {};
  for (const v of state.labelByKey.values()) {
    const key = v === null ? 'skip' : String(v);
    dist[key] = (dist[key] || 0) + 1;
  }
  const parts = ANGLE_LIST.map(a => {
    const c = dist[String(a)] || 0;
    const sign = a > 0 ? '+' : '';
    return sign + a + '°: ' + c;
  });
  if (dist.skip) parts.push('skip: ' + dist.skip);
  document.getElementById('orient-dist').textContent = parts.length ? parts.join(' · ') : '—';
}

// ─── wire-up ──────────────────────────────────────────────────────────────

async function loadVideosConfig() {
  try {
    const res = await fetch('./videos.json', { cache: 'no-cache' });
    if (!res.ok) return { videos: [] };
    return await res.json();
  } catch {
    return { videos: [] };
  }
}

// Pull every (non-deleted) row for this labeler across all videos and tally
// per-video counts. Called once at startup + on labeler-name change + on
// mode switch. Mode dispatches to the matching sheet.
async function fetchAllLabelerCounts(labeler, mode) {
  const out = new Map();
  if (!labeler) return out;
  const action = mode === 'punch' ? 'listPunchDirections' : 'listOrientation';
  try {
    const url = sheetUrl({ action, labeler });
    const res = await fetch(url);
    if (!res.ok) return out;
    const body = await res.json();
    if (body.status !== 'ok') return out;
    for (const r of body.rows || []) {
      out.set(r.video, (out.get(r.video) || 0) + 1);
    }
  } catch {}
  return out;
}

// Active per-video count map for the current mode — read by populateVideoSelect
// and updateOptionCount so they don't have to know which mode is on.
function activeLabelCounts() {
  return state.mode === 'punch'
    ? state.punchLabelCountsByVideo
    : state.labelCountsByVideo;
}

// Format one dropdown option's label: stem + base (rounds/punch labels) +
// suffix indicating how many frames this labeler has already labeled. When
// the total is known (cached videos), shows K/M and a ✓ once complete.
function buildOptionText(stem, baseText, count, candidateTotal) {
  let suffix = '';
  if (count > 0 && candidateTotal != null) {
    suffix = ' · ' + count + '/' + candidateTotal + ' labeled';
    if (count >= candidateTotal) suffix = ' · ✓ ' + count + '/' + candidateTotal + ' done';
  } else if (count > 0) {
    suffix = ' · ' + count + ' labeled';
  }
  return stem + ' (' + baseText + ')' + suffix;
}

// Update one option's text in place without rebuilding the whole <select>
// (which would close it if open, lose focus, etc.). Mirrors the change into
// the per-mode count map so subsequent re-renders are consistent. Also
// toggles the `.labeled` class so the CSS green highlight tracks count > 0.
function updateOptionCount(stem, count) {
  if (!stem) return;
  activeLabelCounts().set(stem, count);
  const sel = document.getElementById('video-select');
  if (!sel) return;
  for (const opt of sel.querySelectorAll('option[data-stem]')) {
    if (opt.dataset.stem !== stem) continue;
    const baseText = opt.dataset.base || '';
    const totalRaw = opt.dataset.total;
    const total = (totalRaw != null && totalRaw !== '') ? Number(totalRaw) : null;
    opt.textContent = buildOptionText(stem, baseText, count, total);
    opt.classList.toggle('labeled', count > 0);
    return;
  }
}

// Populate the <select> with the cached videos from videos.json only.
// A video without a Vision skeleton cache cannot be labeled, because
// (round, frame) saved to the Sheet must be a direct index into the cache.
// Each option gets a "· K/M labeled" (frame mode, total known up front) or
// "· N labeled" (punch mode, total not known without fetching Combined Data)
// suffix when this labeler has prior labels for that video.
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
  grp.label = state.mode === 'punch'
    ? 'Cached videos · punch direction labels'
    : 'Cached videos · frame direction labels';
  for (const v of cachedActive.slice().sort((a, b) => a.stem.localeCompare(b.stem))) {
    const opt = document.createElement('option');
    opt.value = v.stem;
    const n = (v.rounds || []).length;
    const baseText = n + ' round' + (n === 1 ? '' : 's');
    const count = counts.get(v.stem) || 0;
    opt.dataset.stem = v.stem;
    opt.dataset.base = baseText;
    let totalCandidates = null;
    if (state.mode !== 'punch') {
      totalCandidates = pickCachedCandidates(v).length;
      opt.dataset.total = String(totalCandidates);
    } else {
      opt.dataset.total = '';
    }
    opt.textContent = buildOptionText(v.stem, baseText, count, totalCandidates);
    if (count > 0) opt.classList.add('labeled');
    grp.appendChild(opt);
  }
  sel.appendChild(grp);
}

// Refresh the per-video counts for whichever mode is active and rebuild the
// dropdown in place. Used on labeler-name change AND on mode switch.
async function refreshCountsAndDropdown(labeler) {
  const map = await fetchAllLabelerCounts(labeler, state.mode);
  if (state.mode === 'punch') state.punchLabelCountsByVideo = map;
  else                        state.labelCountsByVideo = map;
  populateVideoSelect(state.knownVideos, map);
}

window.addEventListener('DOMContentLoaded', async () => {
  // First — let player.js wire up the file picker, seek bar, etc.
  setupPlayer();

  // Restore mode from localStorage (frame default).
  try { state.mode = localStorage.getItem('orient_mode') === 'punch' ? 'punch' : 'frame'; } catch {}

  // Restore labeler name from localStorage
  const labelerInput = document.getElementById('labeler-input');
  try { labelerInput.value = localStorage.getItem('orient_labeler_name') || ''; } catch {}
  labelerInput.addEventListener('change', async () => {
    try { localStorage.setItem('orient_labeler_name', labelerInput.value.trim()); } catch {}
    await refreshCountsAndDropdown(labelerInput.value.trim());
    if (state.currentStem && state.candidates.length) syncFromSheet();
  });

  // Load known videos from videos.json — the only source of labelable videos.
  // Also fetch this labeler's existing per-video counts so the dropdown shows
  // what's already done.
  const cfg = await loadVideosConfig();
  state.knownVideos = cfg.videos || [];
  await refreshCountsAndDropdown(labelerInput.value.trim());

  // Mode toggle. Switching mode resets the candidate list + fetches counts
  // for the new mode's sheet so the dropdown reflects punch-vs-frame progress.
  function syncModeButtons() {
    for (const btn of document.querySelectorAll('#mode-toggle .mode-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    }
  }
  syncModeButtons();
  for (const btn of document.querySelectorAll('#mode-toggle .mode-btn')) {
    btn.addEventListener('click', async () => {
      if (btn.dataset.mode === state.mode) return;
      state.mode = btn.dataset.mode;
      try { localStorage.setItem('orient_mode', state.mode); } catch {}
      syncModeButtons();
      await refreshCountsAndDropdown(labelerInput.value.trim());
      if (state.currentStem) tryGenerateCandidates();
    });
  }

  // Dropdown is the only way in — custom names are gone with free mode.
  const selectEl = document.getElementById('video-select');

  function onVideoChoiceChanged() {
    state.currentStem = selectEl.value || null;
    if (!state.currentStem) { setModeBadge('no video'); return; }
    tryGenerateCandidates();
  }

  selectEl.addEventListener('change', onVideoChoiceChanged);

  // Hook into video loading. player.js fires loadedmetadata after a file
  // picks; we use that to regenerate candidates once the local .mp4 is ready.
  const video = document.getElementById('video-player');
  video.addEventListener('loadedmetadata', () => {
    state.videoLoaded = true;
    tryGenerateCandidates();
  });

  // Numpad button clicks
  for (const btn of document.querySelectorAll('.orient-btn')) {
    btn.addEventListener('click', () => applyKey(btn.dataset.key));
  }
  document.getElementById('btn-prev').addEventListener('click', gotoPrev);
  document.getElementById('btn-clear').addEventListener('click', clearCurrent);

  // Keyboard shortcuts (numpad layout + nav). Skip when typing in an input.
  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key in BIN_KEYS) { e.preventDefault(); applyKey(e.key); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); gotoPrev(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); clearCurrent(); return; }
  });

  setStatus('—');
  setCurrentLine('— type or pick a video name to begin —');
});
