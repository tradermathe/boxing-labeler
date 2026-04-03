// ============================================================
// Config
// ============================================================
const PUNCH_TYPES = [
  { id: 'jab_head',              label: 'Jab (Head)',          key: '1', group: 'offense' },
  { id: 'cross_head',            label: 'Cross (Head)',        key: '2', group: 'offense' },
  { id: 'lead_hook_head',        label: 'Lead Hook',           key: '3', group: 'offense' },
  { id: 'rear_hook_head',        label: 'Rear Hook',           key: '4', group: 'offense' },
  { id: 'lead_uppercut_head',    label: 'Lead Uppercut',       key: '5', group: 'offense' },
  { id: 'rear_uppercut_head',    label: 'Rear Uppercut',       key: '6', group: 'offense' },
  { id: 'lead_bodyshot',         label: 'Lead Bodyshot',       key: '7', group: 'offense' },
  { id: 'rear_bodyshot',         label: 'Rear Bodyshot',       key: '8', group: 'offense' },
  { id: 'jab_body',              label: 'Jab (Body)',          key: '9', group: 'offense' },
  { id: 'cross_body',            label: 'Cross (Body)',        key: '0', group: 'offense' },
  { id: 'lead_slip',             label: 'Lead Slip',           key: 'q', group: 'defense' },
  { id: 'rear_slip',             label: 'Rear Slip',           key: 'w', group: 'defense' },
  { id: 'lead_roll',             label: 'Lead Roll',           key: 'a', group: 'defense' },
  { id: 'rear_roll',             label: 'Rear Roll',           key: 'd', group: 'defense' },
  { id: 'pull_back',             label: 'Pull Back',           key: 'r', group: 'defense' },
  { id: 'step_back',             label: 'Step Back',           key: 'f', group: 'defense' },
  { id: 'unsure',                label: 'Unsure',              key: 'u', group: 'other' },
];

const PUNCH_COLORS = {
  // Offense - each punch gets a distinct, vivid color
  jab_head:           '#ff2244',  // bright red
  cross_head:         '#ff8800',  // orange
  lead_hook_head:     '#ffdd00',  // yellow
  rear_hook_head:     '#ff00aa',  // hot pink
  lead_uppercut_head: '#cc44ff',  // purple
  rear_uppercut_head: '#33cccc',  // teal
  lead_bodyshot:      '#88dd00',  // lime green
  rear_bodyshot:      '#ffaa33',  // amber
  jab_body:           '#0088ff',  // sky blue
  cross_body:         '#ff6699',  // pink
  // Defense - cool/bright tones, clearly distinct from offense
  lead_slip:  '#00ff88',  // bright green
  rear_slip:  '#00ddff',  // cyan
  lead_roll:  '#3388ff',  // blue
  rear_roll:  '#00ffcc',  // turquoise
  pull_back:  '#aa66ff',  // lavender
  step_back:  '#ffff00',  // lime yellow
  // Other
  unsure:      '#999999',  // gray
  // Round markers
  round_start: '#28a745',
  round_end:   '#666666',
};

function getPunchColor(punchId) {
  return PUNCH_COLORS[punchId] || '#533483';
}

const FRAME_DURATION_FALLBACK = 1 / 30;
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
  frameDuration: FRAME_DURATION_FALLBACK,
  fpsDetected: false,
  scriptUrl: 'https://script.google.com/macros/s/AKfycbwM57VoFCXWIhw8jyechZQLtMzlmeT15bhIy0eozKpA0jHlmuZPSqVzyEcS5Vy0A5cS/exec',
  roundActive: false,
  overlayVisible: true,
  zoomLevel: 1,      // 1 = full view, up to 32x
  zoomCenter: 0.5,   // normalized 0-1, center of viewport
};

// ============================================================
// Timeline Zoom Utilities
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
  // Solve: anchorNormalized should stay at same visual fraction
  state.zoomCenter = anchorNormalized - (anchorFrac - 0.5) * 2 * newHalfSpan;
  clampZoomCenter();
}

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildPunchButtons();
  setupVideoLoader();
  setupKeyboardShortcuts();
  setupSeekBar();
  setupMinimapInteraction();
  loadConfig();
  updateTimestampButton();
  updateRoundIndicator();
  setupDriveLink();
  if (LABELER_ID) {
    const badge = document.getElementById('labeler-badge');
    badge.textContent = 'Labeler ' + LABELER_ID;
    badge.style.display = 'inline';
    document.title = 'Boxing Punch Labeler ' + LABELER_ID;
  }
});

// ============================================================
// Config (Apps Script URL is hardcoded)
// ============================================================
function loadConfig() {
  // scriptUrl is hardcoded in state default — nothing to configure
}


