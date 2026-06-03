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
//   c + <digit>   = vague "combo of N punches" (c then 3 ⇒ a 3-punch combo,
//                   used when the coach calls a combo without naming the punches)
// Defenses:
//   s = slip         g = roll     d = duck   (no direction — labeled generically)
//   r = pull back    f = step back
//   p = pivot        (footwork)
//   b = block        (all callout-only — no executed-punch equivalent)
//
// Segment semantics (like the punch labeler): Enter opens a callout and
// stamps start_sec; you then type the combo tokens (e.g. `1-2b-slip`)
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

// Defense vocab: key -> compact display code + canonical id. Slips and rolls
// are labeled generically (no lead/rear) — coaches usually just call "slip" /
// "roll", and the direction isn't reliable from the callout anyway. `pull_back`
// and `step_back` reuse the punch labeler's ids so those join across tools;
// `slip`, `roll`, `duck`, `block`, `pivot` are callout-only ids.
const DEFENSE = {
  s: { id: 'slip',      code: 'slip',  label: 'slip' },
  g: { id: 'roll',      code: 'roll',  label: 'roll' },
  d: { id: 'duck',      code: 'duck',  label: 'duck' },
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
  KeyS: 's', KeyG: 'g', KeyD: 'd', KeyR: 'r', KeyF: 'f', KeyB: 'b', KeyP: 'p',
};

