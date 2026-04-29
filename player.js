// ============================================================
// player.js — Shared video + timeline core for boxing-labeler
//
// Provides: video load, seek bar, timeline minimap, zoom, playback
// controls, frame stepping, time ticks, sheet-URL helper, toasts,
// and URL/time formatters.
//
// Pages (app.js, rules.js) attach their own data-specific rendering
// via two optional hooks defined in the page's script scope:
//   function renderTimelineOverlay()  — called on zoom/metadata change
//   function updateVideoOverlay()     — called on time update
// Both are probed by `typeof` so pages without them still work.
//
// Shared state lives on `window.state`. Pages extend it via
// Object.assign — they must NOT redeclare `state` (that would shadow).
// ============================================================

const FRAME_DURATION_FALLBACK = 1 / 30;
const ACCEL_DELAY = 2000;     // ms before arrow-key frame stepping accelerates
const ACCEL_MULTIPLIER = 8;

// Shared state. Single source of truth for both pages.
const state = (window.state = window.state || {});
Object.assign(state, {
  frameDuration: FRAME_DURATION_FALLBACK,
  fpsDetected: false,
  scriptUrl: 'https://script.google.com/macros/s/AKfycbwM57VoFCXWIhw8jyechZQLtMzlmeT15bhIy0eozKpA0jHlmuZPSqVzyEcS5Vy0A5cS/exec',
  overlayVisible: true,
  zoomLevel: 1,
  zoomCenter: 0.5,
  videoName: '',
});

const LABELER_ID = new URLSearchParams(window.location.search).get('labeler') || '';

// ============================================================
// URL / time helpers
// ============================================================
function normalizeDriveUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  const ytMatch = s.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([\w-]+)/);
  if (ytMatch) return 'https://www.youtube.com/watch?v=' + ytMatch[1];
  return s.split('?')[0];
}

function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00.000';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs.toFixed(3)}`;
}

function parseTime(str) {
  str = str.trim();
  const parts = str.split(':');
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(str);
}

