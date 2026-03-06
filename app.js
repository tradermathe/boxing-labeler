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

const FRAME_DURATION = 1 / 30;

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
  updateTimestampButton();
}

// ============================================================
// Timestamp / Labeling Workflow
// ============================================================
function updateTimestampButton() {
  const btn = document.getElementById('btn-timestamp');

  if (!state.selectedPunch) {
    btn.textContent = 'Select a punch type first';
    btn.disabled = true;
    btn.className = '';
    return;
  }

  btn.disabled = false;

  if (state.mode === 'start') {
    btn.textContent = '[ Set START time ]  (Enter)';
    btn.className = 'ready';
  } else {
    btn.textContent = '[ Set END time ]  (Enter)';
    btn.className = 'end-mode';
  }
}

function captureTimestamp() {
  if (!state.selectedPunch) return;

  const video = document.getElementById('video-player');
  const time = video.currentTime;

  if (state.mode === 'start') {
    state.pendingStart = time;
    state.mode = 'end';
    document.getElementById('pending-label').textContent =
      `Start: ${formatTime(time)} -- now set the END time`;
    updateTimestampButton();
  } else {
    const label = {
      punch: state.selectedPunch,
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
        <strong>${punch?.label || label.punch}</strong><br>
        ${formatTime(label.start)} &rarr; ${formatTime(label.end)}
      </span>
      <button class="label-delete" onclick="deleteLabel(${idx})" title="Delete">&times;</button>
    `;
    entry.querySelector('.label-text').style.cursor = 'pointer';
    entry.querySelector('.label-text').onclick = () => {
      document.getElementById('video-player').currentTime = label.start;
    };
    log.appendChild(entry);
  });
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
  });

  video.addEventListener('loadedmetadata', () => {
    state.frameDuration = 1 / 30;
    updateTimeDisplay();
  });

  video.addEventListener('timeupdate', updateTimeDisplay);
}

function updateTimeDisplay() {
  const video = document.getElementById('video-player');
  const display = document.getElementById('time-display');
  const seekBar = document.getElementById('seek-bar');

  display.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;

  if (video.duration) {
    seekBar.value = (video.currentTime / video.duration) * 1000;
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

let _pendingSeek = null;
let _seekRafId = null;

function stepFrames(n) {
  const video = document.getElementById('video-player');
  if (!video.paused) {
    video.pause();
    document.getElementById('btn-play').textContent = 'Play';
  }

  // Accumulate steps and apply once per animation frame
  if (_pendingSeek === null) {
    _pendingSeek = video.currentTime;
  }
  _pendingSeek = Math.max(0, Math.min(video.duration, _pendingSeek + n * state.frameDuration));

  if (_seekRafId) cancelAnimationFrame(_seekRafId);
  _seekRafId = requestAnimationFrame(() => {
    video.currentTime = _pendingSeek;
    _pendingSeek = null;
    _seekRafId = null;
    updateTimeDisplay();
  });
}

function toggleMute() {
  const video = document.getElementById('video-player');
  const btn = document.getElementById('btn-mute');
  video.muted = !video.muted;
  btn.textContent = video.muted ? 'Unmute' : 'Mute';
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
