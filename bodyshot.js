// ============================================================
// bodyshot.js — Bodyshot Reclassifier (page-specific)
//
// Temporary tool to sweep over every `lead_bodyshot` /
// `rear_bodyshot` row in Combined Data and reclassify it as a
// hook / uppercut / straight body variant.
//
// Flow:
//   1. User opens a folder/multi-selects video files.
//   2. Filenames are matched against video_name on each shot row.
//   3. Selecting a shot loads the matching video (if loaded) and
//      loops between start_sec and end_sec.
//   4. A reclassify button calls action=reclassify on the backend,
//      which updates both the labeler sheet (canonical) and the
//      Combined Data row (so the same shot drops out of the list
//      on a refresh).
//
// Shared video + seek-bar + zoom + helpers live in player.js
// (loaded first). The shared `state` object is defined there;
// this file extends it with page-specific keys.
// ============================================================

Object.assign(state, {
  shots: [],          // [{ id, punch_uuid, video_file, video_name, punch, start_sec, end_sec, stance, labeler, status, newType }]
  currentIdx: -1,     // index into state.shots
  videoMap: {},       // filename (lower) -> ObjectURL
  loopEnabled: true,
  // status values: 'pending' | 'done' | 'skip'
});

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  setupPlayer();
  setupKeyboardShortcuts();
  setupVideoFiles();
  fetchBodyshots();
  renderCurrentShot();

  // Loop the current shot — when playback passes end_sec, jump back
  // to start_sec. timeupdate fires often enough (~4×/sec) that the
  // overshoot stays within a frame or two.
  const video = document.getElementById('video-player');
  video.addEventListener('timeupdate', () => {
    if (!state.loopEnabled) return;
    const shot = state.shots[state.currentIdx];
    if (!shot) return;
    if (video.currentTime >= shot.end_sec) {
      video.currentTime = shot.start_sec;
    }
  });
});

// ============================================================
// Multi-file video loader
//
// player.js's setupVideoLoader() bails out because the picker id here
// is `video-files` (plural), so we have to attach the video-element
// listeners ourselves: loadedmetadata for fps detection + frame
// duration, timeupdate to drive the seek bar, seeked to sync chrome.
// ============================================================
function setupVideoFiles() {
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

  const input = document.getElementById('video-files');
  input.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // Accumulate (don't reset) so the user can drop multiple folders one
    // at a time. Keys are lowercased filenames since macOS/iCloud sometimes
    // capitalizes inconsistently.
    for (const f of files) {
      const key = f.name.toLowerCase();
      if (state.videoMap[key]) URL.revokeObjectURL(state.videoMap[key]);
      state.videoMap[key] = URL.createObjectURL(f);
    }

    document.getElementById('video-name').textContent = `${Object.keys(state.videoMap).length} files loaded`;
    renderShotList();
    // If a shot was selected before videos loaded, retry now that we have a match
    if (state.currentIdx >= 0) selectShot(state.currentIdx);
    updateLoadStatus();
  });
}

function updateLoadStatus() {
  const total = state.shots.length;
  if (total === 0) return;
  const matched = state.shots.filter(s => state.videoMap[shotVideoKey(s)]).length;
  const done = state.shots.filter(s => s.status === 'done').length;
  document.getElementById('load-status').textContent =
    `${matched}/${total} matched to videos · ${done} reclassified`;
}

// Filename used as the videoMap key. Combined Data has video_name = filename;
// fall back to the basename of video_file (Drive URL → no help, so this is
// best-effort) so a missing video_name doesn't kill matching outright.
function shotVideoKey(shot) {
  const name = (shot.video_name || '').trim();
  if (name) return name.toLowerCase();
  const url = String(shot.video_file || '');
  const m = url.match(/[^\/]+\.(mp4|mov|m4v|webm)$/i);
  return m ? m[0].toLowerCase() : '';
}

