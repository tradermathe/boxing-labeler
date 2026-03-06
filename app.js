// ============================================================
// Config
// ============================================================
const PUNCH_TYPES = [
  { id: 'jab_head',         label: 'Jab (Head)',          key: '1' },
  { id: 'cross_head',       label: 'Cross (Head)',        key: '2' },
  { id: 'lead_hook',        label: 'Lead Hook',           key: '3' },
  { id: 'rear_hook',        label: 'Rear Hook',           key: '4' },
  { id: 'lead_uppercut',    label: 'Lead Uppercut',       key: '5' },
  { id: 'rear_uppercut',    label: 'Rear Uppercut',       key: '6' },
  { id: 'lead_bodyshot',    label: 'Lead Bodyshot',       key: '7' },
  { id: 'rear_bodyshot',    label: 'Rear Bodyshot',       key: '8' },
  { id: 'jab_body',         label: 'Jab (Body)',          key: '9' },
  { id: 'cross_body',       label: 'Cross (Body)',        key: '0' },
];

const FRAME_DURATION = 1 / 60;

// ============================================================
// State
// ============================================================
let state = {
  selectedPunch: null,
  mode: 'start',
  pendingStart: null,
  labels: [],
  videoName: '',
  frameDuration: FRAME_DURATION,
  scriptUrl: '',
};

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildPunchButtons();
  setupAngleSelect();
  setupVideoLoader();
  setupKeyboardShortcuts();
  setupSeekBar();
  loadConfig();
  loadLabelsFromStorage();
});

// ============================================================
// Config (Apps Script URL)
// ============================================================
function saveConfig() {
  state.scriptUrl = document.getElementById('script-url').value.trim();
  localStorage.setItem('labeler_script_url', state.scriptUrl);
  updateConnectionStatus();
  showToast('Config saved', 'success');
}

function loadConfig() {
  const url = localStorage.getItem('labeler_script_url');
  if (url) {
    state.scriptUrl = url;
    document.getElementById('script-url').value = url;
  }
  updateConnectionStatus();
}

function updateConnectionStatus() {
  const el = document.getElementById('connection-status');
  if (state.scriptUrl) {
    el.textContent = 'Connected';
    el.className = 'status-ok';
  } else {
    el.textContent = 'Not configured';
    el.className = 'status-off';
  }
}

