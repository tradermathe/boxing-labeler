// ============================================================
// bodyshot.js — Bodyshot Reclassifier (page-specific)
//
// Temporary tool to sweep over every `lead_bodyshot` /
// `rear_bodyshot` clip and reclassify it as a hook / uppercut /
// straight body variant.
//
// Clips are pre-extracted by `extract_bodyshot_clips.py` and bundled
// in `clips/` next to this file, with a manifest at
// `clips/manifest.json`. The page reads the manifest and plays each
// clip directly — no local video import needed.
//
// Reclassify writes through the Apps Script `reclassify` action,
// which updates both the originating labeler sheet (canonical) and
// Combined Data (so a future re-extraction drops the row from the
// queue automatically).
//
// Shared video + seek-bar + zoom + helpers live in player.js
// (loaded first). The shared `state` object is defined there;
// this file extends it with page-specific keys.
// ============================================================

Object.assign(state, {
  shots: [],          // [{ punch_uuid, clip, video_name, video_file, punch, start_sec, end_sec, stance, status, newType }]
  currentIdx: -1,
  loopEnabled: true,
  // status values: 'pending' | 'done' | 'skip'
});

// localStorage key — surviving reclassifications across refreshes so
// already-handled rows stay flagged even before the user re-extracts.
const RECLASSIFIED_KEY = 'bodyshot_reclassified_v1';

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  setupPlayer();
  setupKeyboardShortcuts();
  attachVideoListeners();
  await loadManifest();
  hookLoopWatcher();
});

function attachVideoListeners() {
  // player.js's setupVideoLoader() bails out because the original
  // file picker isn't on this page, so we wire up the listeners it
  // would otherwise add ourselves.
  const video = document.getElementById('video-player');
  video.addEventListener('loadedmetadata', () => {
    state.frameDuration = 1 / 30;
    state.fpsDetected = false;
    if (typeof detectFrameRate === 'function') detectFrameRate(video);
    if (typeof updateTimeDisplay === 'function') updateTimeDisplay();
    if (typeof renderTimelineOverlay === 'function') renderTimelineOverlay();
  });
  video.addEventListener('timeupdate', () => {
    if (typeof updateTimeDisplay === 'function') updateTimeDisplay();
  });
  if (typeof _onSeeked === 'function') video.addEventListener('seeked', _onSeeked);
  // <video loop> is good enough since each clip IS the start->end window.
  video.loop = true;
}

function hookLoopWatcher() {
  // Belt-and-suspenders: video.loop handles seamless looping, but if
  // the user toggles loop off we still want the manual replay UX —
  // keep the timeupdate listener so the toggle has an effect.
  const video = document.getElementById('video-player');
  video.addEventListener('ended', () => {
    if (state.loopEnabled) video.play().catch(() => {});
  });
}

// ============================================================
// Manifest load
// ============================================================
async function loadManifest() {
  setLoadStatus('Loading clips...');
  try {
    const resp = await fetch('clips/manifest.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('manifest.json missing — run extract_bodyshot_clips.py');
    const data = await resp.json();
    const reclassified = readReclassifiedFromStorage();
    state.shots = (data.shots || []).map(s => ({
      ...s,
      status: reclassified[s.punch_uuid] ? 'done' : 'pending',
      newType: reclassified[s.punch_uuid] || null,
    }));
    state.currentIdx = state.shots.length > 0 ? 0 : -1;
    renderShotList();
    renderCurrentShot();
    selectShot(state.currentIdx);
    setLoadStatus(`${state.shots.length} clips loaded`);
  } catch (e) {
    console.error('manifest load failed', e);
    setLoadStatus('Failed to load manifest: ' + e.message, true);
  }
}

function readReclassifiedFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(RECLASSIFIED_KEY) || '{}');
  } catch {
    return {};
  }
}

function persistReclassification(uuid, newType) {
  const all = readReclassifiedFromStorage();
  all[uuid] = newType;
  localStorage.setItem(RECLASSIFIED_KEY, JSON.stringify(all));
}