// ============================================================
// Punch Buttons
// ============================================================
function buildPunchButtons() {
  const container = document.getElementById('punch-buttons');
  let currentGroup = null;
  PUNCH_TYPES.forEach((punch) => {
    if (punch.group !== currentGroup) {
      currentGroup = punch.group;
      const header = document.createElement('div');
      header.className = 'punch-group-header';
      header.textContent = currentGroup === 'offense' ? 'Offense' : currentGroup === 'defense' ? 'Defense' : 'Other';
      container.appendChild(header);
    }
    const btn = document.createElement('button');
    btn.className = 'punch-btn';
    btn.dataset.punchId = punch.id;
    btn.style.borderLeftColor = getPunchColor(punch.id);
    btn.style.borderLeftWidth = '4px';
    btn.innerHTML = `${punch.label} <span class="shortcut">${punch.key.toUpperCase()}</span>`;
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
      angle: '',
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
      angle: label.angle || '',
      startTime: formatTimeSheet(label.start),
      endTime: formatTimeSheet(label.end),
    });
    const resp = await fetch(url);
    const result = await resp.json();
    if (result.status === 'error') {
      console.error('Sheet push error:', result.message);
      showToast('Sheet save failed: ' + result.message, 'error');
    } else {
      showToast('Saved to Google Sheet', 'info');
    }
  } catch (e) {
    console.error('Sheet push failed:', e);
    showToast('Sheet save failed: ' + e.message, 'error');
  }
}

function addRoundMarker(markerType) {
  const video = document.getElementById('video-player');
  const time = video.currentTime;
  const maxId = state.labels.reduce((max, l) => Math.max(max, l.id || 0), 0);
  const label = {
    id: maxId + 1,
    punch: markerType,
    start: time,
    end: time,
    videoName: document.getElementById('drive-link').value.trim() || state.videoName,
    isRoundMarker: true,
    timestamp: new Date().toISOString(),
  };
  state.labels.push(label);
  renderLabels();
  pushRoundMarkerToSheet(markerType);
}

