// ============================================================
// rules.js — Form Rules Labeler (page-specific)
//
// Fetches punches already labeled in the punch labeler (via
// ?action=list), lets the user step through them, and records a
// Pass/Fail/Unclear answer for each form rule. Answers sync to a
// separate "Form Labels {N}" sheet via action=listRules/saveRule.
//
// Shared video + timeline + helpers live in player.js (loaded first).
// ============================================================

// ============================================================
// Rule catalogue — labeler-facing names only. Descriptions and
// examples live in Notion (Coaching > Rule Explanations).
// ============================================================
const RULES = [
  { id: 'rule_hand_extended', label: 'Hand stays out too long', cue: 'Hand lingers extended after the punch ends' },
  { id: 'rule_hand_low',      label: 'Hand returns too low',    cue: 'Comes back below the cheekbone/guard height' },
  { id: 'rule_hand_ushape',   label: 'Hand loops on return',    cue: 'Drops and curves back instead of a straight line' },
  { id: 'rule_hip_rotation',  label: 'Hip rotation',            cue: 'Hips drive the punch (jabs excluded)' },
  { id: 'rule_resting_hand',  label: 'Resting hand at guard',   cue: 'Non-punching hand stays up' },
  { id: 'rule_extension',     label: 'Fully extended',          cue: 'Arm reaches near-full extension at peak' },
  { id: 'rule_punch_height',  label: 'At head height',          cue: 'Head-labeled punch lands high (skip for body)' },
];

const ANSWERS = ['pass', 'fail', 'unclear'];
const ANSWER_COLORS  = { pass: '#28a745', fail: '#e94560', unclear: '#888' };
const ANSWER_SYMBOLS = { pass: '\u2713',  fail: '\u2717',  unclear: '?' };

// Which rule IDs are skipped for which punch types. Only runs on
// specific punch types — for others the rule is marked N/A.
function ruleAppliesTo(ruleId, punch) {
  if (!punch) return false;
  const type = String(punch.punch || '').toLowerCase();
  const hand = String(punch.hand || '').toLowerCase();
  if (ruleId === 'rule_hip_rotation') {
    // Jabs excluded from hip rotation check
    return !(type.startsWith('jab') || hand === 'lead' && type.includes('straight') && type.includes('lead'));
  }
  if (ruleId === 'rule_punch_height') {
    // Only applies to head-labeled punches
    return type.endsWith('_head') || type.includes('head');
  }
  if (ruleId === 'rule_extension') {
    // Only applies to straight punches (jab/cross, head/body)
    return type.startsWith('jab') || type.startsWith('cross');
  }
  return true;
}

// ============================================================
// Page-specific state (extends shared `state` from player.js)
// ============================================================
Object.assign(state, {
  punches: [],            // sorted by start_sec
  currentIdx: -1,         // index into state.punches
  activeRuleIdx: 0,       // which rule row is selected (0..RULES.length-1)
  answers: {},            // { punch_uuid: { rule_id: 'pass'|'fail'|'unclear' } }
});

// ============================================================
// Init
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  setupPlayer();
  setupKeyboardShortcuts();
  setupDriveLink();
  renderCurrentPunch();      // empty state
  if (LABELER_ID) {
    const badge = document.getElementById('labeler-badge');
    const isName = !/^\d+$/.test(LABELER_ID);
    const displayName = isName
      ? LABELER_ID.charAt(0).toUpperCase() + LABELER_ID.slice(1).toLowerCase()
      : LABELER_ID;
    badge.textContent = isName ? displayName : 'Labeler ' + displayName;
    badge.style.display = 'inline';
    document.title = isName
      ? 'Form Rules Labeler — ' + displayName
      : 'Form Rules Labeler ' + displayName;
  }
});

// ============================================================
// Drive Link — paste/type to fetch punches for this video
// ============================================================
function setupDriveLink() {
  const input = document.getElementById('drive-link');
  const prefix = LABELER_ID ? 'labeler_' + LABELER_ID + '_rules_' : 'labeler_rules_';
  const saved = localStorage.getItem(prefix + 'drive_link');
  if (saved) input.value = saved;

  let debounceTimer;
  input.addEventListener('input', () => {
    localStorage.setItem(prefix + 'drive_link', normalizeDriveUrl(input.value.trim()));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (input.value.trim()) loadPunchesAndAnswers();
    }, 500);
  });

  if (saved && saved.trim()) loadPunchesAndAnswers();
}

