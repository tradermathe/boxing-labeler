// ============================================================
// app.js — Boxing Punch Labeler (page-specific)
//
// Handles punch-type catalogue, label workflow (start → pick type →
// end), round markers, Google Sheets sync, label list rendering,
// and the timeline overlay for punch segments + round shading.
//
// Shared video + seek-bar + minimap + zoom + playback + helpers
// live in player.js (loaded first). The shared `state` is defined
// there; this file extends it with page-specific keys.
// ============================================================

// ============================================================
// Punch catalogue
// ============================================================
const PUNCH_TYPES = [
  { id: 'jab_head',              label: 'Jab (Head)',          key: '1', group: 'offense' },
  { id: 'cross_head',            label: 'Cross (Head)',        key: '2', group: 'offense' },
  { id: 'lead_hook_head',        label: 'Lead Hook',           key: '3', group: 'offense' },
  { id: 'rear_hook_head',        label: 'Rear Hook',           key: '4', group: 'offense' },
  { id: 'lead_uppercut_head',    label: 'Lead Uppercut',       key: '5', group: 'offense' },
  { id: 'rear_uppercut_head',    label: 'Rear Uppercut',       key: '6', group: 'offense' },
  { id: 'jab_body',              label: 'Jab (Body)',          key: '⇧1', group: 'offense' },
  { id: 'cross_body',            label: 'Cross (Body)',        key: '⇧2', group: 'offense' },
  { id: 'lead_hook_body',        label: 'Lead Hook (Body)',    key: '⇧3', group: 'offense' },
  { id: 'rear_hook_body',        label: 'Rear Hook (Body)',    key: '⇧4', group: 'offense' },
  { id: 'lead_uppercut_body',    label: 'Lead Uppercut (Body)', key: '⇧5', group: 'offense' },
  { id: 'rear_uppercut_body',    label: 'Rear Uppercut (Body)', key: '⇧6', group: 'offense' },
  { id: 'lead_slip',             label: 'Lead Slip',           key: 'q', group: 'defense' },
  { id: 'rear_slip',             label: 'Rear Slip',           key: 'w', group: 'defense' },
  { id: 'lead_roll',             label: 'Lead Roll',           key: 'a', group: 'defense' },
  { id: 'rear_roll',             label: 'Rear Roll',           key: 'd', group: 'defense' },
  { id: 'pull_back',             label: 'Pull Back',           key: 'r', group: 'defense' },
  { id: 'step_back',             label: 'Step Back',           key: 'f', group: 'defense' },
  { id: 'unsure',                label: 'Unsure',              key: 'u', group: 'other' },
];

const PUNCH_COLORS = {
  // Offense — each punch gets a distinct, vivid color
  jab_head:           '#ff2244',
  cross_head:         '#ff8800',
  lead_hook_head:     '#ffdd00',
  rear_hook_head:     '#ff00aa',
  lead_uppercut_head: '#cc44ff',
  rear_uppercut_head: '#33cccc',
  jab_body:           '#0088ff',
  cross_body:         '#ff6699',
  lead_hook_body:     '#aa9900',
  rear_hook_body:     '#aa0066',
  lead_uppercut_body: '#7722aa',
  rear_uppercut_body: '#228899',
  // Defense
  lead_slip:  '#00ff88',
  rear_slip:  '#00ddff',
  lead_roll:  '#3388ff',
  rear_roll:  '#00ffcc',
  pull_back:  '#aa66ff',
  step_back:  '#ffff00',
  // Other
  unsure:      '#999999',
  round_start: '#28a745',
  round_end:   '#666666',
};

function getPunchColor(punchId) {
  return PUNCH_COLORS[punchId] || '#533483';
}

// ============================================================
// Page-specific state (player.js owns the shared `state`; we extend it)
// ============================================================
Object.assign(state, {
  selectedPunch: null,
  mode: 'start',
  pendingStart: null,
  labels: [],
  roundActive: false,
  unsureFilter: false,
});

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildPunchButtons();
  setupPlayer();                 // video loader, seek bar, minimap — from player.js
  setupKeyboardShortcuts();
  updateTimestampButton();
  updateRoundIndicator();
  setupDriveLink();
  if (LABELER_ID) {
    const badge = document.getElementById('labeler-badge');
    const isName = !/^\d+$/.test(LABELER_ID);
    const displayName = isName
      ? LABELER_ID.charAt(0).toUpperCase() + LABELER_ID.slice(1).toLowerCase()
      : LABELER_ID;
    badge.textContent = isName ? displayName : 'Labeler ' + displayName;
    badge.style.display = 'inline';
    document.title = isName
      ? 'Boxing Punch Labeler — ' + displayName
      : 'Boxing Punch Labeler ' + displayName;
  }
  if (LABELER_ID === 'review') {
    const btn = document.getElementById('btn-unsure-filter');
    if (btn) btn.style.display = 'inline-block';
    if (localStorage.getItem('unsureFilter') === 'true') {
      state.unsureFilter = true;
    }
    updateUnsureFilterButton();
  }
});