function toggleConfig() {
  const panel = document.getElementById('config-panel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

// ============================================================
// Angle Select
// ============================================================
function setupAngleSelect() {
  const select = document.getElementById('angle-select');
  const saved = localStorage.getItem('labeler_angle');
  if (saved) select.value = saved;

  select.addEventListener('change', () => {
    localStorage.setItem('labeler_angle', select.value);
  });
}

// ============================================================
// Punch Buttons
// ============================================================
function buildPunchButtons() {
  const container = document.getElementById('punch-buttons');
  PUNCH_TYPES.forEach((punch) => {
    const btn = document.createElement('button');
    btn.className = 'punch-btn';
    btn.dataset.punchId = punch.id;
    btn.innerHTML = `${punch.label} <span class="shortcut">${punch.key}</span>`;
    btn.onclick = () => selectPunch(punch.id);
    container.appendChild(btn);
  });
}

function selectPunch(punchId) {
  state.selectedPunch = punchId;

  document.querySelectorAll('.punch-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.punchId === punchId);
  });

  const punch = PUNCH_TYPES.find(p => p.id === punchId);
  document.getElementById('selected-punch').textContent = punch.label;

  // If we were waiting for punch selection, move to end mode
  if (state.mode === 'punch') {
    state.mode = 'end';
    document.getElementById('pending-label').textContent =
      `Start: ${formatTime(state.pendingStart)} | ${punch.label} -- now set the END time`;
  }
  updateTimestampButton();
}

// ============================================================
// Timestamp / Labeling Workflow
// ============================================================
// Workflow: Start time → Select punch → End time
function updateTimestampButton() {
  const btn = document.getElementById('btn-timestamp');

  if (state.mode === 'start') {
    btn.textContent = '[ Set START time ]  (Enter)';
    btn.className = 'ready';
    btn.disabled = false;
    document.getElementById('selected-punch').textContent = 'Select after setting start';
  } else if (state.mode === 'punch') {
    btn.textContent = 'Select a punch type above';
    btn.className = '';
    btn.disabled = true;
  } else {
    // end mode — need punch selected
    if (!state.selectedPunch) {
      btn.textContent = 'Select a punch type first';
      btn.className = '';
      btn.disabled = true;
    } else {
      btn.textContent = '[ Set END time ]  (Enter)';
      btn.className = 'end-mode';
      btn.disabled = false;
    }
  }
}

function captureTimestamp() {
  const video = document.getElementById('video-player');
  const time = video.currentTime;

  if (state.mode === 'start') {
    state.pendingStart = time;
    state.mode = 'punch';
    state.selectedPunch = null;
    document.querySelectorAll('.punch-btn').forEach(btn => btn.classList.remove('selected'));
    document.getElementById('pending-label').textContent =
      `Start: ${formatTime(time)} -- now select the punch type`;
    updateTimestampButton();
  } else if (state.mode === 'end' && state.selectedPunch) {
    const label = {
      punch: state.selectedPunch,
      angle: document.getElementById('angle-select').value,
      start: state.pendingStart,
      end: time,
      videoName: state.videoName,
      timestamp: new Date().toISOString(),
    };

    state.labels.push(label);
    state.mode = 'start';
    state.pendingStart = null;
    document.getElementById('pending-label').textContent = '';
    updateTimestampButton();
    renderLabels();
    saveLabelsToStorage();
    pushLabelToSheet(label);
    showToast(`Labeled: ${PUNCH_TYPES.find(p => p.id === label.punch).label} (${formatTime(label.start)} - ${formatTime(label.end)})`, 'success');
  }
}

// ============================================================
// Google Apps Script Push (no auth needed)
// ============================================================
async function pushLabelToSheet(label) {
  if (!state.scriptUrl) return;

  const punch = PUNCH_TYPES.find(p => p.id === label.punch);
  const payload = {
    videoName: label.videoName,
    punchId: punch.id,
    punchLabel: punch.label,
    angle: label.angle || 'front',
    startTime: label.start.toFixed(3),
    endTime: label.end.toFixed(3),
    duration: (label.end - label.start).toFixed(3),
    timestamp: label.timestamp,
  };

  try {
    const response = await fetch(state.scriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });
    // no-cors means we can't read the response, but the request goes through
    showToast('Saved to Google Sheet', 'info');
  } catch (e) {
    console.error('Sheet push failed:', e);
    showToast('Sheet save failed: ' + e.message, 'error');
  }
}

// ============================================================
// Labels Rendering & Storage
// ============================================================
function renderLabels() {
  const log = document.getElementById('label-log');
  const count = document.getElementById('label-count');
  count.textContent = `(${state.labels.length})`;

  log.innerHTML = '';
  [...state.labels].reverse().forEach((label, reverseIdx) => {
    const idx = state.labels.length - 1 - reverseIdx;
    const punch = PUNCH_TYPES.find(p => p.id === label.punch);
    const entry = document.createElement('div');
    entry.className = 'label-entry';
    entry.innerHTML = `
      <span class="label-text">
        <strong>${punch?.label || label.punch}</strong> <small style="color:#888">${label.angle || ''}</small><br>
        ${formatTime(label.start)} &rarr; ${formatTime(label.end)}
      </span>
      <button class="label-delete" onclick="deleteLabel(${idx})" title="Delete">&times;</button>
    `;
    entry.querySelector('.label-text').style.cursor = 'pointer';
    entry.querySelector('.label-text').onclick = () => openEditLabel(idx);
    log.appendChild(entry);
  });
}

