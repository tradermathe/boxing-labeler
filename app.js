// ============================================================
// Config
// ============================================================
const PUNCH_TYPES = [
  { id: 'jab_head',              label: 'Jab (Head)',          key: '1' },
  { id: 'cross_head',            label: 'Cross (Head)',        key: '2' },
  { id: 'lead_hook_head',        label: 'Lead Hook',           key: '3' },
  { id: 'rear_hook_head',        label: 'Rear Hook',           key: '4' },
  { id: 'lead_uppercut_head',    label: 'Lead Uppercut',       key: '5' },
  { id: 'rear_uppercut_head',    label: 'Rear Uppercut',       key: '6' },
  { id: 'lead_bodyshot',         label: 'Lead Bodyshot',       key: '7' },
  { id: 'rear_bodyshot',         label: 'Rear Bodyshot',       key: '8' },
  { id: 'jab_body',              label: 'Jab (Body)',          key: '9' },
  { id: 'cross_body',            label: 'Cross (Body)',        key: '0' },
  { id: 'no_punch',              label: 'No Punch',            key: '' },
];

const FRAME_DURATION = 1 / 120;
const ACCEL_DELAY = 2000;       // ms before acceleration kicks in
const ACCEL_MULTIPLIER = 8;     // how much faster when accelerated

// ============================================================
// State
// ============================================================
const LABELER_ID = new URLSearchParams(window.location.search).get('labeler') || '';

let state = {
  selectedPunch: null,
  mode: 'start',
  pendingStart: null,
  labels: [],
  videoName: '',
  frameDuration: FRAME_DURATION,
  scriptUrl: 'https://script.google.com/macros/s/AKfycbwM57VoFCXWIhw8jyechZQLtMzlmeT15bhIy0eozKpA0jHlmuZPSqVzyEcS5Vy0A5cS/exec',
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
  updateTimestampButton();
  setupDriveLink();
  if (LABELER_ID) {
    const badge = document.getElementById('labeler-badge');
    badge.textContent = 'Labeler ' + LABELER_ID;
    badge.style.display = 'inline';
    document.title = 'Boxing Punch Labeler ' + LABELER_ID;
  }
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
  // scriptUrl is hardcoded in state; localStorage can override if set
  const url = localStorage.getItem('labeler_script_url');
  if (url) {
    state.scriptUrl = url;
  }
  document.getElementById('script-url').value = state.scriptUrl;
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
    const maxId = state.labels.reduce((max, l) => Math.max(max, l.id || 0), 0);
    const label = {
      id: maxId + 1,
      punch: state.selectedPunch,
      angle: document.getElementById('angle-select').value,
      start: state.pendingStart,
      end: time,
      videoName: document.getElementById('drive-link').value.trim() || state.videoName,
      timestamp: new Date().toISOString(),
    };

    state.labels.push(label);
    state.mode = 'start';
    state.pendingStart = null;
    document.getElementById('pending-label').textContent = '';
    updateTimestampButton();
    renderLabels();

    pushLabelToSheet(label).then(() => fetchLabelsFromSheet());
    showToast(`Labeled: ${PUNCH_TYPES.find(p => p.id === label.punch).label} (${formatTime(label.start)} - ${formatTime(label.end)})`, 'success');
  }
}