function toggleUnsureFilter() {
  state.unsureFilter = !state.unsureFilter;
  localStorage.setItem('unsureFilter', String(state.unsureFilter));
  updateUnsureFilterButton();
  renderLabels();
  updateVideoOverlay();
}

function updateUnsureFilterButton() {
  const btn = document.getElementById('btn-unsure-filter');
  if (!btn) return;
  if (state.unsureFilter) {
    btn.textContent = 'Unsure only: ON';
    btn.style.background = '#533483';
  } else {
    btn.textContent = 'Unsure only: OFF';
    btn.style.background = '#0f3460';
  }
}

function shouldHideByFilter(label) {
  if (!state.unsureFilter) return false;
  if (label.isRoundMarker) return false;
  return label.punch !== 'unsure';
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

  if (state.mode === 'punch') {
    state.mode = 'end';
    document.getElementById('pending-label').textContent =
      `Start: ${formatTime(state.pendingStart)} | ${punch.label} -- now set the END time`;
  }
  updateTimestampButton();
}

// ============================================================
// Timestamp / Labeling Workflow
// Workflow: Start time → Select punch → End time
// ============================================================
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
      id: null,
      // Stable identifier the punch keeps across edits. Used as the join
      // key by the rules labeler (Form Labels sheet) so form annotations
      // survive row/id reshuffles.
      punch_uuid: crypto.randomUUID(),
      punch: state.selectedPunch,
      angle: '',
      start: state.pendingStart,
      end: time,
      videoName: normalizeDriveUrl(document.getElementById('drive-link').value.trim()) || state.videoName,
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
      punchUuid: label.punch_uuid || '',
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
      if (result.id != null) label.id = result.id;
      // Server may have stamped its own UUID if our client-generated one was
      // missing (older builds). Adopt whatever the server persisted.
      if (result.punch_uuid) label.punch_uuid = result.punch_uuid;
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
  const label = {
    id: null,
    // Round markers get UUIDs too so every row in the sheet has one —
    // simpler backend schema than conditionally stamping.
    punch_uuid: crypto.randomUUID(),
    punch: markerType,
    start: time,
    end: time,
    videoName: normalizeDriveUrl(document.getElementById('drive-link').value.trim()) || state.videoName,
    isRoundMarker: true,
    timestamp: new Date().toISOString(),
  };
  state.labels.push(label);
  renderLabels();
  pushRoundMarkerToSheet(label);
}

async function pushRoundMarkerToSheet(label) {
  if (!state.scriptUrl) return;
  const time = formatTimeSheet(label.start);
  try {
    const url = sheetUrl({
      action: 'add',
      videoName: label.videoName,
      trainingType: document.getElementById('training-type').value,
      stance: document.getElementById('stance-select').value,
      punchId: label.punch,
      punchUuid: label.punch_uuid || '',
      angle: '',
      startTime: time,
      endTime: time,
    });
    const resp = await fetch(url);
    const result = await resp.json();
    if (result.id != null) label.id = result.id;
    if (result.punch_uuid) label.punch_uuid = result.punch_uuid;
    showToast(`${label.punch} saved at ${formatTime(label.start)}`, 'success');
    fetchLabelsFromSheet();
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

  const savedType = localStorage.getItem(prefix + 'training_type');
  const savedStance = localStorage.getItem(prefix + 'stance');
  if (savedType) trainingType.value = savedType;
  if (savedStance) stance.value = savedStance;

  trainingType.addEventListener('change', () => {
    localStorage.setItem(prefix + 'training_type', trainingType.value);
  });
  stance.addEventListener('change', () => {
    localStorage.setItem(prefix + 'stance', stance.value);
  });

  let debounceTimer;
  input.addEventListener('input', () => {
    localStorage.setItem(prefix + 'drive_link', normalizeDriveUrl(input.value.trim()));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (input.value.trim()) {
        state.labels = [];
        fetchLabelsFromSheet();
      }
    }, 500);
  });

  if (saved && saved.trim()) {
    fetchLabelsFromSheet();
  }
}

