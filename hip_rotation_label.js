// ============================================================
// hip_rotation_label.js — hip-rotation rubric labeler
//
// A focused fork of punch_dir_16.js. One ordinal label per qualified
// punch (keyed by punch_uuid), scoring how much the boxer rotated the
// hips on a 4-level checkpoint rubric (keys 1–4) instead of a 22.5°
// dial. Saved to the "Hip Rotation Rubric" sheet via the
// saveHipRotation / listHipRotation / deleteHipRotation Apps Script
// actions.
//
// Candidates come from Combined Data (listPunchesForVideo, shared with
// the punch-direction pages), filtered here to the punch types the
// hip_rotation rule applies to (crosses + head hooks + head uppercuts;
// jabs and body hooks/uppercuts excluded — see APPLIES_TO).
//
// Reuses player.js for the video chrome, sheetUrl(), and shared `state`.
// ============================================================

// The 4-level rubric. `score` is what's written to the sheet; `key` is
// the keyboard shortcut. The anchors reduce to two visible checkpoints —
// does the rear heel pivot, and do the hips drive through — so a label
// is reproducible rather than a vibe. Score rises with rotation, so the
// downstream test can rank it against the rule's recovered angle.
const RUBRIC = [
  { score: 1, key: '1', name: 'None',
    blurb: 'Hips stay square/bladed the whole punch, rear heel planted. Arm-only.' },
  { score: 2, key: '2', name: 'Token',
    blurb: 'Slight hip twitch but the rear heel stays down — no real turn.' },
  { score: 3, key: '3', name: 'Partial',
    blurb: 'Rear heel pivots and hips turn, but they don’t drive through.' },
  { score: 4, key: '4', name: 'Full',
    blurb: 'Heel pivots and hips clearly drive through toward the target.' },
];
const VALID_SCORES = RUBRIC.map(r => r.score);

// key char -> { score, skip }. 1–4 = rubric; [s] = skip (can't tell).
const KEY_SCORES = {};
for (const r of RUBRIC) KEY_SCORES[r.key] = { score: r.score, skip: false };
KEY_SCORES['s'] = { score: null, skip: true };
KEY_SCORES['S'] = { score: null, skip: true };

// Punch types the hip_rotation rule evaluates — must match APPLIES_TO in
// cornerman-backend/cornerman_rules/rules/hip_rotation.py exactly, so the
// labels line up with what the rule scores. Body hooks/uppercuts and jabs
// are excluded.
const APPLIES_TO = new Set([
  'cross_head', 'cross_body',
  'lead_hook_head', 'rear_hook_head',
  'lead_uppercut_head', 'rear_uppercut_head',
]);
function qualifies(punchType) {
  return APPLIES_TO.has(String(punchType || '').trim().toLowerCase());
}

function formatLabel(v) {
  if (v === undefined) return 'unlabeled';
  if (v === null) return 'skipped';
  const r = RUBRIC.find(x => x.score === Number(v));
  return r ? `${r.score} · ${r.name}` : String(v);
}

Object.assign(state, {
  knownVideos: [],          // from videos.json — only source of labelable videos
  currentStem: null,
  candidates: [],           // qualified punches for the current video
  cursor: 0,
  doneKeys: new Set(),
  labelByKey: new Map(),
  coverageByUuid: new Map(),       // current video: punch_uuid -> Set<labeler> (any labeler)
  videoLoaded: false,
  labelCountsByVideo: new Map(),   // stem -> total punches labeled by anyone
  contextOn: true,                 // X toggles the ±pad context vs punch-only loop
});

function keyFor(c) {
  return c ? 'p:' + c.punch_uuid : null;
}

// ─── candidate fetch (Combined Data, qualified punches only) ───────────────
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
    if (!qualifies(r.label)) continue;
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