function setLoadStatus(text, isError) {
  const el = document.getElementById('load-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#e94560' : '#888';
}

function updateLoadStatus() {
  const total = state.shots.length;
  if (total === 0) return;
  const done = state.shots.filter(s => s.status === 'done').length;
  const skip = state.shots.filter(s => s.status === 'skip').length;
  setLoadStatus(`${total} clips · ${done} reclassified · ${skip} skipped`);
}

// ============================================================
// Shot list rendering
// ============================================================
function renderShotList() {
  const list = document.getElementById('shot-list');
  const count = document.getElementById('shot-list-count');
  count.textContent = `(${state.shots.length})`;
  list.innerHTML = '';

  state.shots.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'shot-row status-' + s.status;
    if (idx === state.currentIdx) row.classList.add('current');

    const flag = s.status === 'done' ? '✓' : (s.status === 'skip' ? '~' : '');
    const display = prettyPunch(s.newType || s.punch);

    row.innerHTML = `
      <span class="sr-idx">${idx + 1}</span>
      <span class="sr-name" title="${escapeHtml(s.video_name || '')}">
        ${escapeHtml((s.video_name || '').slice(0, 28) || '—')}
        <br><small style="color:#888">${display}</small>
      </span>
      <span class="sr-time">${formatTime(s.start_sec)}</span>
      <span class="sr-flag">${flag}</span>
    `;
    row.onclick = () => selectShot(idx);
    list.appendChild(row);
  });

  updateProgress();
  updateLoadStatus();
}

function updateProgress() {
  const done = state.shots.filter(s => s.status === 'done').length;
  const skip = state.shots.filter(s => s.status === 'skip').length;
  const total = state.shots.length;
  document.getElementById('shot-progress').textContent =
    total > 0 ? `${done} done · ${skip} skipped · ${total - done - skip} pending` : '';
}