Object.assign(state, {
  // [{ start_sec, end_sec, callout_raw: "1-2b", callout_ids: ["jab_head","cross_body"] }]
  calloutEvents: [],
  // Composing buffer of typed tokens, each either
  //   { kind: 'punch', digit: '1'-'6', body: bool }
  //   { kind: 'combo', count: 1-9 }   (vague "combo of N punches")
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
// Compact code for the buffer/raw display (e.g. "1", "2b", "slip", "c3").
function tokenCode(item) {
  if (item.kind === 'punch') return item.digit + (item.body ? 'b' : '');
  if (item.kind === 'combo') return 'c' + item.count;
  return DEFENSE[item.key].code;
}
// Canonical id for downstream join (e.g. "jab_head", "cross_body", "slip", "combo_3").
function tokenId(item) {
  if (item.kind === 'punch') {
    const p = PUNCH[item.digit];
    return item.body ? p.bodyId : p.id;
  }
  if (item.kind === 'combo') return 'combo_' + item.count;
  return DEFENSE[item.key].id;
}

// Inverse of tokenCode/tokenId: parse a hyphen-joined combo string
// ("1-2b-slip") back into normalized codes + canonical ids, so an edited
// combo stays consistent with callout_ids. Tolerates spaces and uppercase.
// Returns { raw, ids } or null if any token is unrecognized.
function parseCalloutRaw(str) {
  const parts = String(str).split('-').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return null;
  const codes = [];
  const ids = [];
  for (const part of parts) {
    const pm = part.match(/^([1-6])(b?)$/);   // punch digit, optional body 'b'
    if (pm) {
      const p = PUNCH[pm[1]];
      const body = pm[2] === 'b';
      codes.push(pm[1] + (body ? 'b' : ''));
      ids.push(body ? p.bodyId : p.id);
      continue;
    }
    const cm = part.match(/^c([1-9])$/);       // vague "combo of N punches"
    if (cm) { codes.push('c' + cm[1]); ids.push('combo_' + cm[1]); continue; }
    const def = Object.values(DEFENSE).find(d => d.code === part);
    if (def) { codes.push(def.code); ids.push(def.id); continue; }
    return null;   // unrecognized token ⇒ reject the whole edit
  }
  return { raw: codes.join('-'), ids };
}

// ── Init ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupPlayer();                  // from player.js — wires file picker, seek bar, zoom
  setupKeyboard();
  setupInputs();
  setupWaveform();
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
// Arrow-hold acceleration state (mirrors app.js): after holding an arrow for
// ACCEL_DELAY ms, each repeat steps ACCEL_MULTIPLIER frames instead of one.
let _arrowHoldStart = null;
let _arrowHeldKey = null;
let _comboPending = false;   // `c` was pressed; next digit is the combo count

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in inputs.
    if (e.target.matches('input, textarea, select')) return;
    const video = document.getElementById('video-player');
    if (!video) return;

    // Combo entry: `c` arms it, the NEXT digit is consumed as the punch count
    // ("c" then "3" ⇒ a vague 3-punch combo). Must run before the digit handler
    // so the count isn't mistaken for a punch. Any non-digit aborts the arm and
    // is swallowed — so e.g. `c` then Enter just clears the placeholder instead
    // of ending (and committing) the whole callout.
    if (_comboPending) {
      _comboPending = false;
      e.preventDefault();
      const n = (e.code.match(/^(?:Digit|Numpad)([1-9])$/) || [])[1];
      if (n) {
        state.buffer.push({ kind: 'combo', count: Number(n) });
        saveToStorage();
      }
      updateBufferCard();   // resolve the placeholder, or just clear it on abort
      return;
    }

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
    // `c` ⇒ arm a combo token; the next digit (1-9) becomes the punch count.
    if (e.code === 'KeyC') {
      e.preventDefault();
      if (!state.recording) { setStatus('Press Enter to start a callout first.'); return; }
      _comboPending = true;
      updateBufferCard();   // show the "combo of … punches" placeholder
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
        _editingIndex = null;
        saveToStorage();
        renderEventList();
        repaintTimeline();
        autoSave();
        setStatus(`Undid: ${removed.callout_raw} @ ${formatTime(removed.start_sec)}`);
      }
      return;
    }
    // Arrow keys ⇒ frame-step like the punch labeler: one frame per tap,
    // accelerating to ACCEL_MULTIPLIER frames after holding ACCEL_DELAY ms.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (_arrowHeldKey !== e.key) {
        _arrowHeldKey = e.key;
        _arrowHoldStart = Date.now();
      }
      const held = Date.now() - _arrowHoldStart;
      const mult = held >= ACCEL_DELAY ? ACCEL_MULTIPLIER : 1;
      stepFrames(dir * mult);
      return;
    }
    // Esc / Delete ⇒ discard the in-progress callout (buffer + recording),
    // without committing it. (Enter commits; this throws it away.)
    if (e.key === 'Escape' || e.key === 'Delete') {
      e.preventDefault();
      if (state.recording || state.buffer.length > 0) {
        state.recording = false;
        state.startSec = null;
        state.buffer = [];
        updateBufferCard();
        saveToStorage();
        setStatus('Callout discarded.');
      }
      return;
    }
  });

  // Reset arrow-hold acceleration when the key is released.
  document.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      _arrowHeldKey = null;
      _arrowHoldStart = null;
    }
  });
}

// Stable per-event id so the backend can reconcile by row (update/add/delete
// just the rows that changed) instead of rewriting the whole video's set.
function makeEventId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// Open a callout and stamp its start time. Triggered by Enter (at the playhead)
// or a right-click on the loudness strip (at the clicked time). Playback keeps
// running either way.
function startRecording(video, atSec = video.currentTime) {
  state.recording = true;
  state.startSec = atSec;
  state.buffer = [];
  _comboPending = false;
  updateBufferCard();
  saveToStorage();
  setStatus(`Callout started @ ${formatTime(state.startSec)} — type tokens, then right-click / Enter to end.`);
}

