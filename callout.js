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
//   Shift+<digit> = same punch to the body (Shift+1 = jab_body)
//   ↓ (ArrowDown) = mark the last typed punch as a body shot (post-hoc)
// Defenses (same keys as the punch labeler, for muscle memory):
//   q = lead slip    w = rear slip
//   a = lead roll    d = rear roll
//   r = pull back    f = step back
//   s = slip         g = roll     (no direction — some apps just call "slip"/"roll")
//   p = pivot        (footwork)
//   b = block        (slip/roll/block/pivot are callout-only — no executed-punch equivalent)
//
// Segment semantics (like the punch labeler): Enter opens a callout and
// stamps start_sec; you then type the combo tokens (e.g. `1-2b-lslip`)
// while it's being called; a second Enter stamps end_sec and commits ONE
// event spanning [start_sec, end_sec]. Playback is independent of
// recording — Space toggles play/pause, arrows seek, all mid-callout.
//
// Storage:
//   - localStorage on every keystroke (so a refresh doesn't lose work)
//   - Auto-save: every commit / undo / delete GETs the Apps Script
//     `saveCalloutEvents` action (debounced). Re-sending the whole
//     per-video set supersedes the prior rows, so it stays idempotent;
//     deleting down to zero clears the remote rows. Gated on a labeler
//     name + a known video.
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
// `slip`/`roll` (no direction), `block`, and `pivot` have no punch-labeler equivalent —
// they're callout-only (a coach instruction, never an executed punch), so they
// get their own ids. The direction-less slip/roll exist because some guided
// apps just call "slip" / "roll" without specifying lead vs rear.
const DEFENSE = {
  q: { id: 'lead_slip', code: 'lslip', label: 'lead slip' },
  w: { id: 'rear_slip', code: 'rslip', label: 'rear slip' },
  s: { id: 'slip',      code: 'slip',  label: 'slip' },
  a: { id: 'lead_roll', code: 'lroll', label: 'lead roll' },
  d: { id: 'rear_roll', code: 'rroll', label: 'rear roll' },
  g: { id: 'roll',      code: 'roll',  label: 'roll' },
  r: { id: 'pull_back', code: 'pull',  label: 'pull back' },
  f: { id: 'step_back', code: 'step',  label: 'step back' },
  p: { id: 'pivot',     code: 'pivot', label: 'pivot' },
  b: { id: 'block',     code: 'block', label: 'block' },
};

// KeyboardEvent.code -> token, so Shift+digit reads the digit (not the
// shifted symbol "!") and letters survive non-US layouts. Mirrors app.js.
const DIGIT_CODES = {
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5', Digit6: '6',
  Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5', Numpad6: '6',
};
const DEFENSE_CODES = {
  KeyQ: 'q', KeyW: 'w', KeyS: 's', KeyA: 'a', KeyD: 'd', KeyG: 'g', KeyR: 'r', KeyF: 'f', KeyB: 'b', KeyP: 'p',
};

Object.assign(state, {
  // [{ start_sec, end_sec, callout_raw: "1-2b", callout_ids: ["jab_head","cross_body"] }]
  calloutEvents: [],
  // Composing buffer of typed tokens, each either
  //   { kind: 'punch', digit: '1'-'6', body: bool }
  //   { kind: 'defense', key: 'q'|'w'|'a'|'d'|'r'|'f'|'b' }
  // `recording` is true between the start-Enter and the end-Enter; `startSec`
  // is the video time captured at the start-Enter. Tokens only register while
  // recording; the second Enter stamps end_sec and commits the event.
  buffer: [],
  recording: false,
  startSec: null,
  videoFileName: '',
});

const LS_KEY = 'callout_labeler_events_v2';   // v2: start_sec/end_sec segments
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
  setupPlayer();                  // from player.js — wires file picker, seek bar, zoom
  setupKeyboard();
  setupInputs();
  restoreFromStorage();
  updateBufferCard();
  renderEventList();

  // Labeler name: a persisted text input (shared localStorage key with the
  // orientation/direction labelers, so a labeler types their name once).
  const labelerInput = document.getElementById('labeler-input');
  try { labelerInput.value = localStorage.getItem('orient_labeler_name') || ''; } catch {}
  labelerInput.addEventListener('change', () => {
    try { localStorage.setItem('orient_labeler_name', labelerInput.value.trim()); } catch {}
    if (state.calloutEvents.length > 0) autoSave();   // re-stamp once a name exists
  });
});