// ─── sheet sync (Hip Rotation Rubric) ──────────────────────────────────────
async function fetchHipRotation(video, labeler) {
  const url = sheetUrl({ action: 'listHipRotation', video, labeler });
  const res = await fetch(url);
  if (!res.ok) throw new Error('listHipRotation HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('listHipRotation: ' + (body.message || 'unknown'));
  return body.rows;
}
async function saveHipRotation({ labeler, video, punch_uuid, punch_type, start_sec, end_sec, label }) {
  const params = { action: 'saveHipRotation', labeler, video, punch_uuid, punch_type };
  params.start_sec = (start_sec === undefined || start_sec === null) ? '' : String(start_sec);
  params.end_sec   = (end_sec === undefined || end_sec === null) ? '' : String(end_sec);
  params.label     = (label === null || label === undefined) ? '' : String(label);
  const url = sheetUrl(params);
  const res = await fetch(url);
  if (!res.ok) throw new Error('saveHipRotation HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('saveHipRotation: ' + (body.message || 'unknown'));
  return body;
}
async function deleteHipRotation({ labeler, punch_uuid }) {
  const url = sheetUrl({ action: 'deleteHipRotation', labeler, punch_uuid });
  const res = await fetch(url);
  if (!res.ok) throw new Error('deleteHipRotation HTTP ' + res.status);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error('deleteHipRotation: ' + (body.message || 'unknown'));
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

// ─── rubric buttons ──────────────────────────────────────────────────────────
function buildRubric() {
  const wrap = document.getElementById('rubric');
  if (!wrap) return;
  for (const r of RUBRIC) {
    const btn = document.createElement('button');
    btn.className = 'rubric-btn';
    btn.dataset.score = String(r.score);
    btn.innerHTML =
      `<span class="rubric-key">${r.key}</span>` +
      `<span class="rubric-body"><span class="rubric-name">${r.name}</span>` +
      `<span class="rubric-blurb">${r.blurb}</span></span>`;
    btn.addEventListener('click', () => applyScore(r.score, false));
    wrap.appendChild(btn);
  }
  const skip = document.createElement('button');
  skip.className = 'rubric-btn skip';
  skip.dataset.skip = '1';
  skip.innerHTML =
    `<span class="rubric-key">S</span>` +
    `<span class="rubric-body"><span class="rubric-name">Skip</span>` +
    `<span class="rubric-blurb">Can’t tell — occluded, off-frame, or ambiguous.</span></span>`;
  skip.addEventListener('click', () => applyScore(null, true));
  wrap.appendChild(skip);
}

function updateButtonHighlight() {
  const c = state.candidates[state.cursor];
  const existing = c ? state.labelByKey.get(keyFor(c)) : undefined;  // undefined | null | number
  for (const btn of document.querySelectorAll('.rubric-btn')) {
    let matches = false;
    if (btn.dataset.skip === '1') {
      matches = existing === null && c !== undefined && state.doneKeys.has(keyFor(c));
    } else if (existing !== undefined && existing !== null) {
      matches = Number(existing) === Number(btn.dataset.score);
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
  setCurrentLine('Loading qualified punches from Combined Data for "' + state.currentStem + '"…');
  try {
    state.candidates = await fetchPunchCandidates(state.currentStem);
  } catch (e) {
    setModeBadge('error');
    setCurrentLine('Failed to load punches: ' + e.message);
    setStatus(e.message, 'err');
    return;
  }
  if (state.candidates.length === 0) {
    setModeBadge('0 qualified');
    setCurrentLine('No hip-rotation-qualified punches in Combined Data for "' + state.currentStem +
      '" (crosses / head hooks / head uppercuts only).');
    redrawProgress();
    return;
  }
  setModeBadge(state.candidates.length + ' qualified');
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
    // Pull every labeler's rows for this video: the in-video UX (rubric, progress,
    // next-unlabeled) reflects only YOUR labels, but the dropdown count is the
    // total of punches labeled by anyone (deduped by punch_uuid).
    const rows = await fetchHipRotation(state.currentStem, '');
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
  setCurrentLine('All qualified punches labelled for this video — pick another, or use Prev to review.');
}

// Loop the punch window with a little padding so the wind-up (heel load) and
// the drive-through are both visible — both are rubric checkpoints.
const PUNCH_LEAD_IN_SEC = 0.4;
const PUNCH_TRAIL_OUT_SEC = 0.4;

function seekToCurrent() {
  if (!state.candidates.length) return;
  if (state.cursor >= state.candidates.length) {
    state.loopWindow = null;
    return;
  }
  const c = state.candidates[state.cursor];
  const video = document.getElementById('video-player');
  const pad = state.contextOn === false ? 0 : 1;   // X toggles context padding
  const start = Math.max(0, c.start_sec - PUNCH_LEAD_IN_SEC * pad);
  const end   = c.end_sec + PUNCH_TRAIL_OUT_SEC * pad;
  state.loopWindow = { start, end, punchStart: c.start_sec, punchEnd: c.end_sec };

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

function applyScore(score, isSkip) {
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
  const labelVal = isSkip ? null : score;

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

  saveHipRotation({
    labeler, video: state.currentStem, punch_uuid: c.punch_uuid,
    punch_type: c.punch_type, start_sec: c.start_sec, end_sec: c.end_sec,
    label: labelVal,
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
    await deleteHipRotation({ labeler, punch_uuid: c.punch_uuid });
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

// ─── punch-vs-context visual cue ─────────────────────────────────────────────
// On a loop the punch and its padding blur together. A rAF loop reads the
// playhead each frame and (a) rings the video green only inside the labelled
// [punchStart, punchEnd] window, (b) names the phase. timeupdate (~4 Hz) is too
// coarse for a sub-second punch, hence rAF.
function tickPhaseCue() {
  const video = document.getElementById('video-player');
  const cue = document.getElementById('phase-cue');
  const banner = document.getElementById('punch-banner');
  const viewport = document.getElementById('video-viewport');
  const lw = state.loopWindow;
  let text = '—', cls = '', inPunch = false, active = false;
  if (video && lw && state.candidates.length && state.cursor < state.candidates.length) {
    active = true;
    const t = video.currentTime;
    if (t < lw.punchStart) { text = 'pre-buffer'; cls = 'ctx'; }
    else if (t > lw.punchEnd) { text = 'post-buffer'; cls = 'ctx'; }
    else { text = '● PUNCH'; cls = 'punch'; inPunch = true; }
  }
  if (cue) { cue.textContent = text; cue.className = 'phase-cue ' + cls; }
  if (banner) {
    banner.textContent = active ? text.toUpperCase() : '';
    banner.className = 'punch-banner ' + (active ? cls : 'hidden');
  }
  if (viewport) viewport.classList.toggle('in-punch', inPunch);
  requestAnimationFrame(tickPhaseCue);
}

function updateLoopMode() {
  const el = document.getElementById('loop-mode');
  if (!el) return;
  el.textContent = state.contextOn === false
    ? 'punch only'
    : `±${PUNCH_LEAD_IN_SEC}s context`;
}

function toggleContext() {
  state.contextOn = state.contextOn === false ? true : false;
  updateLoopMode();
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
  const parts = [];
  for (const r of RUBRIC) {
    const c = dist[String(r.score)] || 0;
    if (c) parts.push(r.score + '·' + r.name + ': ' + c);
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
    const url = sheetUrl({ action: 'listHipRotation', labeler: '' });
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
  grp.label = 'Cached videos · hip-rotation rubric';
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
  buildRubric();

  const labelerInput = document.getElementById('labeler-input');
  try { labelerInput.value = localStorage.getItem('hiprot_labeler_name') || ''; } catch {}
  labelerInput.addEventListener('change', async () => {
    try { localStorage.setItem('hiprot_labeler_name', labelerInput.value.trim()); } catch {}
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
    if (e.key in KEY_SCORES) { e.preventDefault(); const m = KEY_SCORES[e.key]; applyScore(m.score, m.skip); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); gotoNext(); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); gotoPrev(); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); gotoFirst(); return; }
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); gotoNextUnlabeled(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); clearCurrent(); return; }
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); toggleContext(); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepFrames(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepFrames(1); return; }
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); togglePlay(); return; }
  });

  updateLoopMode();
  requestAnimationFrame(tickPhaseCue);

  setStatus('—');
  setCurrentLine('— type or pick a video name to begin —');
});
