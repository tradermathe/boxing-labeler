// ============================================================
// axiality_review.js — GT-vs-model review for straight-punch direction.
//
// A read-only sibling of punch_dir_16.js. Instead of labelling, it loops
// through a video's straight punches and shows, for each, the ground-truth
// axiality bucket next to the temporal FA model's out-of-fold prediction,
// with the Apple Vision skeleton drawn over the (locally-opened) video.
//
// Reuses player.js for the video chrome + shared `state`. All data comes
// from the static axiality_review.json (exported by
// cornerman-backend/axiality/export_review.py) — no sheet/Apps Script calls.
// ============================================================

const REVIEW_JSON = './axiality_review.json';

// COCO-17 skeleton edges. Arm edges are recolored per-punch to the punching arm.
const BONES = [
  [0, 1], [0, 2], [1, 3], [2, 4],            // face
  [5, 6], [5, 11], [6, 12], [11, 12],        // torso
  [5, 7], [7, 9], [6, 8], [8, 10],           // arms
  [11, 13], [13, 15], [12, 14], [14, 16],    // legs
];
const DRAW_CONF = 0.20;            // skip joints/bones below this confidence
const ARM_COLOR = '#c75b39';       // terracotta — punching forearm/upper-arm
const BONE_COLOR = '#49d6e0';      // cyan — everything else
const JOINT_COLOR = '#ffffff';

Object.assign(state, {
  reviewData: null,        // parsed axiality_review.json
  bucketNames: [],
  candidates: [],          // punches for the current video (sorted by start)
  cursor: 0,
  currentStem: null,
  videoLoaded: false,
});

// ─── load + dropdown ────────────────────────────────────────────────────────
async function loadReviewData() {
  const res = await fetch(REVIEW_JSON, { cache: 'no-cache' });
  if (!res.ok) throw new Error('axiality_review.json HTTP ' + res.status);
  return res.json();
}

function videoAcc(punches) {
  let ex = 0, pm1 = 0;
  for (const p of punches) { if (p.delta === 0) ex++; if (Math.abs(p.delta) <= 1) pm1++; }
  const n = punches.length || 1;
  return { exact: ex / n, pm1: pm1 / n, n: punches.length };
}

function populateVideoSelect() {
  const sel = document.getElementById('video-select');
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = '— pick a video —';
  sel.appendChild(ph);

  const stems = Object.keys(state.reviewData.videos).sort((a, b) => a.localeCompare(b));
  const grp = document.createElement('optgroup');
  grp.label = 'Scored videos · straight-punch axiality (GT vs model)';
  for (const stem of stems) {
    const punches = state.reviewData.videos[stem];
    const a = videoAcc(punches);
    const opt = document.createElement('option');
    opt.value = stem;
    opt.dataset.stem = stem;
    opt.textContent = `${stem}  (${a.n} · ±1 ${(100 * a.pm1).toFixed(0)}%)`;
    grp.appendChild(opt);
  }
  sel.appendChild(grp);
}

function setOverallReadout() {
  const m = state.reviewData.meta;
  const ens = (m.metrics && m.metrics['TCN_FA (ours, 3-seed ensemble)']) || null;
  if (ens) {
    document.getElementById('overall-readout').textContent =
      `overall: exact ${(100 * ens.overall_exact).toFixed(1)}% · ±1 ${(100 * ens.overall_pm1).toFixed(1)}%  ·  ${m.n_punches} punches / ${m.n_videos} videos`;
  } else {
    document.getElementById('overall-readout').textContent =
      `${m.n_punches} punches / ${m.n_videos} videos`;
  }
}

// ─── selection ──────────────────────────────────────────────────────────────
function selectVideo(stem) {
  state.currentStem = stem || null;
  state.candidates = stem ? (state.reviewData.videos[stem] || []) : [];
  state.cursor = 0;
  state.loopWindow = null;
  renderVideoStats();
  if (!stem) { setCurrent('— pick a video to start —'); clearVerdict(); return; }
  if (!state.candidates.length) { setCurrent('No scored straights for "' + stem + '".'); clearVerdict(); return; }
  if (state.videoLoaded) seekToCurrent();
  else setCurrent('Loaded ' + state.candidates.length + ' punches for "' + stem + '". Now open the local .mp4 file.');
}

// ─── loop window (same pattern as the labeler) ──────────────────────────────
function seekToCurrent() {
  if (!state.candidates.length) return;
  const c = state.candidates[state.cursor];
  const video = document.getElementById('video-player');
  state.loopWindow = { start: Math.max(0, c.start_sec), end: c.end_sec };
  if (video && !isNaN(video.duration) && video.duration > 0) {
    video.currentTime = Math.min(Math.max(0, c.start_sec), video.duration);
    if (video.paused) { const pp = video.play(); if (pp && pp.catch) pp.catch(() => {}); }
  }
  renderCurrent();
}