async function pushRoundMarkerToSheet(markerType) {
  if (!state.scriptUrl) return;
  const video = document.getElementById('video-player');
  const time = formatTimeSheet(video.currentTime);
  try {
    const url = sheetUrl({
      action: 'add',
      videoName: document.getElementById('drive-link').value.trim() || state.videoName,
      trainingType: document.getElementById('training-type').value,
      stance: document.getElementById('stance-select').value,
      punchId: markerType,
      angle: '',
      startTime: time,
      endTime: time,
    });
    const resp = await fetch(url);
    const result = await resp.json();
    showToast(`${markerType} saved at ${formatTime(video.currentTime)}`, 'success');
  } catch (e) {
    console.error('Round marker push failed:', e);
    showToast('Round marker save failed: ' + e.message, 'error');
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
        state.labels = [];
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
  if (_pendingDeletes > 0) return; // don't re-fetch while deletes are in-flight
  const driveLink = document.getElementById('drive-link').value.trim();
  if (!state.scriptUrl || !driveLink) return;

  try {
    const url = sheetUrl({ action: 'list', video: driveLink });
    const response = await fetch(url);
    const result = await response.json();

    if (result.status === 'error') {
      console.error('Sheet fetch error:', result.message);
      showToast('Sheet error: ' + result.message, 'error');
      return;
    }

    // Clear old local labels before loading from sheet
    state.labels = state.labels.filter(l => !l.fromSheet);

    if (result.labels && result.labels.length > 0) {
      // Convert sheet labels to local label format
      const sheetLabels = result.labels.map(l => {
        const punch = mapPunchType(l.punch);
        const isRound = punch === 'round_start' || punch === 'round_end';
        return {
          id: l.id,
          punch: punch,
          angle: l.angle || '',
          start: typeof l.startTime === 'number' ? l.startTime : parseSheetTime(l.startTime),
          end: typeof l.endTime === 'number' ? l.endTime : parseSheetTime(l.endTime),
          videoName: l.videoName,
          fromSheet: true,
          sheetName: l.sheet,
          isRoundMarker: isRound,
        };
      });

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

      syncRoundActiveFromLabels();
      renderLabels();
      showToast(`Loaded ${result.labels.length} existing labels from sheet`, 'info');
    } else {
      syncRoundActiveFromLabels();
      showToast('No existing labels for this video', 'info');
      renderLabels();
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
  // Round markers (not in PUNCH_TYPES but valid)
  if (p === 'round_start' || p === 'round start') return 'round_start';
  if (p === 'round_end' || p === 'round end') return 'round_end';
  // Direct match on ID (e.g. "jab_head")
  if (PUNCH_TYPES.find(t => t.id === p)) return p;
  // Match on display label (e.g. "Jab (Head)", "Lead Hook", etc.)
  const byLabel = PUNCH_TYPES.find(t => t.label.toLowerCase() === p);
  if (byLabel) return byLabel.id;
  // Partial / fuzzy matching for common sheet formats
  const MAP = {
    'jab': 'jab_head', 'jab head': 'jab_head', 'jab (head)': 'jab_head',
    'jab body': 'jab_body', 'jab (body)': 'jab_body',
    'cross': 'cross_head', 'cross head': 'cross_head', 'cross (head)': 'cross_head',
    'cross body': 'cross_body', 'cross (body)': 'cross_body',
    'lead hook': 'lead_hook_head', 'lead hook head': 'lead_hook_head', 'lead hook (head)': 'lead_hook_head',
    'rear hook': 'rear_hook_head', 'rear hook head': 'rear_hook_head', 'rear hook (head)': 'rear_hook_head',
    'lead uppercut': 'lead_uppercut_head', 'lead uppercut head': 'lead_uppercut_head',
    'rear uppercut': 'rear_uppercut_head', 'rear uppercut head': 'rear_uppercut_head',
    'lead bodyshot': 'lead_bodyshot', 'rear bodyshot': 'rear_bodyshot',
    'lead slip': 'lead_slip', 'rear slip': 'rear_slip',
    'lead roll': 'lead_roll', 'rear roll': 'rear_roll',
    'pull back': 'pull_back', 'pullback': 'pull_back',
    'step back': 'step_back', 'stepback': 'step_back',
    'round start': 'round_start', 'round end': 'round_end',
    'unsure': 'unsure', '?': 'unsure',
  };
  if (MAP[p]) return MAP[p];
  // Try replacing spaces with underscores
  const underscored = p.replace(/\s+/g, '_');
  if (PUNCH_TYPES.find(t => t.id === underscored)) return underscored;
  console.warn('Unknown punch type from sheet:', sheetPunch, '→ defaulting to jab_head');
  return 'jab_head';
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
  const punchCount = state.labels.filter(l => !l.isRoundMarker).length;
  count.textContent = `(${punchCount})`;

  // Capture open editors before wiping the list
  const openEditors = {};
  log.querySelectorAll('.label-entry.editing').forEach(entry => {
    const idx = parseInt(entry.dataset.labelIdx);
    const label = state.labels[idx];
    if (!label) return;
    const key = label.id || ('idx_' + idx);
    if (label.isRoundMarker) {
      const startInput = entry.querySelector('.edit-start');
      openEditors[key] = { isRoundMarker: true, start: startInput ? startInput.value : null };
    } else {
      const punchSel = entry.querySelector('.edit-punch');
      const startInput = entry.querySelector('.edit-start');
      const endInput = entry.querySelector('.edit-end');
      openEditors[key] = {
        isRoundMarker: false,
        punch: punchSel ? punchSel.value : null,
        start: startInput ? startInput.value : null,
        end: endInput ? endInput.value : null,
      };
    }
  });

  log.innerHTML = '';
  // Sort by start time descending (latest clip on top)
  const sorted = state.labels.map((label, idx) => ({ label, idx }));
  sorted.sort((a, b) => b.label.start - a.label.start);
  sorted.forEach(({ label, idx }) => {
    const entry = document.createElement('div');

    if (label.isRoundMarker) {
      entry.className = 'label-entry round-marker';
      const icon = label.punch === 'round_start' ? '\u25B6' : '\u25A0';
      const text = label.punch === 'round_start' ? 'Round Start' : 'Round End';
      entry.innerHTML = `
        <span class="label-text">
          <small style="color:#555">#${label.id || '?'}</small> ${icon} <span style="color:#888">${text}</span>
          <small style="color:#666">${formatTime(label.start)}</small>
        </span>
        <button class="label-delete" onclick="event.stopPropagation(); deleteLabel(${idx})" title="Delete">&times;</button>
      `;
      entry.querySelector('.label-text').style.cursor = 'pointer';
      entry.querySelector('.label-text').onclick = () => openEditRoundMarker(idx);
    } else {
      const punch = PUNCH_TYPES.find(p => p.id === label.punch);
      entry.className = 'label-entry';
      entry.style.borderLeftColor = getPunchColor(label.punch);
      entry.innerHTML = `
        <span class="label-text">
          <small style="color:#555">#${label.id || '?'}</small> <strong>${punch?.label || label.punch}</strong><br>
          ${formatTime(label.start)} &rarr; ${formatTime(label.end)}
        </span>
        <button class="label-delete" onclick="event.stopPropagation(); deleteLabel(${idx})" title="Delete">&times;</button>
      `;
      entry.querySelector('.label-text').style.cursor = 'pointer';
      entry.querySelector('.label-text').onclick = () => openEditLabel(idx);
    }

    entry.dataset.labelIdx = idx;
    log.appendChild(entry);
  });

  // Restore open editors with their unsaved form values
  sorted.forEach(({ label, idx }) => {
    const key = label.id || ('idx_' + idx);
    const saved = openEditors[key];
    if (!saved) return;
    if (saved.isRoundMarker) {
      openEditRoundMarker(idx);
      const entry = log.querySelector(`[data-label-idx="${idx}"]`);
      if (entry && saved.start !== null) {
        entry.querySelector('.edit-start').value = saved.start;
      }
    } else {
      openEditLabel(idx);
      const entry = log.querySelector(`[data-label-idx="${idx}"]`);
      if (entry) {
        if (saved.punch !== null) entry.querySelector('.edit-punch').value = saved.punch;
        if (saved.start !== null) entry.querySelector('.edit-start').value = saved.start;
        if (saved.end !== null) entry.querySelector('.edit-end').value = saved.end;
      }
    }
  });

  renderTimelineOverlay();
}

function openEditLabel(idx) {
  const label = state.labels[idx];
  const log = document.getElementById('label-log');

  const entry = log.querySelector(`[data-label-idx="${idx}"]`);
  if (!entry || entry.classList.contains('editing')) return;

  entry.classList.add('editing');

  // Build punch options
  const punchOpts = PUNCH_TYPES.map(p =>
    `<option value="${p.id}" ${p.id === label.punch ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  entry.innerHTML = `
    <div class="edit-form">
      <button class="label-delete" onclick="event.stopPropagation(); deleteLabel(${idx})" title="Delete">&times;</button>
      <div class="edit-row">
        <select class="edit-punch">${punchOpts}</select>
      </div>
      <div class="edit-row">
        <input type="text" class="edit-start" value="${formatTime(label.start)}" title="Start">
        <span style="color:#666">&rarr;</span>
        <input type="text" class="edit-end" value="${formatTime(label.end)}" title="End">
      </div>
      <div class="edit-row">
        <button class="edit-save" onclick="saveEditLabel(${idx})">Save</button>
        <button class="edit-cancel" onclick="cancelEdit(${idx})">Cancel</button>
        <button class="edit-seek" onclick="document.getElementById('video-player').currentTime=${label.start}">Seek</button>
      </div>
    </div>
  `;
}

function openEditRoundMarker(idx) {
  const label = state.labels[idx];
  const log = document.getElementById('label-log');

  const entry = log.querySelector(`[data-label-idx="${idx}"]`);
  if (!entry || entry.classList.contains('editing')) return;

  entry.classList.add('editing');

  const text = label.punch === 'round_start' ? 'Round Start' : 'Round End';

  entry.innerHTML = `
    <div class="edit-form">
      <button class="label-delete" onclick="event.stopPropagation(); deleteLabel(${idx})" title="Delete">&times;</button>
      <div class="edit-row">
        <strong style="color:#888">${text}</strong>
      </div>
      <div class="edit-row">
        <label>Time:</label>
        <input type="text" class="edit-start" value="${formatTime(label.start)}">
      </div>
      <div class="edit-row">
        <button class="edit-save" onclick="saveEditRoundMarker(${idx})">Save</button>
        <button class="edit-cancel" onclick="cancelEdit(${idx})">Cancel</button>
        <button class="edit-seek" onclick="document.getElementById('video-player').currentTime=${label.start}">Seek</button>
      </div>
    </div>
  `;
}

function saveEditRoundMarker(idx) {
  const log = document.getElementById('label-log');
  const entry = log.querySelector(`[data-label-idx="${idx}"]`);

  const start = parseTime(entry.querySelector('.edit-start').value);

  if (isNaN(start)) {
    showToast('Invalid time value', 'error');
    return;
  }

  const label = state.labels[idx];
  label.start = start;

  entry.classList.remove('editing');
  renderLabels();
  showToast('Round marker updated, syncing...', 'success');
  updateLabelInSheet(label).then(() => {
    showToast(`Synced #${label.id} to sheet`, 'info');
  });
}

function saveEditLabel(idx) {
  const log = document.getElementById('label-log');
  const entry = log.querySelector(`[data-label-idx="${idx}"]`);

  const punch = entry.querySelector('.edit-punch').value;
  const start = parseTime(entry.querySelector('.edit-start').value);
  const end = parseTime(entry.querySelector('.edit-end').value);

  if (isNaN(start) || isNaN(end)) {
    showToast('Invalid time values', 'error');
    return;
  }

  const label = state.labels[idx];
  label.punch = punch;
  label.start = start;
  label.end = end;

  entry.classList.remove('editing');
  renderLabels();
  showToast('Label updated, syncing...', 'success');
  updateLabelInSheet(label).then(() => {
    showToast(`Synced #${label.id} to sheet`, 'info');
  });
}

function cancelEdit(idx) {
  const entry = document.querySelector(`#label-log [data-label-idx="${idx}"]`);
  if (entry) entry.classList.remove('editing');
  renderLabels();
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
      video: label.videoName,
      punchId: label.punch,
      angle: label.angle,
      startTime: formatTimeSheet(label.start),
      endTime: formatTimeSheet(label.end),
    });
    const resp = await fetch(url);
    const result = await resp.json();
    console.log('Update response:', result);
    if (result.status === 'error') {
      showToast('Update failed: ' + result.message, 'error');
      return;
    }
    showToast(`Updated #${label.id} → sheet="${result.sheet}" row=${result.row} fields=[${result.updated}]`, 'info');
  } catch (e) {
    console.error('Sheet update failed:', e);
    showToast('Sheet update failed: ' + e.message, 'error');
  }
}