function formatTimeSheet(seconds) {
  if (isNaN(seconds)) return '00:00.000';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${secs < 10 ? '0' : ''}${secs.toFixed(3)}`;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ============================================================
// Apps Script URL builder — both pages hit the same backend
// ============================================================
function sheetUrl(params) {
  const url = new URL(state.scriptUrl);
  if (LABELER_ID) url.searchParams.set('labeler', LABELER_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ============================================================
// Viewport / zoom math
// ============================================================
function getViewport() {
  const halfSpan = 0.5 / state.zoomLevel;
  let start = state.zoomCenter - halfSpan;
  let end = state.zoomCenter + halfSpan;
  if (start < 0) { end -= start; start = 0; }
  if (end > 1) { start -= (end - 1); end = 1; }
  start = Math.max(0, start);
  end = Math.min(1, end);
  return { start, end };
}

function timeToViewportPct(time, duration) {
  const norm = time / duration;
  const vp = getViewport();
  return (norm - vp.start) / (vp.end - vp.start) * 100;
}

function viewportPctToTime(pct, duration) {
  const vp = getViewport();
  const norm = vp.start + (pct / 100) * (vp.end - vp.start);
  return norm * duration;
}

function clampZoomCenter() {
  const halfSpan = 0.5 / state.zoomLevel;
  state.zoomCenter = Math.max(halfSpan, Math.min(1 - halfSpan, state.zoomCenter));
}

function setZoom(newLevel, anchorNormalized) {
  const oldVp = getViewport();
  const oldSpan = oldVp.end - oldVp.start;
  const anchorFrac = oldSpan > 0 ? (anchorNormalized - oldVp.start) / oldSpan : 0.5;

  state.zoomLevel = Math.max(1, Math.min(32, newLevel));
  const newHalfSpan = 0.5 / state.zoomLevel;
  state.zoomCenter = anchorNormalized - (anchorFrac - 0.5) * 2 * newHalfSpan;
  clampZoomCenter();
}

// ============================================================
// Video loader + FPS detection
// ============================================================
function setupVideoLoader() {
  const input = document.getElementById('video-file');
  const video = document.getElementById('video-player');
  if (!input || !video) return;

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    state.videoName = file.name;
    const nameEl = document.getElementById('video-name');
    if (nameEl) nameEl.textContent = file.name;

    const url = URL.createObjectURL(file);
    video.src = url;
    video.load();

    const thumbVideo = document.getElementById('thumb-video');
    if (thumbVideo) {
      thumbVideo.src = url;
      thumbVideo.load();
    }
  });

  video.addEventListener('loadedmetadata', () => {
    state.frameDuration = FRAME_DURATION_FALLBACK;
    state.fpsDetected = false;
    detectFrameRate(video);
    updateTimeDisplay();
    if (state.playbackRate) video.playbackRate = state.playbackRate;
    if (typeof renderTimelineOverlay === 'function') renderTimelineOverlay();
  });

  video.addEventListener('timeupdate', () => updateTimeDisplay());
  video.addEventListener('seeked', _onSeeked);
}

function detectFrameRate(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;

  const frameTimes = [];
  const SAMPLES_NEEDED = 6;

  function onFrame(now, metadata) {
    frameTimes.push(metadata.mediaTime);
    if (frameTimes.length >= SAMPLES_NEEDED) {
      const intervals = [];
      for (let i = 1; i < frameTimes.length; i++) intervals.push(frameTimes[i] - frameTimes[i - 1]);
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      if (median > 0.001 && median < 0.5) {
        state.frameDuration = median;
        state.fpsDetected = true;
        showToast(`Detected ${Math.round(1 / median)} FPS`, 'info');
      }
      return;
    }
    video.requestVideoFrameCallback(onFrame);
  }
  video.requestVideoFrameCallback(onFrame);
}

// ============================================================
// Time display (seek bar + minimap playhead + auto-scroll)
// ============================================================
function updateTimeDisplay(overrideTime) {
  const video = document.getElementById('video-player');
  if (!video) return;
  const display = document.getElementById('time-display');
  const seekBar = document.getElementById('seek-bar');
  const t = overrideTime !== undefined ? overrideTime : video.currentTime;

  if (display) display.textContent = `${formatTime(t)} / ${formatTime(video.duration || 0)}`;

  if (video.duration) {
    const vp = getViewport();
    const norm = t / video.duration;
    const vpSpan = vp.end - vp.start;
    if (seekBar) seekBar.value = vpSpan > 0 ? ((norm - vp.start) / vpSpan) * 1000 : 0;

    if (!video.paused && (norm > vp.end || norm < vp.start) && state.zoomLevel > 1) {
      state.zoomCenter = norm;
      clampZoomCenter();
      onZoomChanged();
    }

    const playhead = document.getElementById('minimap-playhead');
    if (playhead) playhead.style.left = (norm * 100) + '%';
  }
  if (typeof updateVideoOverlay === 'function') updateVideoOverlay();
}

// ============================================================
// Seek bar (click-to-seek, thumbnail preview, alt-scroll zoom, scroll pan)
// ============================================================
function setupSeekBar() {
  const seekBar = document.getElementById('seek-bar');
  const video = document.getElementById('video-player');
  const wrapper = document.getElementById('seek-bar-wrapper');
  if (!seekBar || !video || !wrapper) return;

  seekBar.addEventListener('input', () => {
    if (video.duration) {
      const vp = getViewport();
      const norm = vp.start + (seekBar.value / 1000) * (vp.end - vp.start);
      video.currentTime = norm * video.duration;
    }
  });

  const thumb = document.getElementById('seek-thumbnail');
  const thumbVideo = document.getElementById('thumb-video');
  const thumbCanvas = document.getElementById('thumb-canvas');
  const thumbCtx = thumbCanvas ? thumbCanvas.getContext('2d') : null;
  const thumbTime = document.getElementById('thumb-time');

  let thumbReady = false;
  if (thumbVideo && thumbCtx && thumbCanvas) {
    thumbVideo.addEventListener('seeked', () => {
      thumbCtx.drawImage(thumbVideo, 0, 0, thumbCanvas.width, thumbCanvas.height);
      thumbReady = true;
    });
  }

  wrapper.addEventListener('click', (e) => {
    if (!video.duration) return;
    const rect = seekBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = (x / rect.width) * 100;
    const time = viewportPctToTime(pct, video.duration);
    video.currentTime = Math.max(0, Math.min(video.duration, time));
    seekBar.value = (x / rect.width) * 1000;
  });

  if (thumb && thumbVideo && thumbCanvas && thumbTime) {
    wrapper.addEventListener('mousemove', (e) => {
      if (!video.duration) return;
      const rect = seekBar.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const pct = (x / rect.width) * 100;
      const hoverTime = viewportPctToTime(pct, video.duration);

      const thumbW = thumbCanvas.width + 4;
      let left = x - thumbW / 2;
      left = Math.max(0, Math.min(rect.width - thumbW, left));
      thumb.style.left = left + 'px';
      thumb.style.display = 'block';
      thumbTime.textContent = formatTime(hoverTime);

      if (thumbReady || !thumbVideo.seeking) {
        thumbReady = false;
        thumbVideo.currentTime = hoverTime;
      }
    });
    wrapper.addEventListener('mouseleave', () => { thumb.style.display = 'none'; });
  }

  wrapper.addEventListener('wheel', (e) => {
    if (!video.duration) return;
    if (e.altKey) {
      e.preventDefault();
      const rect = seekBar.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const pct = x / rect.width;
      const vp = getViewport();
      const anchorNorm = vp.start + pct * (vp.end - vp.start);
      const factor = e.deltaY < 0 ? 1.4 : 1 / 1.4;
      setZoom(state.zoomLevel * factor, anchorNorm);
      onZoomChanged();
    } else if (state.zoomLevel > 1) {
      e.preventDefault();
      const panAmount = (e.deltaY > 0 ? 0.15 : -0.15) / state.zoomLevel;
      state.zoomCenter += panAmount;
      clampZoomCenter();
      onZoomChanged();
    }
  }, { passive: false });
}

// ============================================================
// Playback controls
// ============================================================
function togglePlay() {
  const video = document.getElementById('video-player');
  const btn = document.getElementById('btn-play');
  if (!video) return;
  if (video.paused) {
    video.play();
    if (btn) btn.textContent = 'Pause';
  } else {
    video.pause();
    if (btn) btn.textContent = 'Play';
  }
}

// Frame stepping accumulates target time across key repeats so fast
// Arrow-key presses don't lose frames to the seek debouncer.
let _targetTime = null;
let _seeking = false;

function stepFrames(n) {
  const video = document.getElementById('video-player');
  if (!video) return;
  if (!video.paused) {
    video.pause();
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = 'Play';
  }

  if (_targetTime === null) {
    _targetTime = Math.round(video.currentTime / state.frameDuration) * state.frameDuration;
  }
  _targetTime = Math.max(0, Math.min(video.duration || 0, _targetTime + n * state.frameDuration));
  updateTimeDisplay(_targetTime);

  if (!_seeking) {
    _seeking = true;
    video.currentTime = _targetTime;
  }
}

function _onSeeked() {
  const video = document.getElementById('video-player');
  if (!video) return;
  if (_targetTime !== null && Math.abs(video.currentTime - _targetTime) > 0.001) {
    video.currentTime = _targetTime;
  } else {
    _seeking = false;
    _targetTime = null;
  }
}

function toggleMute() {
  const video = document.getElementById('video-player');
  const btn = document.getElementById('btn-mute');
  if (!video) return;
  video.muted = !video.muted;
  if (btn) btn.innerHTML = video.muted ? '&#128263;' : '&#128266;';
}

function setSpeed(rate) {
  const video = document.getElementById('video-player');
  if (!video) return;
  video.playbackRate = rate;
  // Persist so loadedmetadata can re-apply after a src swap. Without this
  // the UI button stays highlighted but the browser resets playbackRate
  // to 1.0 on every new video load.
  state.playbackRate = rate;
  document.querySelectorAll('#speed-controls button').forEach(btn => {
    btn.classList.toggle('speed-active', btn.textContent === rate + 'x');
  });
}

// ============================================================
// Zoom controls
// ============================================================
function zoomIn()  { setZoom(state.zoomLevel * 2, state.zoomCenter); onZoomChanged(); }
function zoomOut() { setZoom(state.zoomLevel / 2, state.zoomCenter); onZoomChanged(); }
function zoomFit() { state.zoomLevel = 1; state.zoomCenter = 0.5; onZoomChanged(); }

function onZoomChanged() {
  const display = document.getElementById('zoom-level-display');
  if (display) display.textContent = state.zoomLevel >= 1.5 ? Math.round(state.zoomLevel) + 'x' : '1x';

  const minimap = document.getElementById('timeline-minimap');
  if (minimap) minimap.style.display = state.zoomLevel > 1.05 ? 'block' : 'none';

  if (typeof renderTimelineOverlay === 'function') renderTimelineOverlay();
  updateTimeDisplay();
}

// ============================================================
// Minimap chrome (viewport indicator + playhead)
// Pages draw colored segments into #minimap-segments separately.
// ============================================================
function updateMinimapChrome() {
  const video = document.getElementById('video-player');
  if (!video) return;
  const duration = video.duration;
  if (!duration || duration <= 0) return;

  const vpDiv = document.getElementById('minimap-viewport');
  if (vpDiv) {
    const vp = getViewport();
    vpDiv.style.left = (vp.start * 100) + '%';
    vpDiv.style.width = ((vp.end - vp.start) * 100) + '%';
  }

  const playhead = document.getElementById('minimap-playhead');
  if (playhead) playhead.style.left = (video.currentTime / duration * 100) + '%';
}

function setupMinimapInteraction() {
  const minimap = document.getElementById('timeline-minimap');
  const vpDiv = document.getElementById('minimap-viewport');
  const video = document.getElementById('video-player');
  if (!minimap || !vpDiv || !video) return;

  let dragging = false;
  let dragStartX = 0;
  let dragStartCenter = 0;

  minimap.addEventListener('mousedown', (e) => {
    if (!video.duration) return;
    if (e.target === vpDiv) {
      dragging = true;
      dragStartX = e.clientX;
      dragStartCenter = state.zoomCenter;
      e.preventDefault();
      return;
    }
    const rect = minimap.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    state.zoomCenter = x / rect.width;
    clampZoomCenter();
    onZoomChanged();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = minimap.getBoundingClientRect();
    const dx = (e.clientX - dragStartX) / rect.width;
    state.zoomCenter = dragStartCenter + dx;
    clampZoomCenter();
    onZoomChanged();
  });

  document.addEventListener('mouseup', () => { dragging = false; });
}

// ============================================================
// Time ticks (major/minor divisions on the timeline)
// ============================================================
function renderTimeTicks() {
  const ticksContainer = document.getElementById('timeline-ticks');
  const video = document.getElementById('video-player');
  if (!ticksContainer || !video) return;
  const duration = video.duration;
  ticksContainer.innerHTML = '';
  if (!duration || duration <= 0) return;

  const vp = getViewport();
  const vpDuration = (vp.end - vp.start) * duration;
  const intervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let majorInterval = 1;
  for (const iv of intervals) {
    const count = vpDuration / iv;
    if (count >= 4 && count <= 25) { majorInterval = iv; break; }
    if (count < 4) { majorInterval = iv; break; }
  }
  const minorInterval = majorInterval / 4;
  const startTime = Math.floor((vp.start * duration) / minorInterval) * minorInterval;
  const endTime = vp.end * duration;

  for (let t = startTime; t <= endTime; t += minorInterval) {
    if (t < 0) continue;
    const pct = timeToViewportPct(t, duration);
    if (pct < -1 || pct > 101) continue;
    const isMajor = Math.abs(t % majorInterval) < 0.001 || Math.abs(t % majorInterval - majorInterval) < 0.001;
    const tick = document.createElement('div');
    tick.className = isMajor ? 'timeline-tick major' : 'timeline-tick';
    tick.style.left = pct + '%';
    ticksContainer.appendChild(tick);
    if (isMajor) {
      const label = document.createElement('span');
      label.className = 'timeline-tick-label';
      label.style.left = pct + '%';
      label.textContent = formatTime(t);
      ticksContainer.appendChild(label);
    }
  }
}

// ============================================================
// Labels-overlay toggle (button in the controls row)
// ============================================================
function toggleOverlay() {
  state.overlayVisible = !state.overlayVisible;
  const btn = document.getElementById('btn-overlay');
  const app = document.getElementById('app');
  if (state.overlayVisible) {
    if (btn) { btn.textContent = 'Labels: ON'; btn.classList.remove('overlay-off'); }
    if (app) app.classList.remove('overlays-hidden');
  } else {
    if (btn) { btn.textContent = 'Labels: OFF'; btn.classList.add('overlay-off'); }
    if (app) app.classList.add('overlays-hidden');
  }
}

// ============================================================
// One-shot setup — pages call this on DOMContentLoaded.
// ============================================================
function setupPlayer() {
  setupVideoLoader();
  setupSeekBar();
  setupMinimapInteraction();
}