// ============================================================
// Fetch all bodyshots from Combined Data
// ============================================================
async function fetchBodyshots() {
  if (!state.scriptUrl) return;
  setLoadStatus('Loading bodyshots...');
  try {
    const url = sheetUrl({ action: 'listBodyshots' });
    const resp = await fetch(url);
    const result = await resp.json();
    if (result.status === 'error') {
      setLoadStatus('Error: ' + result.message, true);
      return;
    }
    state.shots = (result.shots || []).map(s => ({
      ...s,
      status: 'pending',
      newType: null,
    }));
    // Stable order: by video_name, then start_sec — so neighbors in the list
    // are usually the same video, which matches how a reviewer wants to work.
    state.shots.sort((a, b) => {
      const va = (a.video_name || '').toLowerCase();
      const vb = (b.video_name || '').toLowerCase();
      if (va !== vb) return va < vb ? -1 : 1;
      return a.start_sec - b.start_sec;
    });
    state.currentIdx = state.shots.length > 0 ? 0 : -1;
    renderShotList();
    renderCurrentShot();
    selectShot(state.currentIdx);
    updateLoadStatus();
    setLoadStatus(`${state.shots.length} bodyshots loaded`);
  } catch (e) {
    console.error('listBodyshots failed', e);
    setLoadStatus('Failed to fetch bodyshots: ' + e.message, true);
  }
}

function setLoadStatus(text, isError) {
  const el = document.getElementById('load-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#e94560' : '#888';
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
    row.className = 'shot-row';
    row.classList.add('status-' + s.status);
    if (idx === state.currentIdx) row.classList.add('current');
    const haveVideo = !!state.videoMap[shotVideoKey(s)];
    if (!haveVideo) row.classList.add('missing-video');

    const flag = s.status === 'done' ? '✓' : (s.status === 'skip' ? '~' : '');
    const punchShort = (s.punch || '').replace('_bodyshot', '').replace('_', ' ');
    const display = s.newType ? prettyPunch(s.newType) : prettyPunch(s.punch);

    row.innerHTML = `
      <span class="sr-idx">${idx + 1}</span>
      <span class="sr-name" title="${escapeHtml(s.video_name || s.video_file || '')}">
        ${escapeHtml((s.video_name || '').slice(0, 28) || '—')}
        <br><small style="color:${haveVideo ? '#888' : '#e94560'}">${haveVideo ? display : 'no video'}</small>
      </span>
      <span class="sr-time">${formatTime(s.start_sec)}</span>
      <span class="sr-flag">${flag}</span>
    `;
    row.onclick = () => selectShot(idx);
    list.appendChild(row);
  });

  updateProgress();
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
  const key = shotVideoKey(shot);
  const url = state.videoMap[key];
  if (!url) {
    // No matching video file loaded yet — show the card but don't try to
    // play. Loading the right file later will retrigger this branch.
    video.removeAttribute('src');
    video.load();
    return;
  }

  // Only swap the video src when we change videos — switching ObjectURLs
  // resets the buffer, so we don't want to do it for every shot in the
  // same file.
  if (video.dataset.activeKey !== key) {
    video.dataset.activeKey = key;
    video.src = url;
    video.load();
    const thumbVideo = document.getElementById('thumb-video');
    if (thumbVideo) {
      thumbVideo.src = url;
      thumbVideo.load();
    }
    state.videoName = shot.video_name || '';
    document.getElementById('video-name').textContent = `${Object.keys(state.videoMap).length} files loaded · ${shot.video_name}`;
    video.addEventListener('loadedmetadata', () => seekToShot(idx, true), { once: true });
  } else {
    seekToShot(idx, true);
  }

  const entry = document.querySelectorAll('.shot-row')[idx];
  if (entry) entry.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function seekToShot(idx, autoPlay) {
  const video = document.getElementById('video-player');
  const shot = state.shots[idx];
  if (!shot || !video.duration) return;
  video.currentTime = shot.start_sec;
  if (autoPlay) video.play().catch(() => {});
}

