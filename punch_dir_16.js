// ============================================================
// punch_dir_16.js — boxer punch-direction labeler, 22.5° bins
//
// A focused duplicate of orientation.js's PUNCH MODE. One label per
// labelled punch (keyed by punch_uuid), but the facing direction is one
// of 16 bins (22.5° steps) instead of 8, picked on a radial compass dial.
// Saved to the "Punch Directions 16" sheet via the savePunchDirection16 /
// listPunchDirections16 / deletePunchDirection16 Apps Script actions.
//
// Candidates come from Combined Data (listPunchesForVideo, shared with the
// 8-bin page), filtered here to STRAIGHT punches only (jab / cross).
//
// Reuses player.js for the video chrome, sheetUrl(), and shared `state`.
// ============================================================

// 16 bins, compass order. `angle` is the facing bearing (0 = toward camera,
// + = boxer's right, - = left, 180 = back to camera). `store` is the value
// written to the sheet — the single straight-back bin is stored as -180 to
// match the 8-bin sheet and the axiality pipeline. `key` is the numpad-key
// shortcut for the 8 major bins; null = dial-click only.
const DIAL_BINS = [
  { angle: 0,      store: 0,      key: '5' },
  { angle: 22.5,   store: 22.5,   key: null },
  { angle: 45,     store: 45,     key: '3' },
  { angle: 67.5,   store: 67.5,   key: null },
  { angle: 90,     store: 90,     key: '6' },
  { angle: 112.5,  store: 112.5,  key: null },
  { angle: 135,    store: 135,    key: '9' },
  { angle: 157.5,  store: 157.5,  key: null },
  { angle: 180,    store: -180,   key: '8' },
  { angle: -157.5, store: -157.5, key: null },
  { angle: -135,   store: -135,   key: '7' },
  { angle: -112.5, store: -112.5, key: null },
  { angle: -90,    store: -90,    key: '4' },
  { angle: -67.5,  store: -67.5,  key: null },
  { angle: -45,    store: -45,    key: '1' },
  { angle: -22.5,  store: -22.5,  key: null },
];

// key char -> { store, skip }. Majors from DIAL_BINS; [2] = skip (center).
const KEY_BINS = {};
for (const b of DIAL_BINS) if (b.key) KEY_BINS[b.key] = { store: b.store, skip: false };
KEY_BINS['2'] = { store: null, skip: true };

// Straight punches only: jab_* / cross_* (head + body). Hooks/uppercuts are
// labelled lead_*/rear_* and are excluded.
function isStraight(punchType) {
  const t = String(punchType || '').toLowerCase();
  return t.startsWith('jab') || t.startsWith('cross');
}

function formatLabel(v) {
  if (v === undefined) return 'unlabeled';
  if (v === null) return 'skipped';
  if (v === -180) return '180°';
  return (v > 0 ? '+' : '') + v + '°';
}

Object.assign(state, {
  knownVideos: [],          // from videos.json — only source of labelable videos
  currentStem: null,
  candidates: [],           // straight punches for the current video
  cursor: 0,
  doneKeys: new Set(),
  labelByKey: new Map(),
  coverageByUuid: new Map(),       // current video: punch_uuid -> Set<labeler> (any labeler)
  videoLoaded: false,
  labelCountsByVideo: new Map(),   // stem -> total punches labeled by anyone
});

function keyFor(c) {
  return c ? 'p:' + c.punch_uuid : null;
}

// ─── candidate fetch (Combined Data, straights only) ───────────────────────
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
    if (!isStraight(r.label)) continue;
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