// ============================================================
// Google Apps Script Push (no auth needed)
// ============================================================
function sheetUrl(params) {
  const url = new URL(state.scriptUrl);
  if (LABELER_ID) url.searchParams.set('labeler', LABELER_ID);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function pushLabelToSheet(label) {
  if (!state.scriptUrl) return;
  const punch = PUNCH_TYPES.find(p => p.id === label.punch);
  try {
    const url = sheetUrl({
      action: 'add',
      videoName: label.videoName,
      trainingType: document.getElementById('training-type').value,
      stance: document.getElementById('stance-select').value,
      punchId: punch.id,
      angle: label.angle || 'Front',
      startTime: formatTimeSheet(label.start),
      endTime: formatTimeSheet(label.end),
    });
    const resp = await fetch(url);
    const result = await resp.json();
    showToast('Saved to Google Sheet', 'info');
  } catch (e) {
    console.error('Sheet push failed:', e);
    showToast('Sheet save failed: ' + e.message, 'error');
  }
}

// ============================================================
// Drive Link
// ============================================================
function setupDriveLink() {
  const input = document.getElementById('drive-link');
  const trainingType = document.getElementById('training-type');
  const stance = document.getElementById('stance-select');

  const prefix = LABELER_ID ? 'labeler_' + LABELER_ID + '_' : 'labeler_';
  const saved = localStorage.getItem(prefix + 'drive_link');
  if (saved) input.value = saved;

  // Restore training type and stance
  const savedType = localStorage.getItem(prefix + 'training_type');
  const savedStance = localStorage.getItem(prefix + 'stance');
  if (savedType) trainingType.value = savedType;
  if (savedStance) stance.value = savedStance;

  // Persist training type and stance on change
  trainingType.addEventListener('change', () => {
    localStorage.setItem(prefix + 'training_type', trainingType.value);
  });
  stance.addEventListener('change', () => {
    localStorage.setItem(prefix + 'stance', stance.value);
  });

  let debounceTimer;
  input.addEventListener('input', () => {
    localStorage.setItem(prefix + 'drive_link', input.value.trim());
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (input.value.trim()) {
        state.labels = state.labels.filter(l => !l.fromSheet);
        fetchLabelsFromSheet();
      }
    }, 500);
  });

  // Auto-fetch on load if link already set
  if (saved && saved.trim()) {
    fetchLabelsFromSheet();
  }
}

// ============================================================
// Fetch existing labels from Google Sheet
// ============================================================
async function fetchLabelsFromSheet() {
  const driveLink = document.getElementById('drive-link').value.trim();
  if (!state.scriptUrl || !driveLink) return;

  try {
    const url = sheetUrl({ action: 'list', video: driveLink });
    const response = await fetch(url);
    const result = await response.json();

    // Clear old local labels before loading from sheet
    state.labels = state.labels.filter(l => !l.fromSheet);

    if (result.labels && result.labels.length > 0) {
      // Convert sheet labels to local label format
      const sheetLabels = result.labels.map(l => ({
        id: l.id,
        punch: mapPunchType(l.punch),
        angle: l.angle || 'Front',
        start: typeof l.startTime === 'number' ? l.startTime : parseSheetTime(l.startTime),
        end: typeof l.endTime === 'number' ? l.endTime : parseSheetTime(l.endTime),
        videoName: l.videoName,
        fromSheet: true,
        sheetName: l.sheet,
      }));

      // Merge: keep local labels, add sheet labels that aren't duplicates
      for (const sl of sheetLabels) {
        const isDuplicate = state.labels.some(ll =>
          ll.punch === sl.punch &&
          Math.abs(ll.start - sl.start) < 0.01 &&
          Math.abs(ll.end - sl.end) < 0.01
        );
        if (!isDuplicate) {
          state.labels.push(sl);
        }
      }

      renderLabels();
      showToast(`Loaded ${result.labels.length} existing labels from sheet`, 'info');
    } else {
      showToast('No existing labels for this video', 'info');
    }
  } catch (e) {
    console.error('Failed to fetch labels:', e);
    showToast('Failed to load labels from sheet', 'error');
  }
}

// Map sheet punch types (e.g. lead_hook_head) to our IDs (e.g. lead_hook)
function mapPunchType(sheetPunch) {
  if (!sheetPunch) return 'jab_head';
  const p = String(sheetPunch).toLowerCase().trim();
  if (PUNCH_TYPES.find(t => t.id === p)) return p;
  return p;
}

function parseSheetTime(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (!timeStr) return 0;
  // Normalize comma decimals to dots (e.g. 0:0,63 → 0:0.63)
  let s = String(timeStr).replace(',', '.');
  const parts = s.split(':');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(s) || 0;
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
        <small style="color:#555">#${label.id || '?'}</small> <strong>${punch?.label || label.punch}</strong> <small style="color:#888">${label.angle || ''}</small><br>
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
  const angles = ['Front', 'Side', 'Back'];
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

  const label = state.labels[idx];
  label.punch = punch;
  label.angle = angle;
  label.start = start;
  label.end = end;

  renderLabels();
  showToast('Label updated, syncing...', 'success');
  updateLabelInSheet(label).then(() => {
    showToast(`Synced #${label.id} to sheet`, 'info');
  });
}

