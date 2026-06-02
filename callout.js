// ============================================================
// callout.js — Callout Labeler
//
// Labels the punch / combo / defense a coach app *calls out* in a
// video (these are third-party guided-workout videos pushed to
// YouTube — same corpus as the punch labeler, just annotated for the
// instruction rather than the executed punch). Combined with the
// per-frame pose trace, every callout becomes a weak label for the
// ST-GCN punch classifier — extra supervision the pose alone can't give.
//
// Vocabulary (numeric for punches, matching most guided apps):
//   1 = jab          (lead head)
//   2 = cross        (rear head)
//   3 = lead hook    (head)
//   4 = rear hook    (head)
//   5 = lead upper   (head)
//   6 = rear upper   (head)
//   <digit>b = same punch to the body
// Defenses (same keys as the punch labeler, for muscle memory):
//   q = lead slip    w = rear slip
//   a = lead roll    d = rear roll
//   r = pull back    f = step back
//
// Combo semantics: a sequence of tokens entered while the video stays
// paused = ONE event (e.g. `1-2b-lslip-2` = jab, cross_body, lead_slip,
// cross). Letting the video resume between two presses produces TWO
// separate events.
//
// Time stored per event = video.currentTime at the moment the buffer
// was first opened (i.e. the callout audio's onset, before the boxer's
// reaction lag).
//
// Storage:
//   - localStorage on every keystroke (so a refresh doesn't lose work)
//   - On Submit: GET the Apps Script `saveCalloutEvents` action, falls
//     back to a JSON download if the script doesn't recognise it.
// ============================================================

// Punch vocab: digit -> head/body canonical ids + display label.
const PUNCH = {
  '1': { id: 'jab_head',           bodyId: 'jab_body',           label: 'jab' },
  '2': { id: 'cross_head',         bodyId: 'cross_body',         label: 'cross' },
  '3': { id: 'lead_hook_head',     bodyId: 'lead_hook_body',     label: 'lead hook' },
  '4': { id: 'rear_hook_head',     bodyId: 'rear_hook_body',     label: 'rear hook' },
  '5': { id: 'lead_uppercut_head', bodyId: 'lead_uppercut_body', label: 'lead upper' },
  '6': { id: 'rear_uppercut_head', bodyId: 'rear_uppercut_body', label: 'rear upper' },
};

// Defense vocab: key -> compact display code + canonical id (matches the
// punch labeler's PUNCH_TYPES ids so the data joins across both tools).
const DEFENSE = {
  q: { id: 'lead_slip', code: 'lslip', label: 'lead slip' },
  w: { id: 'rear_slip', code: 'rslip', label: 'rear slip' },
  a: { id: 'lead_roll', code: 'lroll', label: 'lead roll' },
  d: { id: 'rear_roll', code: 'rroll', label: 'rear roll' },
  r: { id: 'pull_back', code: 'pull',  label: 'pull back' },
  f: { id: 'step_back', code: 'step',  label: 'step back' },
};

Object.assign(state, {
  // [{ time_sec, callout_raw: "1-2b", callout_ids: ["jab_head","cross_body"] }]
  calloutEvents: [],
  // Composing buffer of typed tokens, each either
  //   { kind: 'punch', digit: '1'-'6', body: bool }
  //   { kind: 'defense', key: 'q'|'w'|'a'|'d'|'r'|'f' }
  // Empty when not composing. `pausedTime` is the time of the first token
  // in the current buffer — that's what we save when the buffer commits.
  buffer: [],
  pausedTime: null,
  videoFileName: '',
});

const LS_KEY = 'callout_labeler_events_v1';
const LS_META_KEY = 'callout_labeler_meta_v1';