let _pendingDeletes = 0;

async function deleteLabelFromSheet(label) {
  if (!state.scriptUrl) { showToast('No script URL configured', 'error'); return; }
  if (!label.id) { showToast('Label has no ID, cannot delete from sheet', 'error'); return; }
  _pendingDeletes++;
  try {
    const url = sheetUrl({ action: 'delete', id: label.id, video: label.videoName });
    console.log('Delete request:', url);
    const resp = await fetch(url);
    const text = await resp.text();
    console.log('Delete response:', text);
    const result = JSON.parse(text);
    if (result.status === 'error') {
      showToast('Delete failed: ' + result.message, 'error');
      return;
    }
    showToast(`Deleted #${label.id} from sheet`, 'info');
  } catch (e) {
    console.error('Sheet delete failed:', e);
    showToast('Sheet delete failed: ' + e.message, 'error');
  } finally {
    _pendingDeletes--;
    // Re-fetch after delete completes so local state matches the sheet
    if (_pendingDeletes === 0) fetchLabelsFromSheet();
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
    state.frameDuration = FRAME_DURATION_FALLBACK;
    state.fpsDetected = false;
    detectFrameRate(video);
    updateTimeDisplay();
    renderTimelineOverlay();
  });

  video.addEventListener('timeupdate', () => updateTimeDisplay());
  video.addEventListener('seeked', _onSeeked);
}