function openEditLabel(idx) {
  const label = state.labels[idx];
  const log = document.getElementById('label-log');

  // Find the entry element (labels are rendered in reverse)
  const reverseIdx = state.labels.length - 1 - idx;
  const entry = log.children[reverseIdx];
  if (!entry || entry.classList.contains('editing')) return;

  entry.classList.add('editing');

  // Build punch options
  const punchOpts = PUNCH_TYPES.map(p =>
    `<option value="${p.id}" ${p.id === label.punch ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  // Build angle options
  const angles = ['front', 'side', 'back'];
  const angleOpts = angles.map(a =>
    `<option value="${a}" ${a === (label.angle || 'front') ? 'selected' : ''}>${a}</option>`
  ).join('');

  entry.innerHTML = `
    <div class="edit-form">
      <div class="edit-row">
        <select class="edit-punch">${punchOpts}</select>
        <select class="edit-angle">${angleOpts}</select>
      </div>
      <div class="edit-row">
        <label>Start:</label>
        <input type="number" class="edit-start" value="${label.start.toFixed(3)}" step="0.001" min="0">
        <label>End:</label>
        <input type="number" class="edit-end" value="${label.end.toFixed(3)}" step="0.001" min="0">
      </div>
      <div class="edit-row edit-actions">
        <button class="edit-save" onclick="saveEditLabel(${idx})">Save</button>
        <button class="edit-cancel" onclick="renderLabels()">Cancel</button>
        <button class="edit-seek" onclick="document.getElementById('video-player').currentTime=${label.start}">Seek</button>
      </div>
    </div>
  `;
}

function saveEditLabel(idx) {
  const log = document.getElementById('label-log');
  const reverseIdx = state.labels.length - 1 - idx;
  const entry = log.children[reverseIdx];

  const punch = entry.querySelector('.edit-punch').value;
  const angle = entry.querySelector('.edit-angle').value;
  const start = parseFloat(entry.querySelector('.edit-start').value);
  const end = parseFloat(entry.querySelector('.edit-end').value);

  if (isNaN(start) || isNaN(end)) {
    showToast('Invalid time values', 'error');
    return;
  }

  state.labels[idx].punch = punch;
  state.labels[idx].angle = angle;
  state.labels[idx].start = start;
  state.labels[idx].end = end;

  renderLabels();
  saveLabelsToStorage();
  showToast('Label updated', 'success');
}

function deleteLabel(idx) {
  state.labels.splice(idx, 1);
  renderLabels();
  saveLabelsToStorage();
}

function undoLastLabel() {
  if (state.labels.length === 0) return;
  state.labels.pop();
  renderLabels();
  saveLabelsToStorage();
  showToast('Undid last label', 'info');
}

function saveLabelsToStorage() {
  localStorage.setItem('labeler_labels', JSON.stringify(state.labels));
}

function loadLabelsFromStorage() {
  const saved = localStorage.getItem('labeler_labels');
  if (saved) {
    try {
      state.labels = JSON.parse(saved);
      renderLabels();
    } catch (e) { /* ignore */ }
  }
}

// ============================================================
// Video Player
// ============================================================
function setupVideoLoader() {
  const input = document.getElementById('video-file');
  const video = document.getElementById('video-player');

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    state.videoName = file.name;
    document.getElementById('video-name').textContent = file.name;

    const url = URL.createObjectURL(file);
    video.src = url;
    video.load();

    const thumbVideo = document.getElementById('thumb-video');
    thumbVideo.src = url;
    thumbVideo.load();
  });

  video.addEventListener('loadedmetadata', () => {
    state.frameDuration = 1 / 30;
    updateTimeDisplay();
  });

  video.addEventListener('timeupdate', () => updateTimeDisplay());
  video.addEventListener('seeked', _onSeeked);
}

function updateTimeDisplay(overrideTime) {
  const video = document.getElementById('video-player');
  const display = document.getElementById('time-display');
  const seekBar = document.getElementById('seek-bar');
  const t = overrideTime !== undefined ? overrideTime : video.currentTime;

  display.textContent = `${formatTime(t)} / ${formatTime(video.duration || 0)}`;

  if (video.duration) {
    seekBar.value = (t / video.duration) * 1000;
  }
}

function setupSeekBar() {
  const seekBar = document.getElementById('seek-bar');
  const video = document.getElementById('video-player');

  seekBar.addEventListener('input', () => {
    if (video.duration) {
      video.currentTime = (seekBar.value / 1000) * video.duration;
    }
  });

  // Thumbnail preview on hover
  const wrapper = document.getElementById('seek-bar-wrapper');
  const thumb = document.getElementById('seek-thumbnail');
  const thumbVideo = document.getElementById('thumb-video');
  const thumbCanvas = document.getElementById('thumb-canvas');
  const thumbCtx = thumbCanvas.getContext('2d');
  const thumbTime = document.getElementById('thumb-time');

  let thumbReady = false;
  thumbVideo.addEventListener('seeked', () => {
    thumbCtx.drawImage(thumbVideo, 0, 0, thumbCanvas.width, thumbCanvas.height);
    thumbReady = true;
  });

  wrapper.addEventListener('mousemove', (e) => {
    if (!video.duration) return;

    const rect = seekBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const ratio = x / rect.width;
    const hoverTime = ratio * video.duration;

    // Position the thumbnail
    const thumbW = thumbCanvas.width + 4;
    let left = x - thumbW / 2;
    left = Math.max(0, Math.min(rect.width - thumbW, left));
    thumb.style.left = left + 'px';
    thumb.style.display = 'block';
    thumbTime.textContent = formatTime(hoverTime);

    // Seek the preview video
    if (thumbReady || !thumbVideo.seeking) {
      thumbReady = false;
      thumbVideo.currentTime = hoverTime;
    }
  });

  wrapper.addEventListener('mouseleave', () => {
    thumb.style.display = 'none';
  });
}

function togglePlay() {
  const video = document.getElementById('video-player');
  const btn = document.getElementById('btn-play');
  if (video.paused) {
    video.play();
    btn.textContent = 'Pause';
  } else {
    video.pause();
    btn.textContent = 'Play';
  }
}

let _targetTime = null;
let _seeking = false;

function stepFrames(n) {
  const video = document.getElementById('video-player');
  if (!video.paused) {
    video.pause();
    document.getElementById('btn-play').textContent = 'Play';
  }

  // Accumulate the target time from key repeats
  if (_targetTime === null) {
    _targetTime = video.currentTime;
  }
  _targetTime = Math.max(0, Math.min(video.duration || 0, _targetTime + n * state.frameDuration));
  updateTimeDisplay(_targetTime);

  // Only issue a seek if the video isn't already seeking
  if (!_seeking) {
    _seeking = true;
    video.currentTime = _targetTime;
  }
}

// When a seek completes, check if we need to seek again
function _onSeeked() {
  const video = document.getElementById('video-player');
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
  video.muted = !video.muted;
  btn.innerHTML = video.muted ? '&#128263;' : '&#128266;';
}

function setSpeed(rate) {
  const video = document.getElementById('video-player');
  video.playbackRate = rate;

  document.querySelectorAll('#speed-controls button').forEach(btn => {
    btn.classList.toggle('speed-active', btn.textContent === rate + 'x');
  });
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        stepFrames(e.shiftKey ? -2 : -1);
        break;

      case 'ArrowRight':
        e.preventDefault();
        stepFrames(e.shiftKey ? 2 : 1);
        break;

      case 'Enter':
        e.preventDefault();
        captureTimestamp();
        break;

      case 'KeyZ':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          undoLastLabel();
        } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          undoLastLabel();
        }
        break;

      case 'Digit1': selectPunch('jab_head'); break;
      case 'Digit2': selectPunch('cross_head'); break;
      case 'Digit3': selectPunch('lead_hook'); break;
      case 'Digit4': selectPunch('rear_hook'); break;
      case 'Digit5': selectPunch('lead_uppercut'); break;
      case 'Digit6': selectPunch('rear_uppercut'); break;
      case 'Digit7': selectPunch('lead_bodyshot'); break;
      case 'Digit8': selectPunch('rear_bodyshot'); break;
      case 'Digit9': selectPunch('jab_body'); break;
      case 'Digit0': selectPunch('cross_body'); break;
    }
  });
}

// ============================================================
// Helpers
// ============================================================
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00.000';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs.toFixed(3)}`;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