function gotoFirst() { if (state.candidates.length) { state.cursor = 0; seekToCurrent(); } }
function gotoPrev()  { if (state.candidates.length) { state.cursor = Math.max(0, state.cursor - 1); seekToCurrent(); } }
function gotoNext()  { if (state.candidates.length) { state.cursor = Math.min(state.candidates.length - 1, state.cursor + 1); seekToCurrent(); } }

function gotoNextWhere(pred, label) {
  const N = state.candidates.length;
  if (!N) return;
  for (let i = 1; i <= N; i++) {
    const idx = (state.cursor + i) % N;
    if (pred(state.candidates[idx])) { state.cursor = idx; seekToCurrent(); return; }
  }
  setStatus('No ' + label + ' in this video.', 'ok');
}
function gotoNextMiss()  { gotoNextWhere(c => c.delta !== 0, 'misses'); }
function gotoNextWrong() { gotoNextWhere(c => Math.abs(c.delta) >= 2, '≥2-bucket misses'); }

// ─── panel rendering ────────────────────────────────────────────────────────
function setCurrent(text) { document.getElementById('review-current').textContent = text; }
function setStatus(text, cls) {
  const el = document.getElementById('review-status');
  el.textContent = text; el.classList.remove('ok', 'err'); if (cls) el.classList.add(cls);
}
function clearVerdict() {
  const v = document.getElementById('verdict');
  v.textContent = '—'; v.className = '';
  document.getElementById('gt-bucket').textContent = '—';
  document.getElementById('pred-bucket').textContent = '—';
  document.getElementById('gt-aux').textContent = '';
  document.getElementById('pred-aux').textContent = '';
  buildBucketStrip(-1, -1);
}

function buildBucketStrip(gt, pred) {
  const strip = document.getElementById('bucket-strip');
  strip.innerHTML = '';
  state.bucketNames.forEach((name, i) => {
    const cell = document.createElement('div');
    cell.className = 'bk-cell' + (i === gt ? ' gt' : '') + (i === pred ? ' pred' : '');
    cell.innerHTML = `<div class="bk-name">${name.replace('_', '<br>')}</div>`;
    strip.appendChild(cell);
  });
}

function renderCurrent() {
  const c = state.candidates[state.cursor];
  if (!c) return;
  const idx = `${state.cursor + 1}/${state.candidates.length}`;
  const win = `${c.start_sec.toFixed(2)}–${c.end_sec.toFixed(2)}s`;
  setCurrent(`${c.punch_type} · ${c.stance} · ${win} · ${idx}`);

  const names = state.bucketNames;
  const ad = Math.abs(c.delta);
  const v = document.getElementById('verdict');
  if (ad === 0) { v.className = 'exact'; v.textContent = '✓ exact'; }
  else if (ad === 1) { v.className = 'pm1'; v.textContent = `± one bucket (model ${c.delta > 0 ? 'higher' : 'lower'})`; }
  else { v.className = 'wrong'; v.textContent = `✗ ${ad} buckets off (model ${c.delta > 0 ? 'higher' : 'lower'})`; }

  document.getElementById('gt-bucket').textContent = names[c.gt_bucket];
  document.getElementById('gt-aux').textContent = `${c.gt_angle}° · |cos|=${c.gt_axiality.toFixed(2)}`;
  document.getElementById('pred-bucket').textContent = names[c.pred_bucket];
  document.getElementById('pred-aux').textContent = `|cos|=${c.pred_axiality.toFixed(2)}`;
  buildBucketStrip(c.gt_bucket, c.pred_bucket);
  setStatus('out-of-fold prediction', 'ok');
}

function renderVideoStats() {
  const a = videoAcc(state.candidates);
  document.getElementById('st-exact').textContent = state.candidates.length ? `${(100 * a.exact).toFixed(1)}%` : '—';
  document.getElementById('st-pm1').textContent = state.candidates.length ? `${(100 * a.pm1).toFixed(1)}%` : '—';
  document.getElementById('st-n').textContent = state.candidates.length ? a.n : '—';
  document.getElementById('bar-pm1').style.width = (100 * a.pm1) + '%';
  document.getElementById('bar-exact').style.width = (100 * a.exact) + '%';
}

// ─── skeleton overlay ───────────────────────────────────────────────────────
function nearestFrame(c, t) {
  const F = c.frames;
  if (!F.length) return null;
  let best = F[0], bd = Math.abs(F[0].t - t);
  for (let i = 1; i < F.length; i++) {
    const d = Math.abs(F[i].t - t);
    if (d < bd) { bd = d; best = F[i]; }
  }
  return best;
}