// ============================================================
// Load punches (from Combined Data via ?labeler=combined list) +
// load any already-saved rule answers.
// ============================================================
async function loadPunchesAndAnswers() {
  const driveLink = normalizeDriveUrl(document.getElementById('drive-link').value.trim());
  if (!state.scriptUrl || !driveLink) return;
  setStatus('Loading punches...');

  // Step 1: fetch punches. Use the combined sheet so any labeler's
  // rules labeler works against canonical data, not a single labeler's
  // private sheet.
  let punchList = [];
  try {
    const url = new URL(state.scriptUrl);
    url.searchParams.set('labeler', 'combined');
    url.searchParams.set('action', 'list');
    url.searchParams.set('video', driveLink);
    const resp = await fetch(url);
    const result = await resp.json();
    if (result.status === 'error') {
      setStatus('Error: ' + result.message, 'error');
      return;
    }
    punchList = (result.labels || [])
      .filter(l => {
        // Exclude round markers
        const p = String(l.punch || '').toLowerCase();
        return p !== 'round_start' && p !== 'round_end' && !p.includes('round');
      })
      .map(l => ({
        id:         l.id,
        // Stable cross-sheet identity — the backend backfills this
        // on any row missing one, so it should always be present.
        punch_uuid: l.punch_uuid || '',
        videoName:  l.videoName,
        punch:      l.punch,
        start_sec:  typeof l.startTime === 'number' ? l.startTime : parseFloat(l.startTime) || 0,
        end_sec:    typeof l.endTime === 'number' ? l.endTime : parseFloat(l.endTime) || 0,
        hand:       deriveHand(l.punch),
        stance:     l.stance || 'orthodox',
      }))
      .sort((a, b) => a.start_sec - b.start_sec);
  } catch (e) {
    console.error('Failed to fetch punches', e);
    setStatus('Failed to load punches', 'error');
    return;
  }

  // Step 2: fetch any already-saved rule answers for this video.
  // Use the current labeler (not combined) — answers are per-labeler.
  let savedAnswers = {};
  try {
    savedAnswers = await fetchExistingAnswers(driveLink);
  } catch (e) {
    console.warn('Could not fetch saved rule answers:', e);
  }

  state.punches = punchList;
  state.answers = savedAnswers;
  state.currentIdx = punchList.length > 0 ? 0 : -1;
  state.activeRuleIdx = 0;

  renderPunchList();
  renderCurrentPunch();
  if (state.currentIdx >= 0) seekToPunch(state.currentIdx);
  const answered = Object.keys(savedAnswers).length;
  setStatus(`${punchList.length} punches, ${answered} already started`);
}

async function fetchExistingAnswers(driveLink) {
  const url = sheetUrl({ action: 'listRules', video: driveLink });
  const resp = await fetch(url);
  const result = await resp.json();
  if (result.status !== 'ok' || !result.rules) return {};
  // rules: [{ punch_uuid, rule_*, ... }, ...] — wide row, one row per punch,
  // one column per rule. Key every answer by punch_uuid.
  const answers = {};
  for (const r of result.rules) {
    if (r.punch_uuid == null || r.punch_uuid === '') continue;
    const key = String(r.punch_uuid);
    if (!answers[key]) answers[key] = {};
    for (const rule of RULES) {
      if (r[rule.id]) answers[key][rule.id] = r[rule.id];
    }
  }
  return answers;
}

// Best-effort hand derivation from punch type string. The combined
// sheet doesn't carry a separate hand column today.
function deriveHand(punchType) {
  if (!punchType) return '';
  const p = String(punchType).toLowerCase();
  if (p.startsWith('jab') || p.startsWith('lead_')) return 'lead';
  if (p.startsWith('cross') || p.startsWith('rear_')) return 'rear';
  return '';
}