// ── Token helpers ─────────────────────────────────────────────────────────────
// Compact code for the buffer/raw display (e.g. "1", "2b", "lslip").
function tokenCode(item) {
  if (item.kind === 'punch') return item.digit + (item.body ? 'b' : '');
  return DEFENSE[item.key].code;
}
// Canonical id for downstream join (e.g. "jab_head", "cross_body", "lead_slip").
function tokenId(item) {
  if (item.kind === 'punch') {
    const p = PUNCH[item.digit];
    return item.body ? p.bodyId : p.id;
  }
  return DEFENSE[item.key].id;
}

// ── Init ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupPlayer();                  // from player.js — wires file picker, seek bar
  attachVideoListeners();
  setupKeyboard();
  setupButtons();
  restoreFromStorage();
  updateBufferCard();
  renderEventList();
  setStatus(LABELER_ID ? `Labeler: ${LABELER_ID}` : 'Tip: add ?labeler=YOURNAME to the URL');
  if (LABELER_ID) {
    const badge = document.getElementById('labeler-badge');
    badge.textContent = LABELER_ID;
    badge.style.display = 'inline-block';
  }
});

function attachVideoListeners() {
  const video = document.getElementById('video-player');
  const seekBar = document.getElementById('seek-bar');
  const timeDisplay = document.getElementById('time-display');

  // Local seek-bar wiring — player.js's setupSeekBar bails on this page
  // because it expects #seek-bar-wrapper + thumbnail nodes we don't ship.
  const renderTime = () => {
    if (!timeDisplay) return;
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
    if (seekBar && video.duration > 0) {
      seekBar.value = ((video.currentTime / video.duration) * 100).toFixed(2);
    }
  };
  if (seekBar) {
    seekBar.addEventListener('input', () => {
      if (video.duration > 0) {
        video.currentTime = (Number(seekBar.value) / 100) * video.duration;
      }
    });
  }

  video.addEventListener('loadedmetadata', renderTime);
  video.addEventListener('timeupdate', renderTime);
  // Keep our notion of pausedTime fresh when the user clicks pause via
  // the native controls (not via a token press).
  video.addEventListener('pause', () => {
    // If the buffer is empty AND the pause was user-initiated, capture
    // the time so the next token press uses *this* moment, not the
    // moment of the first token. Better matches the callout's audio onset.
    if (state.buffer.length === 0) state.pausedTime = video.currentTime;
    updateBufferCard();
  });
}

// ── Keyboard state machine ──────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs.
    if (e.target.matches('input, textarea, select')) return;
    const video = document.getElementById('video-player');
    if (!video) return;

    const k = e.key;
    // Digits 1-6 ⇒ append a punch token (auto-pause if playing).
    if (/^[1-6]$/.test(k)) {
      e.preventDefault();
      pauseForBuffer(video);
      state.buffer.push({ kind: 'punch', digit: k, body: false });
      updateBufferCard();
      saveToStorage();
      return;
    }
    // B (or b) ⇒ toggle body on the most-recent punch token.
    if (k === 'b' || k === 'B') {
      e.preventDefault();
      const last = state.buffer[state.buffer.length - 1];
      if (last && last.kind === 'punch') {
        last.body = !last.body;
        updateBufferCard();
        saveToStorage();
      }
      return;
    }
    // Defense keys (q/w/a/d/r/f) ⇒ append a defense token (auto-pause).
    if (DEFENSE[k.toLowerCase()]) {
      e.preventDefault();
      pauseForBuffer(video);
      state.buffer.push({ kind: 'defense', key: k.toLowerCase() });
      updateBufferCard();
      saveToStorage();
      return;
    }
    // Space ⇒ commit-if-buffer + resume, else just toggle play/pause.
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (state.buffer.length > 0 && video.paused) {
        commitBuffer();
        video.play().catch(() => {});
      } else if (video.paused) {
        // Empty buffer, just resume.
        video.play().catch(() => {});
      } else {
        video.pause();
        state.pausedTime = video.currentTime;
        updateBufferCard();
      }
      return;
    }
    // Backspace ⇒ remove last buffer token.
    if (k === 'Backspace') {
      e.preventDefault();
      if (state.buffer.length > 0) {
        const last = state.buffer[state.buffer.length - 1];
        if (last.kind === 'punch' && last.body) {
          // First Backspace strips the body modifier, second removes the token.
          last.body = false;
        } else {
          state.buffer.pop();
        }
        if (state.buffer.length === 0) state.pausedTime = null;
        updateBufferCard();
        saveToStorage();
      }
      return;
    }
    // z / Z ⇒ undo last committed event.
    if (k === 'z' || k === 'Z') {
      e.preventDefault();
      if (state.calloutEvents.length > 0) {
        const removed = state.calloutEvents.pop();
        saveToStorage();
        renderEventList();
        setStatus(`Undid: ${removed.callout_raw} @ ${formatTime(removed.time_sec)}`);
      }
      return;
    }
    // Arrow keys ⇒ seek ±1s.
    if (k === 'ArrowLeft') {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 1);
      return;
    }
    if (k === 'ArrowRight') {
      e.preventDefault();
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 1);
      return;
    }
    // Esc ⇒ clear current buffer.
    if (k === 'Escape') {
      e.preventDefault();
      state.buffer = [];
      state.pausedTime = null;
      updateBufferCard();
      saveToStorage();
      return;
    }
  });
}