// ── Keyboard state machine ──────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs.
    if (e.target.matches('input, textarea, select')) return;
    const video = document.getElementById('video-player');
    if (!video) return;

    // Enter ⇒ start the callout (1st press) / stamp end + commit (2nd press).
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.recording) endRecording(video);
      else startRecording(video);
      return;
    }
    // Digits 1-6 ⇒ append a punch token; Shift = body. Only while recording.
    const digit = DIGIT_CODES[e.code];
    if (digit) {
      e.preventDefault();
      if (!state.recording) { setStatus('Press Enter to start a callout first.'); return; }
      state.buffer.push({ kind: 'punch', digit, body: e.shiftKey });
      updateBufferCard();
      saveToStorage();
      return;
    }
    // Defense keys (q/w/a/d/r/f) + block (b) ⇒ append a defense token.
    const defKey = DEFENSE_CODES[e.code];
    if (defKey) {
      e.preventDefault();
      if (!state.recording) { setStatus('Press Enter to start a callout first.'); return; }
      state.buffer.push({ kind: 'defense', key: defKey });
      updateBufferCard();
      saveToStorage();
      return;
    }
    // Space ⇒ play/pause toggle (independent of recording).
    if (e.code === 'Space') {
      e.preventDefault();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      return;
    }
    // Backspace ⇒ remove last buffer token.
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (state.buffer.length > 0) {
        state.buffer.pop();
        updateBufferCard();
        saveToStorage();
      }
      return;
    }
    // z / Z ⇒ undo last committed event.
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (state.calloutEvents.length > 0) {
        const removed = state.calloutEvents.pop();
        saveToStorage();
        renderEventList();
        repaintTimeline();
        autoSave();
        setStatus(`Undid: ${removed.callout_raw} @ ${formatTime(removed.start_sec)}`);
      }
      return;
    }
    // Arrow keys ⇒ seek ±1s.
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 1);
      return;
    }
    // Down arrow ⇒ mark the most recent punch token as a body shot. Lets you
    // tap the digit fast, then flag body after the fact (instead of Shift+digit).
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!state.recording) { setStatus('Press Enter to start a callout first.'); return; }
      for (let i = state.buffer.length - 1; i >= 0; i--) {
        if (state.buffer[i].kind === 'punch') {
          state.buffer[i].body = true;
          updateBufferCard();
          saveToStorage();
          return;
        }
      }
      setStatus('No punch in the buffer to mark as body.');
      return;
    }
    // Esc ⇒ cancel the in-progress callout.
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.recording || state.buffer.length > 0) {
        state.recording = false;
        state.startSec = null;
        state.buffer = [];
        updateBufferCard();
        saveToStorage();
        setStatus('Callout cancelled.');
      }
      return;
    }
  });
}

// First Enter: open a callout, stamp its start time. Playback keeps running.
function startRecording(video) {
  state.recording = true;
  state.startSec = video.currentTime;
  state.buffer = [];
  updateBufferCard();
  saveToStorage();
  setStatus(`Callout started @ ${formatTime(state.startSec)} — type tokens, Enter to end.`);
}

// Second Enter: stamp end time and commit one [start, end] event. An empty
// buffer means a stray/double Enter — discard rather than store a blank callout.
function endRecording(video) {
  if (state.buffer.length === 0) {
    state.recording = false;
    state.startSec = null;
    updateBufferCard();
    saveToStorage();
    setStatus('Callout cancelled (no tokens).');
    return;
  }
  state.calloutEvents.push({
    start_sec: Number(state.startSec.toFixed(3)),
    end_sec: Number(video.currentTime.toFixed(3)),
    callout_raw: state.buffer.map(tokenCode).join('-'),
    callout_ids: state.buffer.map(tokenId),
  });
  state.recording = false;
  state.startSec = null;
  state.buffer = [];
  updateBufferCard();
  renderEventList();
  repaintTimeline();
  saveToStorage();
  autoSave();
}