// ─── sheet sync (Punch Directions 16) ──────────────────────────────────────
async function fetchPunchDirections16(video, labeler) {
  const url = sheetUrl({ action: 'listPunchDirections16', video, labeler });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listPunchDirections16 HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listPunchDirections16: ' + (body.message || 'unknown'));
  return body.rows;
}
async function savePunchDirection16({ labeler, video, punch_uuid, label }) {
  const params = { action: 'savePunchDirection16', labeler, video, punch_uuid };
  params.label = (label === null || label === undefined) ? '' : String(label);
  const url = sheetUrl(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error('savePunchDirection16 HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('savePunchDirection16: ' + (body.message || 'unknown'));
  return body;
}
async function deletePunchDirection16({ labeler, punch_uuid }) {
  const url = sheetUrl({ action: 'deletePunchDirection16', labeler, punch_uuid });
  const res = await fetch(url);
  if (!res.ok) throw new Error('deletePunchDirection16 HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('deletePunchDirection16: ' + (body.message || 'unknown'));
  return body;
}

// ─── UI helpers ────────────────────────────────────────────────────────────
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

function describeCandidate(c, totalLabel, labelTxt) {
  if (!c) return '';
  const type = c.punch_type || '?';
  const stance = c.stance ? ` · ${c.stance}` : '';
  const window = `${c.start_sec.toFixed(2)}–${c.end_sec.toFixed(2)}s`;
  return `${type}${stance} · ${window} · ${labelTxt} · ${totalLabel}`;
}

// ─── radial dial ────────────────────────────────────────────────────────────
// Buttons placed by x = cx + R·sin θ, y = cy + R·cos θ so 0° sits at the
// bottom, 180° at the top, +90° right, -90° left.
function buildDial() {
  const dial = document.getElementById('dial');
  if (!dial) return;
  const D = 320, R = 132, cx = D / 2, cy = D / 2;
  for (const b of DIAL_BINS) {
    const rad = b.angle * Math.PI / 180;
    const x = cx + R * Math.sin(rad);
    const y = cy + R * Math.cos(rad);
    const btn = document.createElement('button');
    btn.className = 'dial-btn' + (b.key ? ' major' : '');
    btn.dataset.store = String(b.store);
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    const disp = b.store === -180 ? '180°' : (b.angle > 0 ? '+' : '') + b.angle + '°';
    btn.innerHTML = `<div class="dial-ang">${disp}</div>` + (b.key ? `<div class="dial-key">[${b.key}]</div>` : '');
    btn.addEventListener('click', () => applyLabel(b.store, false));
    dial.appendChild(btn);
  }
  const skip = document.createElement('button');
  skip.className = 'dial-btn skip';
  skip.dataset.skip = '1';
  skip.style.left = cx + 'px';
  skip.style.top = cy + 'px';
  skip.innerHTML = `<div class="dial-ang">skip</div><div class="dial-key">[2]</div>`;
  skip.addEventListener('click', () => applyLabel(null, true));
  dial.appendChild(skip);
}

function updateButtonHighlight() {
  const c = state.candidates[state.cursor];
  const existing = c ? state.labelByKey.get(keyFor(c)) : undefined;  // undefined | null | number
  for (const btn of document.querySelectorAll('.dial-btn')) {
    let matches = false;
    if (btn.dataset.skip === '1') {
      matches = existing === null && c !== undefined && state.doneKeys.has(keyFor(c));
    } else if (existing !== undefined && existing !== null) {
      matches = Number(existing) === Number(btn.dataset.store);
    }
    btn.classList.toggle('selected', matches);
  }
}

// ─── candidate generation ────────────────────────────────────────────────
async function tryGenerateCandidates() {
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
    state.candidates = [];
    setModeBadge('no cache');
    setCurrentLine('No Vision skeleton cache for "' + state.currentStem +
      '". Extract Apple Vision pose, regenerate videos.json, and redeploy.');
    return;
  }
  state.cursor = 0;
  state.doneKeys = new Set();
  state.labelByKey = new Map();
  state.coverageByUuid = new Map();
  setStatus('—');

  state.candidates = [];
  setModeBadge('fetching…');
  setCurrentLine('Loading straight punches from Combined Data for "' + state.currentStem + '"…');
  try {
    state.candidates = await fetchPunchCandidates(state.currentStem);
  } catch (e) {
    setModeBadge('error');
    setCurrentLine('Failed to load punches: ' + e.message);
    setStatus(e.message, 'err');
    return;
  }
  if (state.candidates.length === 0) {
    setModeBadge('0 straights');
    setCurrentLine('No labelled straight punches in Combined Data for "' + state.currentStem + '".');
    redrawProgress();
    return;
  }
  setModeBadge(state.candidates.length + ' straights');
  redrawProgress();
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
    // Pull every labeler's rows for this video: the in-video UX (dial, progress,
    // next-unlabeled) reflects only YOUR labels, but the dropdown count is the
    // total of punches labeled by anyone (deduped by punch_uuid).
    const rows = await fetchPunchDirections16(state.currentStem, '');
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
        state.labelByKey.set(k, r.label);
      }
    }
    setStatus(`Loaded ${state.doneKeys.size} of your label(s) · ${state.coverageByUuid.size} labeled in total.`, 'ok');
    updateOptionCount(state.currentStem, state.coverageByUuid.size);
    // Land on the first punch so any existing label is visible immediately;
    // use "next unlabeled" (U) to jump to where labelling left off.
    state.cursor = 0;
    seekToCurrent();
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
  setCurrentLine('All straight punches labelled for this video — pick another, or use Prev to review.');
}

// Loop the labelled punch window. 0/0 lead-in/trail-out = pure punch only.
const PUNCH_LEAD_IN_SEC = 0;
const PUNCH_TRAIL_OUT_SEC = 0;