// ============================================================
// Punch list rendering
// ============================================================
function renderPunchList() {
  const list = document.getElementById('punch-list');
  const count = document.getElementById('punch-list-count');
  count.textContent = `(${state.punches.length})`;
  list.innerHTML = '';

  state.punches.forEach((p, idx) => {
    const entry = document.createElement('div');
    entry.className = 'punch-list-entry';
    entry.dataset.idx = idx;
    if (idx === state.currentIdx) entry.classList.add('current');

    const a = state.answers[p.punch_uuid] || {};
    const applicable = RULES.filter(r => ruleAppliesTo(r.id, p));
    const answeredCount = applicable.filter(r => a[r.id]).length;
    const totalCount = applicable.length;
    let statusClass = 'pending';
    if (answeredCount === totalCount && totalCount > 0) statusClass = 'complete';
    else if (answeredCount > 0) statusClass = 'partial';
    entry.classList.add('status-' + statusClass);

    entry.innerHTML = `
      <span class="pl-idx">${idx + 1}</span>
      <span class="pl-type">${prettyPunch(p.punch)}</span>
      <span class="pl-time">${formatTime(p.start_sec)}</span>
      <span class="pl-progress">${answeredCount}/${totalCount}</span>
    `;
    entry.onclick = () => selectPunch(idx);
    list.appendChild(entry);
  });
}