function detectFrameRate(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    console.warn('requestVideoFrameCallback not supported, using fallback FPS:', Math.round(1 / FRAME_DURATION_FALLBACK));
    return;
  }

  const frameTimes = [];
  const SAMPLES_NEEDED = 6;

  function onFrame(now, metadata) {
    frameTimes.push(metadata.mediaTime);

    if (frameTimes.length >= SAMPLES_NEEDED) {
      const intervals = [];
      for (let i = 1; i < frameTimes.length; i++) {
        intervals.push(frameTimes[i] - frameTimes[i - 1]);
      }
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];

      if (median > 0.001 && median < 0.5) {
        state.frameDuration = median;
        state.fpsDetected = true;
        const fps = Math.round(1 / median);
        console.log(`Detected video FPS: ${fps} (frame duration: ${median.toFixed(5)}s)`);
        showToast(`Detected ${fps} FPS`, 'info');
      }
      return;
    }

    video.requestVideoFrameCallback(onFrame);
  }

  video.requestVideoFrameCallback(onFrame);
}

function updateTimeDisplay(overrideTime) {
  const video = document.getElementById('video-player');
  const display = document.getElementById('time-display');
  const seekBar = document.getElementById('seek-bar');
  const t = overrideTime !== undefined ? overrideTime : video.currentTime;

  display.textContent = `${formatTime(t)} / ${formatTime(video.duration || 0)}`;

  if (video.duration) {
    const vp = getViewport();
    const norm = t / video.duration;
    // Map playhead to 0-1000 within the viewport
    const vpSpan = vp.end - vp.start;
    seekBar.value = vpSpan > 0 ? ((norm - vp.start) / vpSpan) * 1000 : 0;

    // Auto-scroll during playback when playhead exits viewport
    if (!video.paused && (norm > vp.end || norm < vp.start) && state.zoomLevel > 1) {
      state.zoomCenter = norm;
      clampZoomCenter();
      onZoomChanged();
    }

    // Update minimap playhead
    const playhead = document.getElementById('minimap-playhead');
    if (playhead) playhead.style.left = (norm * 100) + '%';
  }
  updateVideoOverlay();
}

