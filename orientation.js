// ============================================================
// orientation.js — boxer facing-direction labeler page
//
// Reuses player.js for video player chrome + shared sheetUrl(). The
// labeling unit is one frame. Two sampling modes:
//
//   CACHED MODE  (video name matches an entry in videos.json):
//     Candidates come from the round meta — 5s buckets per round,
//     jittered, capped at 100, shuffled. Frames map exactly to cache
//     indices. (round, frame) lands in the Sheet.
//
//   FREE MODE  (custom video name not in videos.json):
//     Candidates generated after the file loads, from video.duration.
//     Same 5s-bucket algorithm. Stored as round=0 with frame =
//     round(t * detected_fps) so downstream code can recover the
//     timestamp at training time.
//
// Either mode persists labels to the same "Orientation Labels" sheet
// via doGetOrientation in apps_script.js.
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
  currentMode: null,        // 'cached' or null
  cachedVideo: null,        // videos.json entry for current stem
  candidates: [],
  cursor: 0,
  doneKeys: new Set(),
  labelByKey: new Map(),
  videoLoaded: false,
  // stem → count of THIS labeler's existing labels for that video. Populated
  // once at startup (and whenever the labeler name changes); kept live as
  // applyKey / clearCurrent / syncFromSheet adjust the current video's count.
  labelCountsByVideo: new Map(),
});

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

// Cached mode: build from videos.json round meta.
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