function nextShot() { selectShot(Math.min(state.shots.length - 1, state.currentIdx + 1)); }
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
    card.innerHTML = '<div id="current-shot-empty" style="color:#888; text-align:center; padding:8px">Pick a shot from the list</div>';
    return;
  }
  const haveVideo = !!state.videoMap[shotVideoKey(shot)];
  card.innerHTML = `
    <div class="cs-row"><span class="cs-label">#</span><span class="cs-value">${state.currentIdx + 1} of ${state.shots.length}</span></div>
    <div class="cs-row"><span class="cs-label">Video</span><span class="cs-value" style="${haveVideo ? '' : 'color:#e94560'}">${escapeHtml(shot.video_name || '—')}</span></div>
    <div class="cs-row"><span class="cs-label">Current</span><span class="cs-value"><strong>${prettyPunch(shot.newType || shot.punch)}</strong></span></div>
    <div class="cs-row"><span class="cs-label">Stance</span><span class="cs-value">${escapeHtml(shot.stance || '—')}</span></div>
    <div class="cs-row"><span class="cs-label">Time</span><span class="cs-value">${formatTime(shot.start_sec)} &rarr; ${formatTime(shot.end_sec)} <small style="color:#888">(${(shot.end_sec - shot.start_sec).toFixed(2)}s)</small></span></div>
    <div class="cs-row"><span class="cs-label">Labeler</span><span class="cs-value">${escapeHtml(shot.labeler || '—')}</span></div>
  `;
}

// ============================================================
// Reclassify — call backend, mark done, advance
// ============================================================
async function reclassify(newType) {
  const shot = state.shots[state.currentIdx];
  if (!shot) return;
  if (!shot.punch_uuid) {
    showToast('Shot has no punch_uuid — cannot reclassify. Re-run punch labeler to backfill.', 'error');
    return;
  }

  // Optimistic UI: mark done immediately, advance, fix up if save fails.
  const previousType = shot.punch;
  const previousStatus = shot.status;
  shot.newType = newType;
  shot.punch = newType;
  shot.status = 'done';
  renderShotList();
  renderCurrentShot();
  updateLoadStatus();
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
      renderShotList();
      renderCurrentShot();
      updateLoadStatus();
      return;
    }
    const labelerHits = (result.labeler_hits || []).length;
    const combinedHit = result.combined_hit ? 1 : 0;
    showToast(`Saved (${labelerHits} labeler row${labelerHits === 1 ? '' : 's'} + ${combinedHit} combined)`, 'info');
  } catch (e) {
    console.error('reclassify failed', e);
    showToast('Save failed: ' + e.message, 'error');
    shot.punch = previousType;
    shot.newType = null;
    shot.status = previousStatus;
    renderShotList();
    renderCurrentShot();
    updateLoadStatus();
  }
}

// ============================================================
// Loop toggle
// ============================================================
function toggleLoop() {
  state.loopEnabled = !state.loopEnabled;
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
      case 'Digit5': case 'Numpad5': e.preventDefault(); reclassify('jab_body'); break;
      case 'Digit6': case 'Numpad6': e.preventDefault(); reclassify('cross_body'); break;

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
// Timeline overlay — color the current shot's start→end window
// on the seek bar. Hook called by player.js on zoom/metadata change.
// ============================================================
function renderTimelineOverlay() {
  const overlay = document.getElementById('seek-bar-overlay');
  const video = document.getElementById('video-player');
  const duration = video.duration;
  overlay.innerHTML = '';
  if (!duration || duration <= 0) return;

  const shot = state.shots[state.currentIdx];
  if (!shot) return;
  const lPct = timeToViewportPct(shot.start_sec, duration);
  const rPct = timeToViewportPct(shot.end_sec, duration);
  if (rPct < 0 || lPct > 100) return;
  const seg = document.createElement('div');
  seg.className = 'seek-segment';
  seg.style.left = Math.max(0, lPct) + '%';
  seg.style.width = Math.max(Math.min(100, rPct) - Math.max(0, lPct), 0.15) + '%';
  seg.style.backgroundColor = '#ffaa33';
  overlay.appendChild(seg);
}

function updateVideoOverlay() {
  // Lightweight: just show the current punch label so the user can confirm
  // they're looking at the right shot.
  const overlay = document.getElementById('video-overlay');
  if (!overlay) return;
  const shot = state.shots[state.currentIdx];
  const key = shot ? (shot.punch || '') : '';
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