function prettyPunch(s) {
  if (!s) return '—';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================
// Selection + navigation
// ============================================================
function selectShot(idx) {
  if (idx < 0 || idx >= state.shots.length) return;
  state.currentIdx = idx;
  renderShotList();
  renderCurrentShot();

  const shot = state.shots[idx];
  const video = document.getElementById('video-player');
  if (video.dataset.activeUuid !== shot.punch_uuid) {
    video.dataset.activeUuid = shot.punch_uuid;
    video.src = shot.clip;
    video.load();
    video.play().catch(() => {});
  } else {
    video.currentTime = 0;
    video.play().catch(() => {});
  }

  state.videoName = shot.video_name || '';
  document.getElementById('video-name').textContent = shot.video_name || '—';

  const entry = document.querySelectorAll('.shot-row')[idx];
  if (entry) entry.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function nextShot() {
  // Prefer the next shot still pending; if everything's resolved, just
  // step linearly so the user can revisit.
  const start = state.currentIdx;
  for (let i = start + 1; i < state.shots.length; i++) {
    if (state.shots[i].status === 'pending') return selectShot(i);
  }
  selectShot(Math.min(state.shots.length - 1, start + 1));
}

function prevShot() { selectShot(Math.max(0, state.currentIdx - 1)); }

function skipShot() {
  const shot = state.shots[state.currentIdx];
  if (!shot) return;
  shot.status = 'skip';
  renderShotList();
  nextShot();
}

// ============================================================
// Current shot card (right panel)
// ============================================================
function renderCurrentShot() {
  const card = document.getElementById('current-shot-card');
  const shot = state.shots[state.currentIdx];
  if (!shot) {
    card.innerHTML = '<div id="current-shot-empty" style="color:#888; text-align:center; padding:8px">No shots loaded</div>';
    return;
  }
  card.innerHTML = `
    <div class="cs-row"><span class="cs-label">#</span><span class="cs-value">${state.currentIdx + 1} of ${state.shots.length}</span></div>
    <div class="cs-row"><span class="cs-label">Video</span><span class="cs-value">${escapeHtml(shot.video_name || '—')}</span></div>
    <div class="cs-row"><span class="cs-label">Current</span><span class="cs-value"><strong>${prettyPunch(shot.newType || shot.punch)}</strong></span></div>
    <div class="cs-row"><span class="cs-label">Stance</span><span class="cs-value">${escapeHtml(shot.stance || '—')}</span></div>
    <div class="cs-row"><span class="cs-label">Span</span><span class="cs-value">${formatTime(shot.start_sec)} &rarr; ${formatTime(shot.end_sec)} <small style="color:#888">(${(shot.end_sec - shot.start_sec).toFixed(2)}s)</small></span></div>
  `;
}

// ============================================================
// Reclassify
// ============================================================
async function reclassify(newType) {
  const shot = state.shots[state.currentIdx];
  if (!shot) return;
  if (!shot.punch_uuid) {
    showToast('Shot has no punch_uuid — re-run the extraction script.', 'error');
    return;
  }

  // Optimistic UI: mark done, advance, fix up if save fails.
  const previousType = shot.punch;
  const previousStatus = shot.status;
  shot.newType = newType;
  shot.punch = newType;
  shot.status = 'done';
  persistReclassification(shot.punch_uuid, newType);
  renderShotList();
  renderCurrentShot();
  showToast(`Marked ${prettyPunch(newType)}, saving...`, 'info');
  nextShot();

  try {
    const url = sheetUrl({
      action: 'reclassify',
      punch_uuid: shot.punch_uuid,
      new_punch_type: newType,
    });
    const resp = await fetch(url);
    const result = await resp.json();
    if (result.status === 'error') {
      showToast('Save failed: ' + result.message, 'error');
      shot.punch = previousType;
      shot.newType = null;
      shot.status = previousStatus;
      const all = readReclassifiedFromStorage();
      delete all[shot.punch_uuid];
      localStorage.setItem(RECLASSIFIED_KEY, JSON.stringify(all));
      renderShotList();
      renderCurrentShot();
      return;
    }
    const labelerHits = (result.labeler_hits || []).length;
    showToast(`Saved (${labelerHits} sheet row${labelerHits === 1 ? '' : 's'} updated)`, 'info');
  } catch (e) {
    console.error('reclassify failed', e);
    showToast('Save failed: ' + e.message + ' (Apps Script redeployed?)', 'error');
    // Don't roll back optimistic UI — the user wants to keep moving;
    // localStorage flag means the row stays marked done on refresh,
    // and the actual sheet write can be retried via the manifest later.
  }
}

// ============================================================
// Loop toggle
// ============================================================
function toggleLoop() {
  state.loopEnabled = !state.loopEnabled;
  const video = document.getElementById('video-player');
  video.loop = state.loopEnabled;
  const btn = document.getElementById('btn-loop');
  if (btn) btn.textContent = 'Loop: ' + (state.loopEnabled ? 'ON' : 'OFF');
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') e.target.blur();

    switch (e.code) {
      case 'Space':
        e.preventDefault(); togglePlay(); break;

      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) dir > 0 ? nextShot() : prevShot();
        else stepFrames(dir);
        break;
      }

      case 'KeyL': e.preventDefault(); toggleOverlay(); break;
      case 'KeyS': e.preventDefault(); skipShot(); break;

      case 'Digit1': case 'Numpad1': e.preventDefault(); reclassify('lead_hook_body'); break;
      case 'Digit2': case 'Numpad2': e.preventDefault(); reclassify('rear_hook_body'); break;
      case 'Digit3': case 'Numpad3': e.preventDefault(); reclassify('lead_uppercut_body'); break;
      case 'Digit4': case 'Numpad4': e.preventDefault(); reclassify('rear_uppercut_body'); break;

      case 'Period': case 'Comma':
        if (e.shiftKey) {
          e.preventDefault();
          const speeds = [0.25, 0.5, 1, 2];
          const video = document.getElementById('video-player');
          const cur = speeds.indexOf(video.playbackRate);
          const next = e.code === 'Period'
            ? Math.min(cur + 1, speeds.length - 1)
            : Math.max(cur - 1, 0);
          setSpeed(speeds[next]);
          showToast(`Speed: ${speeds[next]}x`, 'info');
        }
        break;
    }
  });
}

// ============================================================
// Timeline overlay — clips ARE the start->end window so the bar just
// shows playback progress against the clip itself.
// ============================================================
function renderTimelineOverlay() {
  const overlay = document.getElementById('seek-bar-overlay');
  if (!overlay) return;
  overlay.innerHTML = '';
}

function updateVideoOverlay() {
  const overlay = document.getElementById('video-overlay');
  if (!overlay) return;
  const shot = state.shots[state.currentIdx];
  const key = shot ? (shot.newType || shot.punch || '') : '';
  if (overlay.dataset.activeKey === key) return;
  overlay.dataset.activeKey = key;
  overlay.innerHTML = '';
  if (!shot) return;
  const tag = document.createElement('div');
  tag.className = 'video-overlay-tag';
  tag.style.borderLeftColor = '#ffaa33';
  tag.textContent = prettyPunch(shot.newType || shot.punch);
  overlay.appendChild(tag);
}