// ─── sheet sync ──────────────────────────────────────────────────────────
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
function tryGenerateCandidates() {
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
    // Free mode is intentionally gone: labels for videos without a Vision
    // skeleton cache can't be paired with poses at train time, so we refuse
    // to collect them. Extract the Vision cache and re-run build_videos_json.py
    // (then push) before labeling a new video.
    state.currentMode = null;
    state.cachedVideo = null;
    state.candidates = [];
    setModeBadge('no cache');
    setCurrentLine('No Vision skeleton cache for "' + state.currentStem +
      '". Extract Apple Vision pose, regenerate videos.json, and redeploy.');
    return;
  }
  state.currentMode = 'cached';
  state.cachedVideo = known;
  state.candidates = pickCachedCandidates(known);
  setModeBadge('cached · ' + state.candidates.length + ' candidates');
  state.cursor = 0;
  state.doneKeys = new Set();
  state.labelByKey = new Map();
  redrawProgress();
  setStatus('—');
  // Fetch any existing labels for this (labeler, video).
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
    const rows = await fetchOrientationLabels(state.currentStem, labeler);
    state.doneKeys = new Set();
    state.labelByKey = new Map();
    for (const r of rows) {
      const k = r.round + ':' + r.frame;
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
    if (!state.doneKeys.has(c.round + ':' + c.frame)) {
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
  const r = (state.cachedVideo.rounds || []).find(x => (x.round ?? 0) === c.round);
  if (!r) { setCurrentLine('No meta for round ' + c.round); return; }
  const startSec = Number(r.actual_start_sec ?? r.start_sec ?? 0);
  const fps = Number(r.fps);
  const t = startSec + (c.frame + 0.5) / fps;
  const video = document.getElementById('video-player');
  if (video && !isNaN(video.duration) && video.duration > 0) {
    video.currentTime = Math.min(Math.max(0, t), video.duration);
  }
  const label = state.labelByKey.get(c.round + ':' + c.frame);
  let labelTxt;
  if (label === undefined) labelTxt = 'unlabeled';
  else if (label === null) labelTxt = 'skipped';
  else labelTxt = (label > 0 ? '+' : '') + label + '°';
  setCurrentLine(`round ${c.round} · frame ${c.frame} · ${labelTxt} · ${state.cursor + 1}/${state.candidates.length}`);
  updateButtonHighlight();
}

function updateButtonHighlight() {
  const c = state.candidates[state.cursor];
  const existingLabel = c ? state.labelByKey.get(c.round + ':' + c.frame) : undefined;
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
  const k = c.round + ':' + c.frame;

  // Optimistic local update — labeler advances immediately. The save is
  // fire-and-forget; if it fails we surface the error and roll back the
  // local state so the same frame surfaces again on the next sweep.
  state.doneKeys.add(k);
  state.labelByKey.set(k, angle);
  state.pendingSaves = (state.pendingSaves || 0) + 1;
  updateButtonHighlight();
  redrawProgress();
  updateOptionCount(state.currentStem, state.doneKeys.size);
  setStatus('saving ' + (angle === null ? 'skip' : angle + '°') + '… (' + state.pendingSaves + ' pending)');

  // Advance to next unlabelled frame immediately — don't wait for the
  // network. Apps Script POSTs typically take 300–800ms; cold-starts
  // worse. Blocking on them is what made labelling feel sluggish.
  advanceToNextUnlabeled(state.cursor + 1);

  // Fire the save in the background.
  saveOrientationLabel({
    labeler,
    video: state.currentStem,
    round: c.round,
    frame: c.frame,
    label: angle,
  }).then(() => {
    state.pendingSaves = Math.max(0, (state.pendingSaves || 1) - 1);
    if (state.pendingSaves === 0) {
      setStatus('Saved.', 'ok');
    } else {
      setStatus(state.pendingSaves + ' save' + (state.pendingSaves === 1 ? '' : 's') + ' pending…');
    }
  }).catch((e) => {
    state.pendingSaves = Math.max(0, (state.pendingSaves || 1) - 1);
    // Roll back so the labeler sees this frame again on the next pass.
    state.doneKeys.delete(k);
    state.labelByKey.delete(k);
    redrawProgress();
    updateOptionCount(state.currentStem, state.doneKeys.size);
    setStatus('Save failed for round ' + c.round + ' frame ' + c.frame + ': ' + e.message, 'err');
  });
}

async function clearCurrent() {
  if (!state.currentStem) return;
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) return;
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = c.round + ':' + c.frame;
  state.doneKeys.delete(k);
  state.labelByKey.delete(k);
  updateButtonHighlight();
  redrawProgress();
  updateOptionCount(state.currentStem, state.doneKeys.size);
  try {
    await deleteOrientationLabel({
      labeler, video: state.currentStem, round: c.round, frame: c.frame,
    });
    setStatus("Cleared this frame's label.", 'ok');
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

// Pull every (non-deleted) orientation row for this labeler across all videos
// and tally per-video counts. Called once at startup + on labeler-name change.
// listOrientation with no `video` filter returns the labeler's whole history.
async function fetchAllLabelerCounts(labeler) {
  const out = new Map();
  if (!labeler) return out;
  try {
    const url = sheetUrl({ action: 'listOrientation', labeler });
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
// state.labelCountsByVideo so subsequent re-renders are consistent. Also
// toggles the `.labeled` class so the CSS green highlight tracks count > 0.
function updateOptionCount(stem, count) {
  if (!stem) return;
  state.labelCountsByVideo.set(stem, count);
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
// Free mode is gone: a video without a Vision skeleton cache cannot be
// labeled, because the (round, frame) saved to the Sheet must be a direct
// index into the cache. Each option gets a "· K/M labeled" (or "· N labeled")
// suffix when this labeler has already labeled frames from that video.
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
  grp.label = 'Cached (with Vision skeleton)';
  for (const v of cachedActive.slice().sort((a, b) => a.stem.localeCompare(b.stem))) {
    const opt = document.createElement('option');
    opt.value = v.stem;
    const n = (v.rounds || []).length;
    const baseText = n + ' round' + (n === 1 ? '' : 's');
    const totalCandidates = pickCachedCandidates(v).length;
    const count = counts.get(v.stem) || 0;
    opt.dataset.stem = v.stem;
    opt.dataset.base = baseText;
    opt.dataset.total = String(totalCandidates);
    opt.textContent = buildOptionText(v.stem, baseText, count, totalCandidates);
    if (count > 0) opt.classList.add('labeled');
    grp.appendChild(opt);
  }
  sel.appendChild(grp);
}

window.addEventListener('DOMContentLoaded', async () => {
  // First — let player.js wire up the file picker, seek bar, etc.
  setupPlayer();

  // Restore labeler name from localStorage
  const labelerInput = document.getElementById('labeler-input');
  try { labelerInput.value = localStorage.getItem('orient_labeler_name') || ''; } catch {}
  labelerInput.addEventListener('change', async () => {
    try { localStorage.setItem('orient_labeler_name', labelerInput.value.trim()); } catch {}
    // The dropdown's "K labeled" suffixes are per-labeler — refresh them
    // when the name changes, then rebuild the <select> in place.
    state.labelCountsByVideo = await fetchAllLabelerCounts(labelerInput.value.trim());
    populateVideoSelect(state.knownVideos, state.labelCountsByVideo);
    if (state.currentStem && state.candidates.length) syncFromSheet();
  });

  // Load known videos from videos.json — the only source of labelable videos.
  // Also fetch this labeler's existing per-video counts so the dropdown shows
  // what's already done.
  const cfg = await loadVideosConfig();
  state.knownVideos = cfg.videos || [];
  state.labelCountsByVideo = await fetchAllLabelerCounts(labelerInput.value.trim());
  populateVideoSelect(state.knownVideos, state.labelCountsByVideo);

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