// ============================================================
// Fetch existing labels from Google Sheet
// ============================================================
async function fetchLabelsFromSheet() {
  if (_pendingDeletes > 0) return;
  const driveLink = normalizeDriveUrl(document.getElementById('drive-link').value.trim());
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

    state.labels = state.labels.filter(l => !l.fromSheet);

    if (result.labels && result.labels.length > 0) {
      const sheetLabels = result.labels.map(l => {
        const punch = mapPunchType(l.punch);
        const isRound = punch === 'round_start' || punch === 'round_end';
        return {
          id: l.id,
          punch_uuid: l.punch_uuid || '',
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

      for (const sl of sheetLabels) {
        const isDuplicate = state.labels.some(ll =>
          ll.id === sl.id ||
          (ll.punch === sl.punch &&
           Math.abs(ll.start - sl.start) < 0.01 &&
           Math.abs(ll.end - sl.end) < 0.01)
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

// Map sheet punch types to our IDs
function mapPunchType(sheetPunch) {
  if (!sheetPunch) return 'jab_head';
  const p = String(sheetPunch).toLowerCase().trim();
  if (p === 'round_start' || p === 'round start') return 'round_start';
  if (p === 'round_end' || p === 'round end') return 'round_end';
  if (PUNCH_TYPES.find(t => t.id === p)) return p;
  const byLabel = PUNCH_TYPES.find(t => t.label.toLowerCase() === p);
  if (byLabel) return byLabel.id;
  const MAP = {
    'jab': 'jab_head', 'jab head': 'jab_head', 'jab (head)': 'jab_head',
    'jab body': 'jab_body', 'jab (body)': 'jab_body',
    'cross': 'cross_head', 'cross head': 'cross_head', 'cross (head)': 'cross_head',
    'cross body': 'cross_body', 'cross (body)': 'cross_body',
    'lead hook': 'lead_hook_head', 'lead hook head': 'lead_hook_head', 'lead hook (head)': 'lead_hook_head',
    'rear hook': 'rear_hook_head', 'rear hook head': 'rear_hook_head', 'rear hook (head)': 'rear_hook_head',
    'lead uppercut': 'lead_uppercut_head', 'lead uppercut head': 'lead_uppercut_head',
    'rear uppercut': 'rear_uppercut_head', 'rear uppercut head': 'rear_uppercut_head',
    'lead hook body': 'lead_hook_body', 'lead hook (body)': 'lead_hook_body',
    'rear hook body': 'rear_hook_body', 'rear hook (body)': 'rear_hook_body',
    'lead uppercut body': 'lead_uppercut_body', 'lead uppercut (body)': 'lead_uppercut_body',
    'rear uppercut body': 'rear_uppercut_body', 'rear uppercut (body)': 'rear_uppercut_body',
    'lead slip': 'lead_slip', 'rear slip': 'rear_slip',
    'lead roll': 'lead_roll', 'rear roll': 'rear_roll',
    'pull back': 'pull_back', 'pullback': 'pull_back',
    'step back': 'step_back', 'stepback': 'step_back',
    'round start': 'round_start', 'round end': 'round_end',
    'unsure': 'unsure', '?': 'unsure',
  };
  if (MAP[p]) return MAP[p];
  const underscored = p.replace(/\s+/g, '_');
  if (PUNCH_TYPES.find(t => t.id === underscored)) return underscored;
  console.warn('Unknown punch type from sheet:', sheetPunch, '→ defaulting to jab_head');
  return 'jab_head';
}

function parseSheetTime(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (!timeStr) return 0;
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
  const punchCount = state.labels.filter(l => !l.isRoundMarker && !shouldHideByFilter(l)).length;
  count.textContent = `(${punchCount})`;

  // Capture open editors before wiping (keyed by array index —
  // unique within a render call, unlike label.id which can collide)
  const openEditors = {};
  log.querySelectorAll('.label-entry.editing').forEach(entry => {
    const idx = parseInt(entry.dataset.labelIdx);
    const label = state.labels[idx];
    if (!label) return;
    if (label.isRoundMarker) {
      const startInput = entry.querySelector('.edit-start');
      openEditors[idx] = { isRoundMarker: true, start: startInput ? startInput.value : null };
    } else {
      const punchSel = entry.querySelector('.edit-punch');
      const startInput = entry.querySelector('.edit-start');
      const endInput = entry.querySelector('.edit-end');
      openEditors[idx] = {
        isRoundMarker: false,
        punch: punchSel ? punchSel.value : null,
        start: startInput ? startInput.value : null,
        end: endInput ? endInput.value : null,
      };
    }
  });

  log.innerHTML = '';
  const sorted = state.labels.map((label, idx) => ({ label, idx }));
  sorted.sort((a, b) => b.label.start - a.label.start);
  sorted.forEach(({ label, idx }) => {
    if (shouldHideByFilter(label)) return;
    const entry = document.createElement('div');

    if (label.isRoundMarker) {
      entry.className = 'label-entry round-marker';
      const icon = label.punch === 'round_start' ? '\u25B6' : '\u25A0';
      const text = label.punch === 'round_start' ? 'Round Start' : 'Round End';
      entry.innerHTML = `
        <span class="label-text">
          <small style="color:#555">#${label.id || '...'}</small> ${icon} <span style="color:#888">${text}</span>
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
          <small style="color:#555">#${label.id || '...'}</small> <strong>${punch?.label || label.punch}</strong><br>
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

  // Restore open editors with their unsaved values
  sorted.forEach(({ label, idx }) => {
    const saved = openEditors[idx];
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
    if (_pendingDeletes === 0) fetchLabelsFromSheet();
  }
}

// ============================================================
// Jump to adjacent label (Shift+Arrow nav)
// ============================================================
let _arrowHoldStart = null;
let _arrowHeldKey = null;

function jumpToAdjacentLabel(dir) {
  const video = document.getElementById('video-player');
  const now = video.currentTime;
  const EPS = 0.05;

  const times = state.labels
    .filter(l => !l.isRoundMarker && !shouldHideByFilter(l))
    .map(l => l.start)
    .sort((a, b) => a - b);

  if (times.length === 0) return;

  let target = null;
  if (dir > 0) {
    target = times.find(t => t > now + EPS);
  } else {
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] < now - EPS) { target = times[i]; break; }
    }
  }

  if (target !== null) {
    video.currentTime = target;
    updateTimeDisplay(target);
  }
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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
        if (e.shiftKey) {
          jumpToAdjacentLabel(dir);
        } else {
          if (_arrowHeldKey !== e.code) {
            _arrowHeldKey = e.code;
            _arrowHoldStart = Date.now();
          }
          const held = Date.now() - _arrowHoldStart;
          const mult = held >= ACCEL_DELAY ? ACCEL_MULTIPLIER : 1;
          stepFrames(dir * mult);
        }
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

      case 'Period':
      case 'Comma':
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

      case 'Equal':
      case 'NumpadAdd':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomIn(); }
        break;
      case 'Minus':
      case 'NumpadSubtract':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomOut(); }
        break;
      // Number row: plain = head punch, Shift = body punch
      case 'Digit1': selectPunch(e.shiftKey ? 'jab_body' : 'jab_head'); break;
      case 'Digit2': selectPunch(e.shiftKey ? 'cross_body' : 'cross_head'); break;
      case 'Digit3': selectPunch(e.shiftKey ? 'lead_hook_body' : 'lead_hook_head'); break;
      case 'Digit4': selectPunch(e.shiftKey ? 'rear_hook_body' : 'rear_hook_head'); break;
      case 'Digit5': selectPunch(e.shiftKey ? 'lead_uppercut_body' : 'lead_uppercut_head'); break;
      case 'Digit6': selectPunch(e.shiftKey ? 'rear_uppercut_body' : 'rear_uppercut_head'); break;
      case 'Digit0':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomFit(); }
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

      // Numpad: plain = head punch, Shift = body punch
      case 'Numpad1': selectPunch(e.shiftKey ? 'jab_body' : 'jab_head'); break;
      case 'Numpad2': selectPunch(e.shiftKey ? 'cross_body' : 'cross_head'); break;
      case 'Numpad3': selectPunch(e.shiftKey ? 'lead_hook_body' : 'lead_hook_head'); break;
      case 'Numpad4': selectPunch(e.shiftKey ? 'rear_hook_body' : 'rear_hook_head'); break;
      case 'Numpad5': selectPunch(e.shiftKey ? 'lead_uppercut_body' : 'lead_uppercut_head'); break;
      case 'Numpad6': selectPunch(e.shiftKey ? 'rear_uppercut_body' : 'rear_uppercut_head'); break;

      // Defense keys
      case 'KeyQ': selectPunch('lead_slip'); break;
      case 'KeyW': selectPunch('rear_slip'); break;
      case 'KeyA': selectPunch('lead_roll'); break;
      case 'KeyD': selectPunch('rear_roll'); break;
      case 'KeyR': selectPunch('pull_back'); break;
      case 'KeyF': selectPunch('step_back'); break;
      case 'KeyU': selectPunch('unsure'); break;
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
// Round tracking
// ============================================================
function syncRoundActiveFromLabels() {
  const starts = state.labels.filter(l => l.punch === 'round_start').map(l => l.start).sort((a, b) => a - b);
  const ends = state.labels.filter(l => l.punch === 'round_end').map(l => l.start).sort((a, b) => a - b);
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
// Timeline overlay — punch segments + round shading on seek bar,
// colored segments on minimap. Hook called by player.js.
// ============================================================
function renderTimelineOverlay() {
  const overlay = document.getElementById('seek-bar-overlay');
  const video = document.getElementById('video-player');
  const duration = video.duration;
  overlay.innerHTML = '';
  if (!duration || duration <= 0) return;

  const roundStarts = state.labels
    .filter(l => l.punch === 'round_start' || (l.isRoundMarker && l.punch?.includes?.('start')))
    .map(l => l.start)
    .sort((a, b) => a - b);
  const roundEnds = state.labels
    .filter(l => l.punch === 'round_end' || (l.isRoundMarker && l.punch?.includes?.('end')))
    .map(l => l.start)
    .sort((a, b) => a - b);

  const rounds = [];
  for (let i = 0; i < roundStarts.length; i++) {
    const rStart = roundStarts[i];
    const rEnd = roundEnds.find(e => e > rStart);
    rounds.push({ start: rStart, end: rEnd !== undefined ? rEnd : duration });
  }

  // Shade areas outside rounds
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

  // Punch segments
  for (const label of state.labels) {
    if (label.isRoundMarker) continue;
    if (shouldHideByFilter(label)) continue;
    const lPct = timeToViewportPct(label.start, duration);
    const rPct = timeToViewportPct(label.end, duration);
    if (rPct < 0 || lPct > 100) continue;
    const seg = document.createElement('div');
    seg.className = 'seek-segment';
    seg.style.left = Math.max(0, lPct) + '%';
    seg.style.width = Math.max(Math.min(100, rPct) - Math.max(0, lPct), 0.15) + '%';
    seg.style.backgroundColor = getPunchColor(label.punch);
    overlay.appendChild(seg);
  }

  renderMinimap();
  updateMinimapChrome();
  renderTimeTicks();
}

function renderMinimap() {
  const video = document.getElementById('video-player');
  const duration = video.duration;
  const segContainer = document.getElementById('minimap-segments');
  segContainer.innerHTML = '';

  if (!duration || duration <= 0) return;

  for (const label of state.labels) {
    if (label.isRoundMarker) continue;
    if (shouldHideByFilter(label)) continue;
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
}

function updateVideoOverlay() {
  const overlay = document.getElementById('video-overlay');
  const video = document.getElementById('video-player');
  const t = video.currentTime;

  const roundStarts = state.labels
    .filter(l => l.punch === 'round_start' || (l.isRoundMarker && l.punch?.includes?.('start')))
    .map(l => l.start)
    .sort((a, b) => a - b);
  const roundEnds = state.labels
    .filter(l => l.punch === 'round_end' || (l.isRoundMarker && l.punch?.includes?.('end')))
    .map(l => l.start)
    .sort((a, b) => a - b);

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
    !l.isRoundMarker && t >= l.start && t <= l.end && !shouldHideByFilter(l)
  );

  const roundKey = currentRound ? 'R' + currentRound : 'out';
  const key = roundKey + '|' + activeLabels.map(l => l.id).join(',') + '|' + state.unsureFilter;
  if (overlay.dataset.activeKey === key) return;
  overlay.dataset.activeKey = key;

  overlay.innerHTML = '';

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