function setupSeekBar() {
  const seekBar = document.getElementById('seek-bar');
  const video = document.getElementById('video-player');

  seekBar.addEventListener('input', () => {
    if (video.duration) {
      const vp = getViewport();
      const norm = vp.start + (seekBar.value / 1000) * (vp.end - vp.start);
      video.currentTime = norm * video.duration;
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

  wrapper.addEventListener('click', (e) => {
    if (!video.duration) return;
    const rect = seekBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = (x / rect.width) * 100;
    const time = viewportPctToTime(pct, video.duration);
    video.currentTime = Math.max(0, Math.min(video.duration, time));
    seekBar.value = (x / rect.width) * 1000;
  });

  wrapper.addEventListener('mousemove', (e) => {
    if (!video.duration) return;

    const rect = seekBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = (x / rect.width) * 100;
    const hoverTime = viewportPctToTime(pct, video.duration);

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

  // Mouse wheel: Alt+scroll = zoom, scroll when zoomed = pan
  wrapper.addEventListener('wheel', (e) => {
    if (!video.duration) return;

    if (e.altKey) {
      // Zoom at cursor
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
      // Pan when zoomed
      e.preventDefault();
      const panAmount = (e.deltaY > 0 ? 0.15 : -0.15) / state.zoomLevel;
      state.zoomCenter += panAmount;
      clampZoomCenter();
      onZoomChanged();
    }
  }, { passive: false });
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
    // Snap to nearest frame boundary so all users land on the same grid
    _targetTime = Math.round(video.currentTime / state.frameDuration) * state.frameDuration;
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
      case 'Escape':
        if (state.mode === 'punch' || state.mode === 'end') {
          e.preventDefault();
          state.mode = 'start';
          state.pendingStart = null;
          state.selectedPunch = null;
          document.querySelectorAll('.punch-btn').forEach(btn => btn.classList.remove('selected'));
          document.getElementById('pending-label').textContent = '';
          updateTimestampButton();
          showToast('Punch cancelled', 'info');
        }
        break;

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

      case 'KeyS':
        e.preventDefault();
        if (state.roundActive) {
          showToast('Round already active — press E to end it first', 'error');
        } else {
          state.roundActive = true;
          localStorage.setItem('roundActive', 'true');
          updateRoundIndicator();
          addRoundMarker('round_start');
        }
        break;

      case 'KeyE':
        e.preventDefault();
        if (!state.roundActive) {
          showToast('No round in progress — press S to start one', 'error');
        } else {
          state.roundActive = false;
          localStorage.setItem('roundActive', 'false');
          updateRoundIndicator();
          addRoundMarker('round_end');
        }
        break;

      case 'KeyL':
        e.preventDefault();
        toggleOverlay();
        break;

      case 'Equal':
      case 'NumpadAdd':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomIn(); }
        break;
      case 'Minus':
      case 'NumpadSubtract':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomOut(); }
        break;
      case 'Digit0':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomFit(); }
        else { selectPunch('cross_body'); }
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

      // Defense keys
      case 'KeyQ': selectPunch('lead_slip'); break;
      case 'KeyW': selectPunch('rear_slip'); break;
      case 'KeyA': selectPunch('lead_roll'); break;
      case 'KeyD': selectPunch('rear_roll'); break;
      case 'KeyR': selectPunch('pull_back'); break;
      case 'KeyF': selectPunch('step_back'); break;

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

function parseTime(str) {
  str = str.trim();
  const parts = str.split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(str);
}

function formatTimeSheet(seconds) {
  if (isNaN(seconds)) return '00:00.000';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2,'0')}:${secs < 10 ? '0' : ''}${secs.toFixed(3)}`;
}

function syncRoundActiveFromLabels() {
  const starts = state.labels.filter(l => l.punch === 'round_start').map(l => l.start).sort((a, b) => a - b);
  const ends = state.labels.filter(l => l.punch === 'round_end').map(l => l.start).sort((a, b) => a - b);
  // A round is active if there's a round_start with no subsequent round_end
  let active = false;
  for (const s of starts) {
    if (!ends.some(e => e > s)) { active = true; break; }
  }
  state.roundActive = active;
  localStorage.setItem('roundActive', String(active));
  updateRoundIndicator();
}

function updateRoundIndicator() {
  const indicator = document.getElementById('round-indicator');
  if (!indicator) return;
  if (state.roundActive) {
    indicator.textContent = '\u25B6 Round Active — press E to end';
    indicator.className = 'round-active';
    indicator.onclick = () => {
      state.roundActive = false;
      updateRoundIndicator();
      addRoundMarker('round_end');
    };
  } else {
    indicator.textContent = 'Press S to start round';
    indicator.className = 'round-idle';
    indicator.onclick = () => {
      state.roundActive = true;
      updateRoundIndicator();
      addRoundMarker('round_start');
    };
  }
}

// ============================================================
// Overlay Rendering
// ============================================================
function renderTimelineOverlay() {
  const overlay = document.getElementById('seek-bar-overlay');
  const video = document.getElementById('video-player');
  const duration = video.duration;
  overlay.innerHTML = '';
  if (!duration || duration <= 0) return;

  // Build round intervals from round_start/round_end markers
  const roundStarts = state.labels
    .filter(l => l.punch === 'round_start' || (l.isRoundMarker && l.punch?.includes?.('start')))
    .map(l => l.start)
    .sort((a, b) => a - b);
  const roundEnds = state.labels
    .filter(l => l.punch === 'round_end' || (l.isRoundMarker && l.punch?.includes?.('end')))
    .map(l => l.start)
    .sort((a, b) => a - b);

  // Pair starts with ends to get round intervals
  const rounds = [];
  for (let i = 0; i < roundStarts.length; i++) {
    const rStart = roundStarts[i];
    // Find the first end that comes after this start
    const rEnd = roundEnds.find(e => e > rStart);
    rounds.push({ start: rStart, end: rEnd !== undefined ? rEnd : duration });
  }

  // Shade areas outside rounds (only if there are rounds)
  if (rounds.length > 0) {
    let pos = 0;
    for (const r of rounds) {
      if (r.start > pos) {
        const lPct = timeToViewportPct(pos, duration);
        const rPct = timeToViewportPct(r.start, duration);
        if (rPct > 0 && lPct < 100) {
          const seg = document.createElement('div');
          seg.className = 'seek-segment outside-round';
          seg.style.left = Math.max(0, lPct) + '%';
          seg.style.width = (Math.min(100, rPct) - Math.max(0, lPct)) + '%';
          overlay.appendChild(seg);
        }
      }
      pos = r.end;
    }
    // After last round
    if (pos < duration) {
      const lPct = timeToViewportPct(pos, duration);
      const rPct = timeToViewportPct(duration, duration);
      if (rPct > 0 && lPct < 100) {
        const seg = document.createElement('div');
        seg.className = 'seek-segment outside-round';
        seg.style.left = Math.max(0, lPct) + '%';
        seg.style.width = (Math.min(100, rPct) - Math.max(0, lPct)) + '%';
        overlay.appendChild(seg);
      }
    }
  }

  // Punch segments on top
  for (const label of state.labels) {
    if (label.isRoundMarker) continue;
    const lPct = timeToViewportPct(label.start, duration);
    const rPct = timeToViewportPct(label.end, duration);
    if (rPct < 0 || lPct > 100) continue; // off-screen
    const seg = document.createElement('div');
    seg.className = 'seek-segment';
    seg.style.left = Math.max(0, lPct) + '%';
    seg.style.width = Math.max(Math.min(100, rPct) - Math.max(0, lPct), 0.15) + '%';
    seg.style.backgroundColor = getPunchColor(label.punch);
    overlay.appendChild(seg);
  }

  // Also update minimap and ticks
  renderMinimap();
  renderTimeTicks();
}

function updateVideoOverlay() {
  const overlay = document.getElementById('video-overlay');
  const video = document.getElementById('video-player');
  const t = video.currentTime;

  // Determine current round
  const roundStarts = state.labels
    .filter(l => l.punch === 'round_start' || (l.isRoundMarker && l.punch?.includes?.('start')))
    .map(l => l.start)
    .sort((a, b) => a - b);
  const roundEnds = state.labels
    .filter(l => l.punch === 'round_end' || (l.isRoundMarker && l.punch?.includes?.('end')))
    .map(l => l.start)
    .sort((a, b) => a - b);

  // Build round intervals
  const rounds = [];
  for (let i = 0; i < roundStarts.length; i++) {
    const rStart = roundStarts[i];
    const rEnd = roundEnds.find(e => e > rStart);
    rounds.push({ start: rStart, end: rEnd });
  }

  let currentRound = null;
  let insideRound = false;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (t >= r.start && (r.end === undefined || t <= r.end)) {
      currentRound = i + 1;
      insideRound = true;
      break;
    }
  }

  const activeLabels = state.labels.filter(l =>
    !l.isRoundMarker && t >= l.start && t <= l.end
  );

  const roundKey = currentRound ? 'R' + currentRound : 'out';
  const key = roundKey + '|' + activeLabels.map(l => l.id).join(',');
  if (overlay.dataset.activeKey === key) return;
  overlay.dataset.activeKey = key;

  overlay.innerHTML = '';

  // Dim overlay when outside round
  const dimOverlay = document.getElementById('video-dim-overlay');
  if (roundStarts.length > 0 && !insideRound) {
    if (!dimOverlay.classList.contains('active')) {
      dimOverlay.classList.add('active');
      dimOverlay.innerHTML = '<span class="dim-label">Outside Round</span>';
    }
  } else {
    dimOverlay.classList.remove('active');
    dimOverlay.innerHTML = '';
  }

  // Show round indicator (always, if any round markers exist)
  if (roundStarts.length > 0) {
    const tag = document.createElement('div');
    tag.className = 'video-overlay-tag';
    if (insideRound) {
      tag.style.borderLeftColor = '#28a745';
      tag.textContent = 'Round ' + currentRound;
    } else {
      tag.style.borderLeftColor = '#e94560';
      tag.style.background = 'rgba(233, 69, 96, 0.3)';
      tag.textContent = 'Outside Round';
    }
    overlay.appendChild(tag);
  }

  for (const label of activeLabels) {
    const punch = PUNCH_TYPES.find(p => p.id === label.punch);
    const tag = document.createElement('div');
    tag.className = 'video-overlay-tag';
    tag.style.borderLeftColor = getPunchColor(label.punch);
    tag.style.cursor = 'pointer';
    tag.textContent = punch ? punch.label : label.punch;
    const idx = state.labels.indexOf(label);
    tag.onclick = () => {
      openEditLabel(idx);
      const entry = document.querySelector(`#label-log [data-label-idx="${idx}"]`);
      if (entry) entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    overlay.appendChild(tag);
  }
}