// player.js calls this on every timeupdate; the rAF loop covers smooth playback.
function updateVideoOverlay() { drawSkeleton(); }

function drawSkeleton() {
  const canvas = document.getElementById('skeleton-overlay');
  const video = document.getElementById('video-player');
  if (!canvas || !video) return;
  const ctx = canvas.getContext('2d');
  const cw = video.clientWidth, ch = video.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.style.left = video.offsetLeft + 'px'; canvas.style.top = video.offsetTop + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const show = document.getElementById('chk-skeleton').checked;
  const c = state.candidates[state.cursor];
  if (!show || !c || !video.videoWidth) return;
  const fr = nearestFrame(c, video.currentTime);
  if (!fr) return;

  const sx = cw / c.W, sy = ch / c.H;        // native px -> displayed px (object-fit: fill)
  const J = fr.j;
  const armSet = new Set([
    Math.min(c.arm[0], c.arm[1]) + '-' + Math.max(c.arm[0], c.arm[1]),
    Math.min(c.arm[1], c.arm[2]) + '-' + Math.max(c.arm[1], c.arm[2]),
  ]);

  ctx.lineWidth = 3; ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const ja = J[a], jb = J[b];
    if (!ja || !jb || ja[2] < DRAW_CONF || jb[2] < DRAW_CONF) continue;
    const isArm = armSet.has(Math.min(a, b) + '-' + Math.max(a, b));
    ctx.strokeStyle = isArm ? ARM_COLOR : BONE_COLOR;
    ctx.globalAlpha = isArm ? 0.95 : 0.7;
    ctx.lineWidth = isArm ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(ja[0] * sx, ja[1] * sy);
    ctx.lineTo(jb[0] * sx, jb[1] * sy);
    ctx.stroke();
  }
  for (let j = 0; j < 17; j++) {
    const p = J[j];
    if (!p || p[2] < DRAW_CONF) continue;
    ctx.globalAlpha = Math.min(1, 0.4 + p[2]);
    ctx.fillStyle = (j === c.arm[2]) ? ARM_COLOR : JOINT_COLOR;   // wrist of punching arm pops
    ctx.beginPath();
    ctx.arc(p[0] * sx, p[1] * sy, j === c.arm[2] ? 5 : 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function overlayLoop() { drawSkeleton(); requestAnimationFrame(overlayLoop); }

// ─── wire-up ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupPlayer();

  try {
    state.reviewData = await loadReviewData();
  } catch (e) {
    setStatus('Failed to load axiality_review.json: ' + e.message, 'err');
    setCurrent('Could not load review data. Re-run export_review.py and redeploy.');
    return;
  }
  state.bucketNames = state.reviewData.meta.names;
  populateVideoSelect();
  setOverallReadout();
  buildBucketStrip(-1, -1);

  const sel = document.getElementById('video-select');
  sel.addEventListener('change', () => selectVideo(sel.value || null));

  // Auto-match the opened local file to a scored stem (operator can still override).
  document.getElementById('video-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const stem = f.name.replace(/\.[^.]+$/, '');
    const stems = Object.keys(state.reviewData.videos);
    const hit = stems.includes(stem) ? stem
      : stems.find(s => s.toLowerCase() === stem.toLowerCase());
    if (hit) { sel.value = hit; selectVideo(hit); }
  });

  const video = document.getElementById('video-player');
  video.addEventListener('loadedmetadata', () => {
    state.videoLoaded = true;
    if (state.currentStem && state.candidates.length) seekToCurrent();
  });
  // Loop the current punch window (50ms epsilon dodges float jitter).
  video.addEventListener('timeupdate', () => {
    const lw = state.loopWindow;
    if (lw && video.currentTime > lw.end + 0.05) video.currentTime = lw.start;
  });

  document.getElementById('btn-first').addEventListener('click', gotoFirst);
  document.getElementById('btn-prev').addEventListener('click', gotoPrev);
  document.getElementById('btn-next').addEventListener('click', gotoNext);
  document.getElementById('btn-next-miss').addEventListener('click', gotoNextMiss);
  document.getElementById('btn-next-wrong').addEventListener('click', gotoNextWrong);

  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); gotoNext(); }
    else if (k === 'p') { e.preventDefault(); gotoPrev(); }
    else if (k === 'f') { e.preventDefault(); gotoFirst(); }
    else if (k === 'm') { e.preventDefault(); gotoNextMiss(); }
    else if (k === 'w') { e.preventDefault(); gotoNextWrong(); }
    else if (k === 's') { e.preventDefault(); document.getElementById('chk-skeleton').click(); }
  });

  setStatus('Pick a video, then open its local .mp4.', 'ok');
  requestAnimationFrame(overlayLoop);
});