// Close a callout: stamp the end time and commit one [start, end] event.
// Triggered by the 2nd Enter (at the playhead) or a 2nd right-click on the
// loudness strip (at the clicked time). An empty buffer means a stray/double
// trigger — discard rather than store a blank callout. start/end are ordered
// so a right-click on the offset before the onset still yields a valid window.
function endRecording(video, atSec = video.currentTime) {
  if (state.buffer.length === 0) {
    state.recording = false;
    state.startSec = null;
    updateBufferCard();
    saveToStorage();
    setStatus('Callout cancelled (no tokens).');
    return;
  }
  state.calloutEvents.push({
    id: makeEventId(),
    start_sec: Number(Math.min(state.startSec, atSec).toFixed(3)),
    end_sec: Number(Math.max(state.startSec, atSec).toFixed(3)),
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
// Human-readable token for the buffer card: same as tokenCode except a combo
// spells out "combo of N punches" (clearer than the compact "c3"). callout_raw
// still uses the compact tokenCode form.
function tokenDisplay(item) {
  if (item.kind === 'combo') return `combo of ${item.count} punches`;
  return tokenCode(item);
}
function updateBufferCard() {
  const bufEl = document.getElementById('buffer-text');
  const timeEl = document.getElementById('buffer-time');
  const parts = state.buffer.map(tokenDisplay);
  // While `c` is armed (before the count digit), show a live placeholder that
  // the next digit fills in: "combo of … punches" ⇒ "combo of 3 punches".
  if (_comboPending) parts.push('combo of … punches');
  bufEl.textContent = parts.join('-');
  if (state.recording) {
    timeEl.textContent = `recording from ${formatTime(state.startSec)}`;
  } else {
    timeEl.textContent = 'press Enter to start';
  }
}

// Index of the event currently open in the inline editor (null = none).
let _editingIndex = null;

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
    listEl.appendChild(i === _editingIndex ? buildEventEditor(i, ev) : buildEventRow(i, ev));
  }
}

// Read-only row: time (click ⇒ seek), cue (click ⇒ edit), ✎ (edit), ✕ (delete).
function buildEventRow(i, ev) {
  const row = document.createElement('div');
  row.className = 'event-row';
  row.innerHTML = `
    <span class="er-time" title="Jump to start">${formatTime(ev.start_sec)}–${formatTime(ev.end_sec)}</span>
    <span class="er-cue" title="Click to edit">${ev.callout_raw}</span>
    <span class="er-edit" title="Edit this callout">✎</span>
    <span class="er-del" title="Delete this callout">✕</span>
  `;
  row.querySelector('.er-time').addEventListener('click', () => {
    const v = document.getElementById('video-player');
    if (v) v.currentTime = ev.start_sec;
  });
  const edit = () => { _editingIndex = i; renderEventList(); };
  row.querySelector('.er-cue').addEventListener('click', edit);
  row.querySelector('.er-edit').addEventListener('click', (e) => { e.stopPropagation(); edit(); });
  row.querySelector('.er-del').addEventListener('click', (e) => {
    e.stopPropagation();
    _editingIndex = null;
    state.calloutEvents.splice(i, 1);
    saveToStorage();
    renderEventList();
    repaintTimeline();
    autoSave();
  });
  return row;
}

// Inline editor: change the combo string and/or the start/end seconds.
// Enter (in any field) saves, Escape cancels. Save validates the combo and
// re-derives callout_ids, clamps + orders the times, then re-stamps the sheet.
function buildEventEditor(i, ev) {
  const row = document.createElement('div');
  row.className = 'event-row event-row--editing';

  const cue = document.createElement('input');
  cue.className = 'er-edit-cue';
  cue.type = 'text';
  cue.value = ev.callout_raw;
  cue.title = 'Combo tokens, e.g. 1-2b-slip';

  const row2 = document.createElement('div');
  row2.className = 'er-edit-row2';
  const start = document.createElement('input');
  start.className = 'er-edit-num'; start.type = 'number'; start.step = '0.001';
  start.value = ev.start_sec; start.title = 'Start (seconds)';
  const dash = document.createElement('span');
  dash.className = 'er-edit-dash'; dash.textContent = '–';
  const end = document.createElement('input');
  end.className = 'er-edit-num'; end.type = 'number'; end.step = '0.001';
  end.value = ev.end_sec; end.title = 'End (seconds)';
  const save = document.createElement('span');
  save.className = 'er-save'; save.textContent = '✓'; save.title = 'Save changes';
  const cancel = document.createElement('span');
  cancel.className = 'er-cancel'; cancel.textContent = '✕'; cancel.title = 'Cancel';
  row2.append(start, dash, end, save, cancel);
  row.append(cue, row2);

  const commit = () => {
    const parsed = parseCalloutRaw(cue.value);
    if (!parsed) {
      setStatus('Invalid combo — use tokens like 1, 2b, slip, roll, pull, step, pivot, block.');
      cue.focus();
      return;
    }
    let s = Number(start.value), e2 = Number(end.value);
    if (!isFinite(s) || !isFinite(e2)) { setStatus('Start/end must be numbers (seconds).'); return; }
    const dur = document.getElementById('video-player').duration;
    s = Math.max(0, s); e2 = Math.max(0, e2);
    if (dur) { s = Math.min(s, dur); e2 = Math.min(e2, dur); }
    const evt = state.calloutEvents[i];
    evt.start_sec = Number(Math.min(s, e2).toFixed(3));
    evt.end_sec = Number(Math.max(s, e2).toFixed(3));
    evt.callout_raw = parsed.raw;
    evt.callout_ids = parsed.ids;
    _editingIndex = null;
    saveToStorage();
    renderEventList();
    repaintTimeline();
    autoSave();
    setStatus(`Updated: ${parsed.raw} @ ${formatTime(evt.start_sec)}`);
  };
  const cancelEdit = () => { _editingIndex = null; renderEventList(); };

  save.addEventListener('click', commit);
  cancel.addEventListener('click', cancelEdit);
  for (const inp of [cue, start, end]) {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
  }
  // Focus the combo for immediate editing once it's in the DOM.
  setTimeout(() => { cue.focus(); cue.select(); }, 0);
  return row;
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
  renderWaveform();        // redraw the loudness strip for the current viewport
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
  updateWaveformPlayhead();   // keep the loudness-strip playhead in sync each frame
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

// ── Audio loudness strip ──────────────────────────────────────────────────────
// Decode the loaded file's audio once, downmix to mono, and draw a peak-envelope
// strip under the seek bar. It shares the timeline's zoom viewport (so it lines
// up with the callout segments + ticks). Left-drag scrubs the playhead; a
// right-click marks a callout edge at the cursor — letting a labeler nail an
// onset/offset straight off the loudness curve.
let _audioCtx = null;

async function decodeAudioForWaveform(file) {
  const hint = document.getElementById('waveform-hint');
  try {
    if (hint) { hint.style.display = 'flex'; hint.textContent = 'Decoding audio…'; }
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const audio = await _audioCtx.decodeAudioData(await file.arrayBuffer());
    // Downmix every channel to one mono track (sum / N).
    const n = audio.length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += data[i];
    }
    if (audio.numberOfChannels > 1) {
      const inv = 1 / audio.numberOfChannels;
      for (let i = 0; i < n; i++) mono[i] *= inv;
    }
    state.waveMono = mono;
    state.waveSampleRate = audio.sampleRate;
    if (hint) hint.style.display = 'none';
    renderWaveform();
  } catch (err) {
    console.warn('[callout] audio decode failed:', err);
    state.waveMono = null;
    if (hint) { hint.style.display = 'flex'; hint.textContent = 'No audio track'; }
    renderWaveform();
  }
}

// Max-abs amplitude per output column for samples [startSample, endSample).
function waveformPeaks(mono, startSample, endSample, cols) {
  const peaks = new Float32Array(cols);
  const total = endSample - startSample;
  if (total <= 0) return peaks;
  const per = total / cols;
  for (let x = 0; x < cols; x++) {
    const s0 = startSample + Math.floor(x * per);
    const s1 = Math.min(endSample, startSample + Math.floor((x + 1) * per));
    let peak = 0;
    for (let i = s0; i < s1; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
    peaks[x] = peak;
  }
  return peaks;
}

function renderWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  const wrapper = document.getElementById('waveform-wrapper');
  const video = document.getElementById('video-player');
  if (!canvas || !wrapper || !video) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = wrapper.clientWidth;
  const cssH = wrapper.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const mono = state.waveMono;
  const duration = video.duration;
  if (!mono || !duration || duration <= 0) { updateWaveformPlayhead(); return; }

  const vp = getViewport();                       // shared zoom window (0..1 of duration)
  const sr = state.waveSampleRate;
  const startSample = Math.max(0, Math.floor(vp.start * duration * sr));
  const endSample = Math.min(mono.length, Math.ceil(vp.end * duration * sr));
  const cols = Math.max(1, Math.floor(cssW));
  const peaks = waveformPeaks(mono, startSample, endSample, cols);

  const mid = cssH / 2;
  ctx.fillStyle = 'rgba(233, 69, 96, 0.6)';
  for (let x = 0; x < cols; x++) {
    const h = peaks[x] * mid;                      // peak in [0,1] → half height
    if (h > 0) ctx.fillRect(x, mid - h, 1, Math.max(h * 2, 1));
  }
  // Faint center baseline.
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, Math.round(mid), cssW, 1);

  updateWaveformPlayhead();
}