function prettyPunch(s) {
  if (!s) return '—';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ============================================================
// Selection + navigation
// ============================================================
function selectPunch(idx) {
  if (idx < 0 || idx >= state.punches.length) return;
  state.currentIdx = idx;
  state.activeRuleIdx = 0;
  renderPunchList();
  renderCurrentPunch();
  seekToPunch(idx);
  const entry = document.querySelector(`.punch-list-entry[data-idx="${idx}"]`);
  if (entry) entry.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function seekToPunch(idx) {
  const video = document.getElementById('video-player');
  const p = state.punches[idx];
  if (!p || !video.duration) return;
  video.currentTime = p.start_sec;
}

function nextPunch() { selectPunch(Math.min(state.punches.length - 1, state.currentIdx + 1)); }
function prevPunch() { selectPunch(Math.max(0, state.currentIdx - 1)); }

// ============================================================
// Current punch checklist
// ============================================================
function renderCurrentPunch() {
  const card = document.getElementById('current-punch-card');
  const checklist = document.getElementById('rule-checklist');
  const progress = document.getElementById('rule-progress');
  const p = state.punches[state.currentIdx];

  if (!p) {
    card.innerHTML = '<div id="current-punch-empty">Pick a punch to start labeling</div>';
    checklist.innerHTML = '';
    progress.textContent = '';
    return;
  }

  card.innerHTML = `
    <div class="cp-row"><span class="cp-label">Punch</span><span class="cp-value"><strong>${prettyPunch(p.punch)}</strong></span></div>
    <div class="cp-row"><span class="cp-label">Hand</span><span class="cp-value">${p.hand || '—'}</span></div>
    <div class="cp-row"><span class="cp-label">Stance</span><span class="cp-value">${p.stance || '—'}</span></div>
    <div class="cp-row"><span class="cp-label">Time</span><span class="cp-value">${formatTime(p.start_sec)} &rarr; ${formatTime(p.end_sec)}</span></div>
    <div class="cp-row"><span class="cp-label">#</span><span class="cp-value">${state.currentIdx + 1} of ${state.punches.length}</span></div>
  `;

  const a = state.answers[p.punch_uuid] || {};
  checklist.innerHTML = '';
  RULES.forEach((rule, i) => {
    const applicable = ruleAppliesTo(rule.id, p);
    const row = document.createElement('div');
    row.className = 'rule-row';
    if (!applicable) row.classList.add('disabled');
    if (i === state.activeRuleIdx && applicable) row.classList.add('active');
    row.dataset.ruleIdx = i;

    const selected = a[rule.id] || '';
    const answerBtns = ANSWERS.map(ans => {
      const active = selected === ans;
      return `<button class="ans-btn ans-${ans}${active ? ' active' : ''}" data-ans="${ans}" onclick="answerRule(${i}, '${ans}')">${ANSWER_SYMBOLS[ans]} ${ans}</button>`;
    }).join('');

    row.innerHTML = `
      <div class="rule-head">
        <span class="rule-num">${i + 1}</span>
        <span class="rule-title">${rule.label}</span>
        ${applicable ? '' : '<span class="rule-na">N/A for this punch</span>'}
      </div>
      <div class="rule-cue">${rule.cue}</div>
      <div class="rule-answers">${answerBtns}</div>
    `;
    row.onclick = (e) => {
      if (e.target.closest('.ans-btn')) return;
      if (applicable) state.activeRuleIdx = i;
      renderCurrentPunch();
    };
    checklist.appendChild(row);
  });

  const applicable = RULES.filter(r => ruleAppliesTo(r.id, p));
  const answered = applicable.filter(r => a[r.id]).length;
  progress.textContent = `${answered} of ${applicable.length} rules answered`;

  // Next-punch button: enabled only when every applicable rule on this punch
  // has an answer, and there's another punch after this one. Acts as the
  // primary "move on" affordance — the Shift+→ shortcut still works as an
  // escape hatch for skipping ahead without completing.
  const nextBtn = document.getElementById('rule-next-btn');
  if (nextBtn) {
    const allAnswered = applicable.length > 0 && answered === applicable.length;
    const hasNext = state.currentIdx + 1 < state.punches.length;
    nextBtn.disabled = !(allAnswered && hasNext);
    nextBtn.textContent = hasNext ? 'Next punch →' : 'All punches done';
  }
}

function answerRule(ruleIdx, answer) {
  const p = state.punches[state.currentIdx];
  const rule = RULES[ruleIdx];
  if (!p || !rule || !ruleAppliesTo(rule.id, p)) return;
  if (!p.punch_uuid) {
    showToast('Punch has no uuid — skipping save. Re-run punch labeler to backfill.', 'error');
    return;
  }

  if (!state.answers[p.punch_uuid]) state.answers[p.punch_uuid] = {};
  state.answers[p.punch_uuid][rule.id] = answer;

  // Advance the active row to the next applicable rule for fast keyboard
  // labeling, but stop at the last rule — the user clicks the Next button
  // (or Shift+→) when they're ready to move on. We no longer auto-advance
  // to the next punch because that forced the 5th save to race with the
  // previous 4 and produced duplicate Form Labels rows.
  let next = ruleIdx + 1;
  while (next < RULES.length && !ruleAppliesTo(RULES[next].id, p)) next++;
  if (next < RULES.length) state.activeRuleIdx = next;

  renderCurrentPunch();
  renderPunchList();
  saveAnswerToSheet(p, rule, answer);
}

// ============================================================
// Sheet sync — one row per punch (keyed on punch_uuid), one column
// per rule. Backend upserts on punch_uuid.
// ============================================================
async function saveAnswerToSheet(punch, rule, answer) {
  if (!state.scriptUrl) return;
  try {
    const url = sheetUrl({
      action:     'saveRule',
      video:      punch.videoName,
      punch_uuid: punch.punch_uuid,
      punch_type: punch.punch,
      hand:       punch.hand || '',
      stance:     punch.stance || '',
      start_sec:  String(punch.start_sec),
      end_sec:    String(punch.end_sec),
      rule:       rule.id,
      answer:     answer,
    });
    const resp = await fetch(url);
    const result = await resp.json();
    if (result.status === 'error') {
      showToast('Save failed: ' + result.message, 'error');
    } else {
      showToast(`${rule.label}: ${answer}`, 'info');
    }
  } catch (e) {
    console.error('Save failed', e);
    showToast('Save failed: ' + e.message, 'error');
  }
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') e.target.blur();

    switch (e.code) {
      case 'Space':
        e.preventDefault(); togglePlay(); break;

      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) {
          dir > 0 ? nextPunch() : prevPunch();
        } else {
          stepFrames(dir);
        }
        break;
      }

      case 'KeyY': e.preventDefault(); answerRule(state.activeRuleIdx, 'pass'); break;
      case 'KeyN': e.preventDefault(); answerRule(state.activeRuleIdx, 'fail'); break;
      case 'KeyU': e.preventDefault(); answerRule(state.activeRuleIdx, 'unclear'); break;

      case 'KeyL': e.preventDefault(); toggleOverlay(); break;

      case 'Digit1': case 'Numpad1': selectRuleRow(0); break;
      case 'Digit2': case 'Numpad2': selectRuleRow(1); break;
      case 'Digit3': case 'Numpad3': selectRuleRow(2); break;
      case 'Digit4': case 'Numpad4': selectRuleRow(3); break;
      case 'Digit5': case 'Numpad5': selectRuleRow(4); break;
      case 'Digit6': case 'Numpad6': selectRuleRow(5); break;
      case 'Digit7': case 'Numpad7': selectRuleRow(6); break;

      case 'Period': case 'Comma':
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

      case 'Equal':       case 'NumpadAdd':       if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomIn();  } break;
      case 'Minus':       case 'NumpadSubtract':  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomOut(); } break;
      case 'Digit0':      case 'Numpad0':         if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomFit(); } break;
    }
  });
}