// ============================================================
// Timeline Zoom Controls
// ============================================================
function zoomIn() {
  setZoom(state.zoomLevel * 2, state.zoomCenter);
  onZoomChanged();
}

function zoomOut() {
  setZoom(state.zoomLevel / 2, state.zoomCenter);
  onZoomChanged();
}

function zoomFit() {
  state.zoomLevel = 1;
  state.zoomCenter = 0.5;
  onZoomChanged();
}

function onZoomChanged() {
  const display = document.getElementById('zoom-level-display');
  display.textContent = state.zoomLevel >= 1.5 ? Math.round(state.zoomLevel) + 'x' : '1x';

  // Show/hide minimap
  const minimap = document.getElementById('timeline-minimap');
  minimap.style.display = state.zoomLevel > 1.05 ? 'block' : 'none';

  renderTimelineOverlay();
  updateTimeDisplay();
}

function renderMinimap() {
  const video = document.getElementById('video-player');
  const duration = video.duration;
  const segContainer = document.getElementById('minimap-segments');
  const vpDiv = document.getElementById('minimap-viewport');
  segContainer.innerHTML = '';

  if (!duration || duration <= 0) return;

  // Draw punch segments (unzoomed)
  for (const label of state.labels) {
    if (label.isRoundMarker) continue;
    const seg = document.createElement('div');
    seg.style.position = 'absolute';
    seg.style.top = '0';
    seg.style.height = '100%';
    seg.style.borderRadius = '1px';
    const leftPct = (label.start / duration) * 100;
    const widthPct = ((label.end - label.start) / duration) * 100;
    seg.style.left = leftPct + '%';
    seg.style.width = Math.max(widthPct, 0.3) + '%';
    seg.style.backgroundColor = getPunchColor(label.punch);
    seg.style.opacity = '0.7';
    segContainer.appendChild(seg);
  }

  // Position viewport indicator
  const vp = getViewport();
  vpDiv.style.left = (vp.start * 100) + '%';
  vpDiv.style.width = ((vp.end - vp.start) * 100) + '%';

  // Update playhead position
  const playhead = document.getElementById('minimap-playhead');
  if (playhead && duration) {
    playhead.style.left = (video.currentTime / duration * 100) + '%';
  }
}