// ── Buffer + event list rendering ───────────────────────────────────────────
function updateBufferCard() {
  const bufEl = document.getElementById('buffer-text');
  const timeEl = document.getElementById('buffer-time');
  bufEl.textContent = state.buffer.map(tokenCode).join('-');
  if (state.recording) {
    timeEl.textContent = `recording from ${formatTime(state.startSec)}`;
  } else {
    timeEl.textContent = 'press Enter to start';
  }
}

function renderEventList() {
  const listEl = document.getElementById('event-list');
  const countEl = document.getElementById('event-count');
  countEl.textContent = String(state.calloutEvents.length);
  if (state.calloutEvents.length === 0) {
    listEl.innerHTML = '<div class="empty-events">No events yet.</div>';
    return;
  }
  listEl.innerHTML = '';
  // Show in reverse (newest first) so the labeler sees what they just did.
  for (let i = state.calloutEvents.length - 1; i >= 0; i--) {
    const ev = state.calloutEvents[i];
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `
      <span class="er-time">${formatTime(ev.start_sec)}–${formatTime(ev.end_sec)}</span>
      <span class="er-cue">${ev.callout_raw}</span>
      <span class="er-del" title="Delete this event">✕</span>
    `;
    row.querySelector('.er-time').addEventListener('click', () => {
      const v = document.getElementById('video-player');
      if (v) v.currentTime = ev.start_sec;
    });
    row.querySelector('.er-del').addEventListener('click', (e) => {
      e.stopPropagation();
      state.calloutEvents.splice(i, 1);
      saveToStorage();
      renderEventList();
      repaintTimeline();
      autoSave();
    });
    listEl.appendChild(row);
  }
}

// ── Timeline overlay (hooks player.js calls on metadata / zoom / timeupdate) ──
// Mirrors the punch labeler: one segment per committed callout on the seek bar
// + minimap, plus a chip on the video while the playhead is inside a callout.
// Combos have no single punch type, so everything uses the one accent color and
// the raw combo string is the label/tooltip.
const CALLOUT_COLOR = '#e94560';

function repaintTimeline() {
  renderTimelineOverlay();
  updateVideoOverlay();
}

function renderTimelineOverlay() {
  const overlay = document.getElementById('seek-bar-overlay');
  const video = document.getElementById('video-player');
  if (!overlay || !video) return;
  const duration = video.duration;
  overlay.innerHTML = '';
  if (!duration || duration <= 0) return;

  for (const ev of state.calloutEvents) {
    const lPct = timeToViewportPct(ev.start_sec, duration);
    const rPct = timeToViewportPct(ev.end_sec, duration);
    if (rPct < 0 || lPct > 100) continue;        // off-screen at this zoom
    const seg = document.createElement('div');
    seg.className = 'seek-segment';
    seg.style.left = Math.max(0, lPct) + '%';
    seg.style.width = Math.max(Math.min(100, rPct) - Math.max(0, lPct), 0.15) + '%';
    seg.style.backgroundColor = CALLOUT_COLOR;
    seg.title = ev.callout_raw;
    overlay.appendChild(seg);
  }

  renderCalloutMinimap();
  updateMinimapChrome();   // player.js — viewport indicator + playhead
  renderTimeTicks();       // player.js — major/minor ticks
}

function renderCalloutMinimap() {
  const video = document.getElementById('video-player');
  const segContainer = document.getElementById('minimap-segments');
  if (!video || !segContainer) return;
  const duration = video.duration;
  segContainer.innerHTML = '';
  if (!duration || duration <= 0) return;

  for (const ev of state.calloutEvents) {
    const seg = document.createElement('div');
    seg.style.position = 'absolute';
    seg.style.top = '0';
    seg.style.height = '100%';
    seg.style.borderRadius = '1px';
    seg.style.left = (ev.start_sec / duration) * 100 + '%';
    seg.style.width = Math.max(((ev.end_sec - ev.start_sec) / duration) * 100, 0.3) + '%';
    seg.style.backgroundColor = CALLOUT_COLOR;
    seg.style.opacity = '0.7';
    segContainer.appendChild(seg);
  }
}