function seekToCurrent() {
  if (!state.candidates.length) return;
  if (state.cursor >= state.candidates.length) {
    state.loopWindow = null;
    return;
  }
  const c = state.candidates[state.cursor];
  const video = document.getElementById('video-player');
  const start = Math.max(0, c.start_sec - PUNCH_LEAD_IN_SEC);
  const end   = c.end_sec + PUNCH_TRAIL_OUT_SEC;
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
  setCurrentLine(describeCandidate(c, total, formatLabel(label)));
  updateButtonHighlight();
}

function applyLabel(store, isSkip) {
  if (!state.currentStem || !state.candidates.length) {
    setStatus('Pick a video and load the file first.', 'err'); return;
  }
  const labeler = document.getElementById('labeler-input').value.trim();
  if (!labeler) {
    setStatus('Type your name first.', 'err');
    document.getElementById('labeler-input').focus();
    return;
  }
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = keyFor(c);
  const labelVal = isSkip ? null : store;

  // Optimistic local update — advance immediately, save in the background,
  // roll back on failure so the item resurfaces on the next sweep.
  state.doneKeys.add(k);
  state.labelByKey.set(k, labelVal);
  let who = state.coverageByUuid.get(c.punch_uuid);
  if (!who) { who = new Set(); state.coverageByUuid.set(c.punch_uuid, who); }
  who.add(labeler);
  state.pendingSaves = (state.pendingSaves || 0) + 1;
  updateButtonHighlight();
  redrawProgress();
  updateOptionCount(state.currentStem, state.coverageByUuid.size);
  setStatus('saving ' + (isSkip ? 'skip' : formatLabel(labelVal)) + '… (' + state.pendingSaves + ' pending)');

  gotoNext();

  savePunchDirection16({ labeler, video: state.currentStem, punch_uuid: c.punch_uuid, label: labelVal }).then(() => {
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
    updateButtonHighlight();
    updateOptionCount(state.currentStem, state.coverageByUuid.size);
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
  const who = state.coverageByUuid.get(c.punch_uuid);
  if (who) { who.delete(labeler); if (who.size === 0) state.coverageByUuid.delete(c.punch_uuid); }
  updateButtonHighlight();
  redrawProgress();
  updateOptionCount(state.currentStem, state.coverageByUuid.size);
  try {
    await deletePunchDirection16({ labeler, punch_uuid: c.punch_uuid });
    setStatus("Cleared this punch's label.", 'ok');
  } catch (e) {
    setStatus('Clear failed: ' + e.message, 'err');
  }
}

function gotoPrev() {
  if (!state.candidates.length) return;
  state.cursor = Math.max(0, state.cursor - 1);
  seekToCurrent();
}

// Sequential next — moves to the following punch whether or not it's labelled.
function gotoNext() {
  if (!state.candidates.length) return;
  state.cursor = Math.min(state.candidates.length - 1, state.cursor + 1);
  seekToCurrent();
}

function gotoFirst() {
  if (!state.candidates.length) return;
  state.cursor = 0;
  seekToCurrent();
}

function gotoNextUnlabeled() {
  advanceToNextUnlabeled(state.cursor + 1);
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
  const parts = [];
  for (const b of DIAL_BINS) {
    const c = dist[String(b.store)] || 0;
    if (c) parts.push(formatLabel(b.store) + ': ' + c);
  }
  if (dist.skip) parts.push('skip: ' + dist.skip);
  document.getElementById('orient-dist').textContent = parts.length ? parts.join(' · ') : '—';
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
    const url = sheetUrl({ action: 'listPunchDirections16', labeler: '' });
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
  grp.label = 'Cached videos · straight-punch direction (22.5°)';
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
  buildDial();

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
    tryGenerateCandidates();
  });

  // Loop the current punch window. Snap back to start when playback runs past
  // end; backward scrubbing is allowed. 50ms epsilon dodges float jitter.
  video.addEventListener('timeupdate', () => {
    const lw = state.loopWindow;
    if (!lw) return;
    if (video.currentTime > lw.end + 0.05) video.currentTime = lw.start;
  });

  document.getElementById('btn-first').addEventListener('click', gotoFirst);
  document.getElementById('btn-prev').addEventListener('click', gotoPrev);
  document.getElementById('btn-next').addEventListener('click', gotoNext);
  document.getElementById('btn-next-unlabeled').addEventListener('click', gotoNextUnlabeled);
  document.getElementById('btn-clear').addEventListener('click', clearCurrent);

  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key in KEY_BINS) { e.preventDefault(); const m = KEY_BINS[e.key]; applyLabel(m.store, m.skip); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); gotoNext(); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); gotoPrev(); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); gotoFirst(); return; }
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); gotoNextUnlabeled(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); clearCurrent(); return; }
  });

  setStatus('—');
  setCurrentLine('— type or pick a video name to begin —');
});