function selectRuleRow(idx) {
  const p = state.punches[state.currentIdx];
  if (!p) return;
  if (idx < 0 || idx >= RULES.length) return;
  if (!ruleAppliesTo(RULES[idx].id, p)) return;
  state.activeRuleIdx = idx;
  renderCurrentPunch();
}

// ============================================================
// Timeline overlay — draw punch segments on seek bar and minimap.
// Hook called by player.js on zoom/metadata change.
// ============================================================
function renderTimelineOverlay() {
  const overlay = document.getElementById('seek-bar-overlay');
  const video = document.getElementById('video-player');
  const duration = video.duration;
  overlay.innerHTML = '';
  if (!duration || duration <= 0) return;

  for (const p of state.punches) {
    const lPct = timeToViewportPct(p.start_sec, duration);
    const rPct = timeToViewportPct(p.end_sec, duration);
    if (rPct < 0 || lPct > 100) continue;
    const seg = document.createElement('div');
    seg.className = 'seek-segment';
    seg.style.left = Math.max(0, lPct) + '%';
    seg.style.width = Math.max(Math.min(100, rPct) - Math.max(0, lPct), 0.15) + '%';
    seg.style.backgroundColor = punchSegmentColor(p);
    overlay.appendChild(seg);
  }

  renderMinimapSegments();
  updateMinimapChrome();
  renderTimeTicks();
}

function renderMinimapSegments() {
  const video = document.getElementById('video-player');
  const duration = video.duration;
  const segContainer = document.getElementById('minimap-segments');
  segContainer.innerHTML = '';
  if (!duration || duration <= 0) return;

  for (const p of state.punches) {
    const seg = document.createElement('div');
    seg.style.position = 'absolute';
    seg.style.top = '0';
    seg.style.height = '100%';
    seg.style.borderRadius = '1px';
    const leftPct = (p.start_sec / duration) * 100;
    const widthPct = ((p.end_sec - p.start_sec) / duration) * 100;
    seg.style.left = leftPct + '%';
    seg.style.width = Math.max(widthPct, 0.3) + '%';
    seg.style.backgroundColor = punchSegmentColor(p);
    seg.style.opacity = '0.7';
    segContainer.appendChild(seg);
  }
}

// Color a punch segment by its labeling status (green=complete,
// yellow=partial, gray=pending) so the timeline shows progress.
function punchSegmentColor(p) {
  const a = state.answers[p.punch_uuid] || {};
  const applicable = RULES.filter(r => ruleAppliesTo(r.id, p));
  const answered = applicable.filter(r => a[r.id]).length;
  if (answered === 0) return '#555';
  if (answered < applicable.length) return '#ffaa33';
  return '#28a745';
}

function updateVideoOverlay() {
  const overlay = document.getElementById('video-overlay');
  const video = document.getElementById('video-player');
  const t = video.currentTime;

  // Video seeks snap to the nearest decoded frame, so asking for exactly
  // start_sec can land one frame earlier. A frame-duration tolerance on
  // each end keeps the overlay visible when you click-to-seek a punch.
  const tol = Math.max(state.frameDuration || 0, 1 / 30);
  const active = state.punches.find(p => t >= p.start_sec - tol && t <= p.end_sec + tol);
  const key = active ? 'p' + active.id : 'none';
  if (overlay.dataset.activeKey === key) return;
  overlay.dataset.activeKey = key;

  overlay.innerHTML = '';
  if (active) {
    const tag = document.createElement('div');
    tag.className = 'video-overlay-tag';
    tag.style.borderLeftColor = punchSegmentColor(active);
    tag.textContent = prettyPunch(active.punch);
    overlay.appendChild(tag);
  }
}

// ============================================================
// Status strip
// ============================================================
function setStatus(text, kind) {
  const el = document.getElementById('punch-load-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === 'error' ? '#e94560' : '#666';
}