function renderTimeTicks() {
  const ticksContainer = document.getElementById('timeline-ticks');
  const video = document.getElementById('video-player');
  const duration = video.duration;
  ticksContainer.innerHTML = '';

  if (!duration || duration <= 0) return;

  const vp = getViewport();
  const vpDuration = (vp.end - vp.start) * duration;

  // Choose tick interval: aim for 5-20 major ticks
  const intervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let majorInterval = 1;
  for (const iv of intervals) {
    const count = vpDuration / iv;
    if (count >= 4 && count <= 25) { majorInterval = iv; break; }
    if (count < 4) { majorInterval = iv; break; }
  }
  const minorInterval = majorInterval / 4;

  // Render minor ticks
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

function setupMinimapInteraction() {
  const minimap = document.getElementById('timeline-minimap');
  const vpDiv = document.getElementById('minimap-viewport');
  const video = document.getElementById('video-player');
  let dragging = false;
  let dragStartX = 0;
  let dragStartCenter = 0;

  // Click on minimap to jump viewport center
  minimap.addEventListener('mousedown', (e) => {
    if (!video.duration) return;
    if (e.target === vpDiv) {
      // Start dragging the viewport
      dragging = true;
      dragStartX = e.clientX;
      dragStartCenter = state.zoomCenter;
      e.preventDefault();
      return;
    }
    // Click to recenter
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

  document.addEventListener('mouseup', () => {
    dragging = false;
  });
}

function toggleOverlay() {
  state.overlayVisible = !state.overlayVisible;
  const btn = document.getElementById('btn-overlay');
  const app = document.getElementById('app');
  if (state.overlayVisible) {
    btn.textContent = 'Labels: ON';
    btn.classList.remove('overlay-off');
    app.classList.remove('overlays-hidden');
  } else {
    btn.textContent = 'Labels: OFF';
    btn.classList.add('overlay-off');
    app.classList.add('overlays-hidden');
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