function updateVideoOverlay() {
  const overlay = document.getElementById('video-overlay');
  const video = document.getElementById('video-player');
  if (!overlay || !video) return;
  const t = video.currentTime;

  const active = state.calloutEvents.filter(ev => t >= ev.start_sec && t <= ev.end_sec);
  // Only rebuild the DOM when the active set actually changes (player.js calls
  // this on every timeupdate).
  const key = active.map(ev => `${ev.start_sec}:${ev.callout_raw}`).join(',');
  if (overlay.dataset.activeKey === key) return;
  overlay.dataset.activeKey = key;

  overlay.innerHTML = '';
  for (const ev of active) {
    const tag = document.createElement('div');
    tag.className = 'video-overlay-tag';
    tag.style.borderLeftColor = CALLOUT_COLOR;
    tag.textContent = ev.callout_raw;
    overlay.appendChild(tag);
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────
function saveToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      events: state.calloutEvents,
      buffer: state.buffer,
      recording: state.recording,
      startSec: state.startSec,
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
      state.recording = parsed.recording || false;
      state.startSec = parsed.startSec ?? null;
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

// ── Inputs (video picker + drive link) ───────────────────────────────────────
function setupInputs() {
  // Track the video file picker to remember the name. player.js also listens on
  // this input (it loads the video + sets state.videoName); we keep a separate
  // state.videoFileName for the payload + localStorage.
  document.getElementById('video-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    state.videoFileName = f.name;
    saveToStorage();
  });
  // Drive link: persist locally on each keystroke; re-stamp the sheet on blur
  // (change) once there are committed events.
  const driveLink = document.getElementById('drive-link');
  driveLink.addEventListener('input', saveToStorage);
  driveLink.addEventListener('change', () => {
    if (state.calloutEvents.length > 0) autoSave();
  });
}

function getLabeler() {
  const el = document.getElementById('labeler-input');
  return el ? el.value.trim() : '';
}

function buildPayload() {
  const driveUrl = document.getElementById('drive-link').value.trim();
  return {
    schema_version: 1,
    video_url: driveUrl,
    video_id: extractDriveFileId(driveUrl),
    video_filename: state.videoFileName,
    labeler: getLabeler(),
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

// ── Auto-save ─────────────────────────────────────────────────────────────
// Re-send the whole per-video set (debounced) after every commit / undo /
// delete. The backend supersedes this (labeler, video) set on each save, so
// repeated sends never duplicate rows — and deleting down to zero clears the
// remote rows for this video. Requires a labeler name + a known video.
let _saveTimer = null;
function autoSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doAutoSave, 800);
}

async function doAutoSave() {
  if (!getLabeler()) {
    setStatus('Type your name to enable auto-save.');
    return;
  }
  const payload = buildPayload();
  if (!payload.video_filename && !payload.video_id) {
    setStatus('Load a video (or paste its Drive link) to enable auto-save.');
    return;
  }
  const n = payload.events.length;
  setStatus(n > 0 ? `Saving ${n} callouts…` : 'Clearing callouts…');
  const url = sheetUrl({ action: 'saveCalloutEvents', payload: JSON.stringify(payload) });
  try {
    const resp = await fetch(url, { method: 'GET' });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed && parsed.status === 'ok') {
      setStatus(n > 0 ? `Saved ${n} callouts ✓` : 'Callouts cleared ✓');
    } else {
      const msg = parsed?.message || text.slice(0, 160);
      setStatus(`Auto-save failed: ${msg}`);
    }
  } catch (err) {
    setStatus(`Auto-save error: ${err.message}`);
  }
}

function setStatus(text) {
  const el = document.getElementById('status-line');
  if (el) el.textContent = text;
}
