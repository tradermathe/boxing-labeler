// ============================================================
// orientation.js — boxer facing-direction labeler page
//
// Reuses player.js for video player chrome + shared sheetUrl(). The
// labeling unit is one frame; candidates are picked deterministically
// per video (5-second buckets, jittered, capped at 100, shuffled) so
// labelers see a stable ordered set they can resume. Labels POST to
// the shared Apps Script via doGetOrientation() in apps_script.js,
// which writes a row to the "Orientation Labels" tab.
//
// State (window.state from player.js) gets these orientation-specific
// fields added via Object.assign:
//   currentVideo       — selected video object from videos.json
//   candidates         — [{round, frame}, ...]
//   cursor             — index into candidates
//   doneKeys           — Set of "round:frame" strings already labelled
//   labelByKey         — Map of "round:frame" → angle (or null for skip)
// ============================================================

const BIN_KEYS = {
  "1": -45, "2": null, "3":  45,
  "4": -90, "5":   0, "6":  90,
  "7":-135, "8": 180, "9": 135,
};
const ANGLE_LIST = [0, 45, -45, 90, -90, 135, -135, -180];

Object.assign(state, {
  videos: [],
  currentVideo: null,
  candidates: [],
  cursor: 0,
  doneKeys: new Set(),
  labelByKey: new Map(),
});

// ─── frame-candidate sampler ──────────────────────────────────────────────
// Mulberry32 PRNG — deterministic and small.
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
function pickCandidates(video, bucketSec = 5, cap = 100) {
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
  // Down-sample + shuffle, both seeded so the same video → same set.
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
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
  if (label === null || label === undefined) params.label = '';
  else params.label = String(label);
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

// ─── core flow ───────────────────────────────────────────────────────────
async function loadVideosConfig() {
  const res = await fetch('./videos.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('videos.json HTTP ' + res.status);
  return res.json();
}

function populateVideoSelect(videos) {
  const sel = document.getElementById('video-select');
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— pick a video (' + videos.length + ') —';
  sel.appendChild(placeholder);
  for (const v of videos) {
    if (v.heldOut) continue;
    const o = document.createElement('option');
    o.value = v.stem;
    const n = (v.rounds || []).length;
    o.textContent = v.stem + '  ·  ' + n + ' round' + (n === 1 ? '' : 's');
    sel.appendChild(o);
  }
}

async function onVideoSelected() {
  const stem = document.getElementById('video-select').value;
  if (!stem) return;
  state.currentVideo = state.videos.find(v => v.stem === stem) || null;
  state.candidates = state.currentVideo ? pickCandidates(state.currentVideo) : [];
  state.cursor = 0;
  state.doneKeys = new Set();
  state.labelByKey = new Map();
  setCurrentLine(state.candidates.length + ' candidates generated for this video. Pick the local .mp4 next.');
  setStatus('—');
  redrawProgress();
  await syncFromSheet();
}

async function syncFromSheet() {
  if (!state.currentVideo) return;
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) return;
  try {
    setStatus('Loading existing labels…');
    const rows = await fetchOrientationLabels(state.currentVideo.stem, labeler);
    state.doneKeys = new Set();
    state.labelByKey = new Map();
    for (const r of rows) {
      const k = r.round + ':' + r.frame;
      state.doneKeys.add(k);
      state.labelByKey.set(k, r.label);
    }
    setStatus(`Loaded ${rows.length} prior label(s) for "${labeler}".`, 'ok');
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
    const k = c.round + ':' + c.frame;
    if (!state.doneKeys.has(k)) {
      state.cursor = idx;
      seekToCurrent();
      return;
    }
  }
  state.cursor = N;
  setCurrentLine('All candidates labelled for this video — pick another, or use Prev to review.');
}

function seekToCurrent() {
  if (!state.currentVideo || !state.candidates.length) return;
  if (state.cursor >= state.candidates.length) return;
  const c = state.candidates[state.cursor];
  const r = (state.currentVideo.rounds || []).find(x => (x.round ?? 0) === c.round);
  if (!r) {
    setCurrentLine('No meta for round ' + c.round + ' in this video.');
    return;
  }
  const startSec = Number(r.actual_start_sec ?? r.start_sec ?? 0);
  const fps = Number(r.fps);
  const t = startSec + (c.frame + 0.5) / fps;

  // Use player.js's video element. We can't call its seekToFrame
  // directly (different concept of "frame"); set currentTime via the
  // seek-bar to leverage shared seek-state plumbing, OR set directly
  // on the <video> element. Direct is fine — player.js's time-update
  // listener picks it up.
  const video = document.getElementById('video-player');
  if (video && !isNaN(video.duration) && video.duration > 0) {
    video.currentTime = Math.min(Math.max(0, t), video.duration);
  }
  const label = state.labelByKey.get(c.round + ':' + c.frame);
  let labelTxt;
  if (label === undefined) labelTxt = 'unlabeled';
  else if (label === null) labelTxt = 'skipped';
  else labelTxt = (label > 0 ? '+' : '') + label + '°';
  setCurrentLine(
    `round ${c.round} · frame ${c.frame} · t=${t.toFixed(2)}s · ${labelTxt} · ${state.cursor + 1}/${state.candidates.length}`
  );
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

async function applyKey(key) {
  if (!state.currentVideo) {
    setStatus('Pick a video first.', 'err'); return;
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
  // Optimistic local update
  state.doneKeys.add(k);
  state.labelByKey.set(k, angle);
  updateButtonHighlight();
  redrawProgress();
  try {
    await saveOrientationLabel({
      labeler,
      video: state.currentVideo.stem,
      round: c.round,
      frame: c.frame,
      label: angle,
    });
    setStatus('Saved: ' + (angle === null ? 'skip' : angle + '°'), 'ok');
  } catch (e) {
    setStatus('Save failed: ' + e.message, 'err');
    return;
  }
  advanceToNextUnlabeled(state.cursor + 1);
}

async function clearCurrent() {
  if (!state.currentVideo) return;
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) return;
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = c.round + ':' + c.frame;
  state.doneKeys.delete(k);
  state.labelByKey.delete(k);
  updateButtonHighlight();
  redrawProgress();
  try {
    await deleteOrientationLabel({
      labeler,
      video: state.currentVideo.stem,
      round: c.round,
      frame: c.frame,
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
  // Per-bin distribution
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

// ─── wire-up (after player.js has set up the shared state) ────────────────
(async function main() {
  // Restore labeler name from localStorage so the team doesn't retype
  // every reload.
  const labelerInput = document.getElementById('labeler-input');
  try { labelerInput.value = localStorage.getItem('orient_labeler_name') || ''; } catch {}
  labelerInput.addEventListener('change', () => {
    const v = labelerInput.value.trim();
    try { localStorage.setItem('orient_labeler_name', v); } catch {}
    if (state.currentVideo) syncFromSheet();
  });

  let cfg;
  try { cfg = await loadVideosConfig(); }
  catch (e) {
    setStatus("Couldn't load videos.json: " + e.message, 'err');
    return;
  }
  state.videos = cfg.videos || [];
  populateVideoSelect(state.videos);

  document.getElementById('video-select').addEventListener('change', onVideoSelected);
  for (const btn of document.querySelectorAll('.orient-btn')) {
    btn.addEventListener('click', () => applyKey(btn.dataset.key));
  }
  document.getElementById('btn-prev').addEventListener('click', gotoPrev);
  document.getElementById('btn-clear').addEventListener('click', clearCurrent);

  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key in BIN_KEYS) { e.preventDefault(); applyKey(e.key); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); gotoPrev(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); clearCurrent(); return; }
  });
})();
