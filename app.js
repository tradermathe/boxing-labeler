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

const FRAME_DURATION = 1 / 30; // assume 30fps, adjusted on metadata load

// Google API config - users must provide their own API key and client ID
// Create these at https://console.cloud.google.com/apis/credentials
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

// ============================================================
// State
// ============================================================
let state = {
  selectedPunch: null,
  mode: 'start',         // 'start' or 'end'
  pendingStart: null,     // timestamp of pending start
  labels: [],             // { punch, start, end, videoName }
  videoName: '',
  frameDuration: FRAME_DURATION,
  sheetId: '',
  sheetTab: 'Labels',
  accessToken: null,
  tokenClient: null,
};

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildPunchButtons();
  setupVideoLoader();
  setupKeyboardShortcuts();
  setupSeekBar();
  loadSheetConfig();
  loadLabelsFromStorage();
  initGoogleAuth();
});

// ============================================================
// Google Auth
// ============================================================
function initGoogleAuth() {
  // Load gapi client
  if (typeof gapi !== 'undefined') {
    gapi.load('client', async () => {
      await gapi.client.init({});
    });
  }

  // Check for saved credentials config
  const savedClientId = localStorage.getItem('labeler_client_id');
  if (!savedClientId) {
    addClientIdPrompt();
  } else {
    setupTokenClient(savedClientId);
  }
}

function addClientIdPrompt() {
  const bar = document.getElementById('auth-bar');
  const existing = document.getElementById('client-id-input');
  if (existing) return;

  const wrapper = document.createElement('span');
  wrapper.innerHTML = `
    <input type="text" id="client-id-input" placeholder="Google OAuth Client ID"
           style="width:320px;background:#1a1a2e;border:1px solid #0f3460;color:#e0e0e0;padding:4px 8px;border-radius:4px;font-size:12px;">
    <button onclick="saveClientId()" style="font-size:12px;padding:4px 8px;">Set</button>
  `;
  bar.insertBefore(wrapper, bar.firstChild);
}

function saveClientId() {
  const input = document.getElementById('client-id-input');
  const clientId = input.value.trim();
  if (!clientId) return;
  localStorage.setItem('labeler_client_id', clientId);
  input.parentElement.remove();
  setupTokenClient(clientId);
  showToast('Client ID saved', 'success');
}

function setupTokenClient(clientId) {
  if (typeof google === 'undefined' || !google.accounts) {
    // GIS library not loaded yet, retry
    setTimeout(() => setupTokenClient(clientId), 500);
    return;
  }

  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (response) => {
      if (response.error) {
        showToast('Auth failed: ' + response.error, 'error');
        return;
      }
      state.accessToken = response.access_token;
      document.getElementById('user-info').textContent = 'Signed in';
      document.getElementById('btn-signin').style.display = 'none';
      document.getElementById('btn-signout').style.display = '';
      showToast('Signed in to Google', 'success');
    },
  });
}

function handleSignIn() {
  if (!state.tokenClient) {
    showToast('Set your Google OAuth Client ID first', 'error');
    return;
  }
  state.tokenClient.requestAccessToken();
}

function handleSignOut() {
  if (state.accessToken) {
    google.accounts.oauth2.revoke(state.accessToken);
  }
  state.accessToken = null;
  document.getElementById('user-info').textContent = 'Not signed in';
  document.getElementById('btn-signin').style.display = '';
  document.getElementById('btn-signout').style.display = 'none';
  showToast('Signed out', 'info');
}

// ============================================================
// Sheet Config
// ============================================================
function saveSheetConfig() {
  state.sheetId = document.getElementById('sheet-id').value.trim();
  state.sheetTab = document.getElementById('sheet-tab').value.trim() || 'Labels';
  localStorage.setItem('labeler_sheet_id', state.sheetId);
  localStorage.setItem('labeler_sheet_tab', state.sheetTab);
  showToast('Sheet config saved', 'success');
}

function loadSheetConfig() {
  const id = localStorage.getItem('labeler_sheet_id');
  const tab = localStorage.getItem('labeler_sheet_tab');
  if (id) {
    state.sheetId = id;
    document.getElementById('sheet-id').value = id;
  }
  if (tab) {
    state.sheetTab = tab;
    document.getElementById('sheet-tab').value = tab;
  }
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

  // Update button states
  document.querySelectorAll('.punch-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.punchId === punchId);
  });

  // Update label panel
  const punch = PUNCH_TYPES.find(p => p.id === punchId);
  document.getElementById('selected-punch').textContent = punch.label;

  // Update timestamp button
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
      `Start: ${formatTime(time)} — now set the END time`;
    updateTimestampButton();
  } else {
    // Complete the label
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
// Google Sheets Push
// ============================================================
async function pushLabelToSheet(label) {
  if (!state.accessToken || !state.sheetId) return;

  const punch = PUNCH_TYPES.find(p => p.id === label.punch);
  const values = [[
    label.videoName,
    punch.id,
    punch.label,
    label.start.toFixed(3),
    label.end.toFixed(3),
    (label.end - label.start).toFixed(3),
    label.timestamp,
  ]];

  try {
    const range = `${state.sheetTab}!A:G`;
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${state.sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || response.statusText);
    }

    showToast('Saved to Google Sheet', 'info');
  } catch (e) {
    console.error('Sheet push failed:', e);
    showToast('Sheet save failed: ' + e.message, 'error');
  }
}

async function pushAllLabelsToSheet() {
  if (!state.accessToken || !state.sheetId || state.labels.length === 0) return;

  const values = state.labels.map(label => {
    const punch = PUNCH_TYPES.find(p => p.id === label.punch);
    return [
      label.videoName,
      punch.id,
      punch.label,
      label.start.toFixed(3),
      label.end.toFixed(3),
      (label.end - label.start).toFixed(3),
      label.timestamp,
    ];
  });

  try {
    const range = `${state.sheetTab}!A:G`;
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${state.sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${state.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || response.statusText);
    }

    showToast(`Pushed ${state.labels.length} labels to sheet`, 'success');
  } catch (e) {
    showToast('Batch push failed: ' + e.message, 'error');
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
  // Show most recent first
  [...state.labels].reverse().forEach((label, reverseIdx) => {
    const idx = state.labels.length - 1 - reverseIdx;
    const punch = PUNCH_TYPES.find(p => p.id === label.punch);
    const entry = document.createElement('div');
    entry.className = 'label-entry';
    entry.innerHTML = `
      <span class="label-text">
        <strong>${punch?.label || label.punch}</strong><br>
        ${formatTime(label.start)} → ${formatTime(label.end)}
      </span>
      <button class="label-delete" onclick="deleteLabel(${idx})" title="Delete">&times;</button>
    `;
    // Click to seek to the label start time
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
    // Try to detect frame rate from video, default to 30fps
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

function stepFrames(n) {
  const video = document.getElementById('video-player');
  video.pause();
  document.getElementById('btn-play').textContent = 'Play';
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + n * state.frameDuration));
  updateTimeDisplay();
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
    // Don't capture when typing in inputs
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

      // Number keys for punch selection
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
  if (isNaN(seconds)) return '0.000s';
  return seconds.toFixed(3) + 's';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