function deleteLabel(idx) {
  const label = state.labels[idx];
  state.labels.splice(idx, 1);
  renderLabels();
  deleteLabelFromSheet(label);
}

function undoLastLabel() {
  if (state.labels.length === 0) return;
  const label = state.labels.pop();
  renderLabels();
  deleteLabelFromSheet(label);
  showToast('Undid last label', 'info');
}

async function updateLabelInSheet(label) {
  if (!state.scriptUrl) { showToast('No script URL configured', 'error'); return; }
  if (!label.id) { showToast('Label has no ID, cannot update sheet', 'error'); return; }
  try {
    const url = sheetUrl({
      action: 'update',
      id: label.id,
      punchId: label.punch,
      angle: label.angle,
      startTime: formatTimeSheet(label.start),
      endTime: formatTimeSheet(label.end),
    });
    const resp = await fetch(url);
    const result = await resp.json();
    showToast(`Updated #${label.id} in sheet`, 'info');
  } catch (e) {
    console.error('Sheet update failed:', e);
    showToast('Sheet update failed: ' + e.message, 'error');
  }
}

async function deleteLabelFromSheet(label) {
  if (!state.scriptUrl || !label.id) return;
  try {
    const url = sheetUrl({ action: 'delete', id: label.id });
    const resp = await fetch(url);
    const result = await resp.json();
    showToast(`Deleted #${label.id} from sheet`, 'info');
  } catch (e) {
    console.error('Sheet delete failed:', e);
    showToast('Sheet delete failed', 'error');
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
let _arrowHoldStart = null;  // timestamp when arrow key was first pressed
let _arrowHeldKey = null;    // which arrow key is held

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
    // Blur focused buttons/selects so they don't consume keys
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') {
      e.target.blur();
    }

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;

      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        // Track hold start (ignore key repeat for initial timestamp)
        if (_arrowHeldKey !== e.code) {
          _arrowHeldKey = e.code;
          _arrowHoldStart = Date.now();
        }
        const held = Date.now() - _arrowHoldStart;
        const mult = held >= ACCEL_DELAY ? ACCEL_MULTIPLIER : 1;
        stepFrames(dir * mult * (e.shiftKey ? 2 : 1));
        break;
      }

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

      // Numpad keys (works regardless of NumLock)
      case 'Numpad1': selectPunch('jab_head'); break;
      case 'Numpad2': selectPunch('cross_head'); break;
      case 'Numpad3': selectPunch('lead_hook_head'); break;
      case 'Numpad4': selectPunch('rear_hook_head'); break;
      case 'Numpad5': selectPunch('lead_uppercut_head'); break;
      case 'Numpad6': selectPunch('rear_uppercut_head'); break;
      case 'Numpad7': selectPunch('lead_bodyshot'); break;
      case 'Numpad8': selectPunch('rear_bodyshot'); break;
      case 'Numpad9': selectPunch('jab_body'); break;
      case 'Numpad0': selectPunch('cross_body'); break;
      default:
        // Top row number keys via e.key
        switch (e.key) {
          case '1': selectPunch('jab_head'); break;
          case '2': selectPunch('cross_head'); break;
          case '3': selectPunch('lead_hook_head'); break;
          case '4': selectPunch('rear_hook_head'); break;
          case '5': selectPunch('lead_uppercut_head'); break;
          case '6': selectPunch('rear_uppercut_head'); break;
          case '7': selectPunch('lead_bodyshot'); break;
          case '8': selectPunch('rear_bodyshot'); break;
          case '9': selectPunch('jab_body'); break;
          case '0': selectPunch('cross_body'); break;
        }
        break;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      _arrowHeldKey = null;
      _arrowHoldStart = null;
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

function formatTimeSheet(seconds) {
  if (isNaN(seconds)) return '00:00,00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const whole = Math.floor(secs);
  const hundredths = Math.round((secs - whole) * 100);
  return `${String(mins).padStart(2,'0')}:${String(whole).padStart(2,'0')},${String(hundredths).padStart(2,'0')}`;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