// Pause the video (if playing) and anchor pausedTime to the buffer's first
// token, so every token in a combo shares the onset timestamp.
function pauseForBuffer(video) {
  if (!video.paused) {
    video.pause();
    state.pausedTime = video.currentTime;
  }
  if (state.buffer.length === 0 && state.pausedTime == null) {
    state.pausedTime = video.currentTime;
  }
}

function commitBuffer() {
  if (state.buffer.length === 0) return;
  const time = state.pausedTime ?? document.getElementById('video-player').currentTime;
  state.calloutEvents.push({
    time_sec: Number(time.toFixed(3)),
    callout_raw: state.buffer.map(tokenCode).join('-'),
    callout_ids: state.buffer.map(tokenId),
  });
  state.buffer = [];
  state.pausedTime = null;
  updateBufferCard();
  renderEventList();
  saveToStorage();
}

// ── Buffer + event list rendering ───────────────────────────────────────────
function updateBufferCard() {
  const bufEl = document.getElementById('buffer-text');
  const timeEl = document.getElementById('buffer-time');
  if (state.buffer.length === 0) {
    bufEl.textContent = '—';
  } else {
    bufEl.textContent = state.buffer.map(tokenCode).join('-');
  }
  if (state.pausedTime != null) {
    timeEl.textContent = `video paused: ${formatTime(state.pausedTime)}`;
  } else {
    timeEl.textContent = 'video paused: —';
  }
}

function renderEventList() {
  const listEl = document.getElementById('event-list');
  const countEl = document.getElementById('event-count');
  countEl.textContent = String(state.calloutEvents.length);
  if (state.calloutEvents.length === 0) {
    listEl.innerHTML = '<div class="empty-events">No events yet.</div>';
    document.getElementById('btn-submit').disabled = true;
    return;
  }
  document.getElementById('btn-submit').disabled = false;
  listEl.innerHTML = '';
  // Show in reverse (newest first) so the labeler sees what they just did.
  for (let i = state.calloutEvents.length - 1; i >= 0; i--) {
    const ev = state.calloutEvents[i];
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `
      <span class="er-time">${formatTime(ev.time_sec)}</span>
      <span class="er-cue">${ev.callout_raw}</span>
      <span class="er-del" title="Delete this event">✕</span>
    `;
    row.querySelector('.er-time').addEventListener('click', () => {
      const v = document.getElementById('video-player');
      if (v) v.currentTime = ev.time_sec;
    });
    row.querySelector('.er-del').addEventListener('click', (e) => {
      e.stopPropagation();
      state.calloutEvents.splice(i, 1);
      saveToStorage();
      renderEventList();
    });
    listEl.appendChild(row);
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────
function saveToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      events: state.calloutEvents,
      buffer: state.buffer,
      pausedTime: state.pausedTime,
    }));
    localStorage.setItem(LS_META_KEY, JSON.stringify({
      driveLink: document.getElementById('drive-link').value,
      videoFileName: state.videoFileName,
    }));
  } catch (err) {
    // localStorage might be full or disabled — non-fatal.
    console.warn('[callout] localStorage save failed:', err);
  }
}

function restoreFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.calloutEvents = parsed.events || [];
      state.buffer = parsed.buffer || [];
      state.pausedTime = parsed.pausedTime ?? null;
    }
    const meta = localStorage.getItem(LS_META_KEY);
    if (meta) {
      const parsed = JSON.parse(meta);
      if (parsed.driveLink) document.getElementById('drive-link').value = parsed.driveLink;
      if (parsed.videoFileName) {
        state.videoFileName = parsed.videoFileName;
        document.getElementById('video-name').textContent = parsed.videoFileName;
      }
    }
  } catch (err) {
    console.warn('[callout] localStorage restore failed:', err);
  }
}

// ── Submit + download ───────────────────────────────────────────────────────
function setupButtons() {
  document.getElementById('btn-submit').addEventListener('click', onSubmit);
  document.getElementById('btn-download').addEventListener('click', onDownload);
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Clear all events for this video? (already-submitted events will not be removed from the Sheet)')) return;
    state.calloutEvents = [];
    state.buffer = [];
    state.pausedTime = null;
    saveToStorage();
    renderEventList();
    updateBufferCard();
    setStatus('Cleared.');
  });
  // Track video file picker to remember the name.
  document.getElementById('video-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    state.videoFileName = f.name;
    saveToStorage();
  });
  // Track drive link changes.
  document.getElementById('drive-link').addEventListener('input', saveToStorage);
}

function buildPayload() {
  const driveUrl = document.getElementById('drive-link').value.trim();
  return {
    schema_version: 1,
    video_url: driveUrl,
    video_id: extractDriveFileId(driveUrl),
    video_filename: state.videoFileName,
    labeler: LABELER_ID || 'anon',
    submitted_at: new Date().toISOString(),
    n_events: state.calloutEvents.length,
    events: state.calloutEvents,
  };
}

function extractDriveFileId(url) {
  if (!url) return '';
  const m1 = url.match(/\/file\/d\/([\w-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([\w-]+)/);
  if (m2) return m2[1];
  return '';
}

async function onSubmit() {
  if (state.calloutEvents.length === 0) return;
  const payload = buildPayload();
  if (!payload.video_url && !payload.video_filename) {
    if (!confirm('No Drive URL or video file recorded — submit anyway?')) return;
  }
  setStatus(`Submitting ${state.calloutEvents.length} events…`);
  const url = sheetUrl({
    action: 'saveCalloutEvents',
    payload: JSON.stringify(payload),
  });
  try {
    const resp = await fetch(url, { method: 'GET' });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed && parsed.status === 'ok') {
      setStatus(`Submitted ${state.calloutEvents.length} events.`);
      showToast(`Saved ${state.calloutEvents.length} callouts`, 'info');
      // Don't auto-clear — the labeler may want to keep going on the
      // same video. They can use Clear when done.
    } else {
      const msg = parsed?.message || text.slice(0, 200);
      setStatus(`Submit failed: ${msg}. Falling back to JSON download.`);
      onDownload();
    }
  } catch (err) {
    setStatus(`Submit error: ${err.message}. Falling back to JSON download.`);
    onDownload();
  }
}

function onDownload() {
  const payload = buildPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const stem = state.videoFileName.replace(/\.[^.]+$/, '') || payload.video_id || 'callout_events';
  a.href = URL.createObjectURL(blob);
  a.download = `${stem}_callouts.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setStatus(`Downloaded ${state.calloutEvents.length} events.`);
}

function setStatus(text) {
  const el = document.getElementById('status-line');
  if (el) el.textContent = text;
}