function updateWaveformPlayhead() {
  const ph = document.getElementById('waveform-playhead');
  const video = document.getElementById('video-player');
  if (!ph || !video) return;
  const duration = video.duration;
  if (!duration || duration <= 0) { ph.style.display = 'none'; return; }
  const pct = timeToViewportPct(video.currentTime, duration);
  if (pct < 0 || pct > 100) { ph.style.display = 'none'; return; }
  ph.style.display = 'block';
  ph.style.left = pct + '%';
}

function setupWaveform() {
  const wrapper = document.getElementById('waveform-wrapper');
  const video = document.getElementById('video-player');
  if (!wrapper || !video) return;

  // Viewport-aware pixel→time using the same math as the seek bar, clamped to
  // the strip's bounds and the clip duration.
  const timeAtClientX = (clientX) => {
    const rect = wrapper.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const time = viewportPctToTime((x / rect.width) * 100, video.duration);
    return Math.max(0, Math.min(video.duration, time));
  };

  // Left-button hold + move ⇒ scrub the playhead along the strip.
  let dragging = false;
  wrapper.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !video.duration) return;
    dragging = true;
    video.currentTime = timeAtClientX(e.clientX);
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging || !video.duration) return;
    video.currentTime = timeAtClientX(e.clientX);
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // Right-click ⇒ mark a callout edge at the clicked time: 1st starts it,
  // 2nd ends + commits it (same state machine as Enter, but time-stamped at
  // the cursor so you can nail onset/offset off the loudness curve).
  wrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!video.duration) return;
    const t = timeAtClientX(e.clientX);
    video.currentTime = t;
    if (state.recording) endRecording(video, t);
    else startRecording(video, t);
  });

  // Ctrl + scroll ⇒ zoom the shared timeline viewport, anchored on the cursor,
  // so you can magnify a specific stretch of the loudness curve. The seek bar,
  // ticks and callout segments share this viewport and zoom with it. (Mirrors
  // the seek bar's alt-scroll zoom; onZoomChanged repaints the strip.)
  wrapper.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !video.duration) return;
    e.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    const pct = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    const vp = getViewport();
    const anchorNorm = vp.start + pct * (vp.end - vp.start);
    const factor = e.deltaY < 0 ? 1.4 : 1 / 1.4;
    setZoom(state.zoomLevel * factor, anchorNorm);
    onZoomChanged();
  }, { passive: false });

  // Keep the strip sharp when the layout width changes.
  if (window.ResizeObserver) new ResizeObserver(() => renderWaveform()).observe(wrapper);
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
      // Backfill ids on events saved before per-event ids existed.
      for (const ev of state.calloutEvents) if (!ev.id) ev.id = makeEventId();
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
    decodeAudioForWaveform(f);   // build the loudness strip from the file's audio
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
