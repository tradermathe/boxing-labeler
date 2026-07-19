// Paste this into Google Apps Script (Extensions > Apps Script in your Google Sheet)
// Then deploy as a Web App with access set to "Anyone"
// All operations use doGet with URL parameters for reliable CORS support

function doPost(e) {
  // Large callout sets overflow GET URLs — Google rejects URLs past a few tens
  // of KB with HTTP 400 before the script even runs — so the callout labeler
  // sends its payload in the POST body instead. action/labeler still ride in
  // the query string; the body is the JSON payload, surfaced as p.payload so
  // the existing GET handler is reused unchanged.
  var p = (e && e.parameter) ? e.parameter : {};
  if (e && e.postData && e.postData.contents) {
    p.payload = e.postData.contents;
  }
  var action = p.action || '';
  var labeler = p.labeler || '1';
  if (action === 'saveCalloutEvents' || action === 'listCalloutEvents') {
    return doGetCalloutEvents(p, labeler, action);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: 'Use GET requests' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function toSeconds(val) {
  if (!val && val !== 0) return 0;
  if (val instanceof Date) {
    return val.getHours() * 3600 + val.getMinutes() * 60 + val.getSeconds() + val.getMilliseconds() / 1000;
  }
  if (typeof val === 'number') {
    if (val < 1) return val * 86400;
    return val;
  }
  var s = String(val).replace(',', '.');
  var parts = s.split(':');
  if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(s) || 0;
}

// Inverse of toSeconds: canonical "MM:SS.mmm" sheet text. Rounds to whole
// milliseconds first so 59.9996s carries to "06:00.000" instead of "05:60.000".
function secondsToSheetTime(sec) {
  var ms = Math.round(sec * 1000);
  var mins = Math.floor(ms / 60000);
  var rem = ms - mins * 60000;
  var whole = Math.floor(rem / 1000);
  var frac = rem - whole * 1000;
  return (mins < 10 ? '0' : '') + mins + ':' + (whole < 10 ? '0' : '') + whole + '.' + ('00' + frac).slice(-3);
}

function findColumns(header) {
  var cols = { id: -1, uuid: -1, videoName: -1, video: -1, trainingType: -1, stance: -1, fighter: -1, angle: -1, punch: -1, start: -1, end: -1 };
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]).toLowerCase().trim();
    if (h === 'id') cols.id = c;
    else if (h === 'punch_uuid') cols.uuid = c;
    else if (h === 'video_name') cols.videoName = c;
    else if (h === 'video_file') cols.video = c;
    else if (h === 'training_type') cols.trainingType = c;
    else if (h === 'stance') cols.stance = c;
    else if (h === 'fighter') cols.fighter = c;
    else if (h === 'angle') cols.angle = c;
    else if (h === 'punch_type' || h === 'label') cols.punch = c;
    else if (h === 'start_sec') cols.start = c;
    else if (h === 'end_sec') cols.end = c;
  }
  return cols;
}

// Ensure the sheet has a `punch_uuid` column and every data row has a UUID.
// Appends the header if missing, stamps UUIDs on any empty cell. Returns the
// possibly-updated (data, cols) tuple so callers can use the fresh UUIDs.
// Idempotent and safe to call on every list request — only writes when
// something is actually missing.
function ensureUuidColumn(sheet, data, cols) {
  if (!data || data.length === 0) return { data: data, cols: cols };

  // Add header column if absent
  if (cols.uuid < 0) {
    var newCol = (data[0] ? data[0].length : 0) + 1;
    sheet.getRange(1, newCol).setValue('punch_uuid');
    cols.uuid = newCol - 1;
    // Reflect the new header in our local data copy
    for (var r = 0; r < data.length; r++) data[r][cols.uuid] = (r === 0 ? 'punch_uuid' : '');
  }

  // Collect rows needing a UUID so we can batch-write (Sheets API rate limits
  // punish lots of single-cell setValue calls on large sheets)
  var missing = [];
  for (var i = 1; i < data.length; i++) {
    var v = data[i][cols.uuid];
    if (v === '' || v == null) missing.push(i);
  }
  if (missing.length === 0) return { data: data, cols: cols };

  // Stamp them. Utilities.getUuid() returns a standard v4 UUID.
  for (var j = 0; j < missing.length; j++) {
    var rowIdx = missing[j];
    var uuid = Utilities.getUuid();
    data[rowIdx][cols.uuid] = uuid;
    sheet.getRange(rowIdx + 1, cols.uuid + 1).setValue(uuid);
  }
  return { data: data, cols: cols };
}

function normalizeDriveUrl(url) {
  if (!url) return '';
  var s = String(url).trim();

  // YouTube: preserve video ID
  // Handles youtube.com/watch?v=ID and youtu.be/ID
  var ytMatch = s.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([\w-]+)/);
  if (ytMatch) return 'https://www.youtube.com/watch?v=' + ytMatch[1];

  // Everything else (Drive, etc.): strip query params as before
  return s.split('?')[0];
}

// Find the next available ID (max existing + 1)
function nextId(data, cols) {
  var maxId = 0;
  for (var i = 1; i < data.length; i++) {
    var val = parseInt(data[i][cols.id]);
    if (!isNaN(val) && val > maxId) maxId = val;
  }
  return maxId + 1;
}

// Find the sheet row number (1-based) for a given ID and optional video name
function findRowById(data, cols, id, video) {
  var targetId = parseInt(id);
  for (var i = 1; i < data.length; i++) {
    if (parseInt(data[i][cols.id]) === targetId) {
      if (video && cols.video >= 0 && normalizeDriveUrl(data[i][cols.video]) !== normalizeDriveUrl(video)) continue;
      return i + 1; // 1-based row number
    }
  }
  return -1;
}

// ============================================================
// Form Rules support — separate sheet ("Form Labels {N}") holds
// per-labeler answers to the form rules. Wide schema: one row per
// punch (keyed on the stable punch_uuid), one column per rule.
// ============================================================
var RULE_IDS = ['rule_hand_extended', 'rule_hand_low', 'rule_hand_ushape', 'rule_hip_rotation', 'rule_rear_heel_lift', 'rule_resting_hand', 'rule_extension', 'rule_punch_height'];

function rulesSheetName(labeler) {
  if (/^\d+$/.test(labeler)) return 'Form Labels ' + labeler;
  return 'Form Labels ' + labeler.charAt(0).toUpperCase() + labeler.slice(1).toLowerCase();
}

// Create or fetch the Form Labels sheet for this labeler, ensuring
// the expected headers exist. Idempotent.
function getOrCreateRulesSheet(labeler) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = rulesSheetName(labeler);
  var sheet = ss.getSheetByName(name);
  var headers = ['id', 'punch_uuid', 'video_file', 'punch_type', 'hand', 'stance',
                 'start_sec', 'end_sec'].concat(RULE_IDS).concat(['labeled_at']);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return { sheet: sheet, headers: headers };
  }
  // Ensure any missing columns are appended (so an older sheet gets new rule cols)
  var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0];
  var existingLower = existing.map(function (h) { return String(h).toLowerCase(); });
  var toAppend = [];
  headers.forEach(function (h) {
    if (existingLower.indexOf(String(h).toLowerCase()) < 0) toAppend.push(h);
  });
  if (toAppend.length > 0) {
    sheet.getRange(1, (sheet.getLastColumn() || 0) + 1, 1, toAppend.length)
         .setValues([toAppend]);
  }
  return { sheet: sheet, headers: sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] };
}

function rulesColIndex(headers, name) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).toLowerCase() === name.toLowerCase()) return i;
  }
  return -1;
}

function doGet(e) {
  var p = e ? e.parameter : {};
  var action = p.action || 'list';
  var labeler = p.labeler || '1';

  // Rules-labeler actions use their own sheet, not the punch sheet.
  if (action === 'listRules' || action === 'saveRule') {
    return doGetRules(p, labeler, action);
  }

  // Bodyshot review actions: cross-video sweep over Combined Data.
  if (action === 'listBodyshots' || action === 'reclassify') {
    return doGetBodyshots(p, action);
  }

  // Orientation labeler actions — separate sheet, frame-level labels of
  // body facing direction. Feeds an ML classifier used by depth-sensitive
  // form rules. `listCombinedVideos` returns the distinct video_name set
  // from Combined Data — used to populate the orientation labeler's
  // dropdown so any already-labelled video can be picked.
  if (action === 'listOrientation' || action === 'saveOrientation' ||
      action === 'deleteOrientation' || action === 'listCombinedVideos') {
    return doGetOrientation(p, labeler, action);
  }

  // Punch-direction labeler (mode of the orientation page). Per-punch
  // facing labels keyed by punch_uuid; feeds 07_punch_directions.py.
  if (action === 'listPunchesForVideo' || action === 'listPunchDirections' ||
      action === 'savePunchDirection'  || action === 'deletePunchDirection') {
    return doGetPunchDirections(p, labeler, action);
  }

  // 22.5°-bin punch-direction labeler — separate sheet, 16 bins. Candidate
  // listing reuses listPunchesForVideo above (the punch_dir_16 page filters
  // to straights client-side); only the label sheet differs.
  if (action === 'listPunchDirections16' || action === 'savePunchDirection16' ||
      action === 'deletePunchDirection16') {
    return doGetPunchDirections16(p, labeler, action);
  }

  // Hip-rotation rubric labeler — separate sheet, ordinal 1–4 score per
  // qualified punch. Candidate listing reuses listPunchesForVideo above
  // (the page filters to the rule's APPLIES_TO types client-side).
  if (action === 'listHipRotation' || action === 'saveHipRotation' ||
      action === 'deleteHipRotation') {
    return doGetHipRotation(p, labeler, action);
  }

  // Impact-frame labeler — separate sheet, one absolute frame index per
  // punch (or a skip reason). Candidate listing reuses listPunchesForVideo
  // above (the impact_frame page takes all punch types).
  if (action === 'listImpactFrames' || action === 'saveImpactFrame' ||
      action === 'deleteImpactFrame') {
    return doGetImpactFrames(p, labeler, action);
  }

  // Callout labeler — separate sheet. One row per called-out punch / combo /
  // defense, keyed by (labeler, video). These annotate the *instruction* a
  // coach app calls out, not the executed punch; they become weak labels for
  // the punch classifier.
  if (action === 'saveCalloutEvents' || action === 'listCalloutEvents') {
    return doGetCalloutEvents(p, labeler, action);
  }

  var sheetName;
  if (labeler === 'combined') {
    sheetName = 'Combined Data';
  } else if (labeler === 'archive') {
    sheetName = COMBINED_ARCHIVE_NAME;
  } else if (/^\d+$/.test(labeler)) {
    sheetName = 'Labeled Data Software ' + labeler;
  } else {
    sheetName = 'Labeled Data ' + labeler.charAt(0).toUpperCase() + labeler.slice(1).toLowerCase();
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: 'Sheet not found: ' + sheetName }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === LIST labels for a video ===
  if (action === 'list' && p.video) {
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    // Ensure every row has a stable punch_uuid before returning anything —
    // backfills on the fly so downstream consumers (rules labeler) always
    // see a uuid to join on.
    var ensured = ensureUuidColumn(sheet, data, cols);
    data = ensured.data; cols = ensured.cols;
    var labels = [];
    for (var i = 1; i < data.length; i++) {
      if (normalizeDriveUrl(data[i][cols.video]) === normalizeDriveUrl(p.video)) {
        labels.push({
          id: parseInt(data[i][cols.id]) || (i + 1),
          punch_uuid: cols.uuid >= 0 ? String(data[i][cols.uuid] || '') : '',
          videoName: data[i][cols.video],
          angle: cols.angle >= 0 ? data[i][cols.angle] : '',
          stance: cols.stance >= 0 ? data[i][cols.stance] : '',
          punch: data[i][cols.punch],
          startTime: cols.start >= 0 ? toSeconds(data[i][cols.start]) : 0,
          endTime: cols.end >= 0 ? toSeconds(data[i][cols.end]) : 0,
        });
      }
    }
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', labels: labels }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === ADD a new label ===
  if (action === 'add') {
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    // Make sure the punch_uuid header exists before we assign row[cols.uuid]
    var ensured = ensureUuidColumn(sheet, data, cols);
    data = ensured.data; cols = ensured.cols;
    var newId = nextId(data, cols);
    var row = new Array(data[0].length).fill('');
    if (cols.id >= 0) row[cols.id] = newId;
    // Client-generated UUID preferred (lets the client cache it before the
    // backend responds). Fall back to server-generated if absent — some
    // older clients don't send one.
    if (cols.uuid >= 0) row[cols.uuid] = p.punchUuid || Utilities.getUuid();
    if (cols.videoName >= 0) row[cols.videoName] = '';
    if (cols.video >= 0) row[cols.video] = normalizeDriveUrl(p.videoName) || '';
    if (cols.trainingType >= 0) row[cols.trainingType] = p.trainingType || '';
    if (cols.stance >= 0) row[cols.stance] = p.stance || '';
    if (cols.fighter >= 0) row[cols.fighter] = p.fighter || '';
    if (cols.angle >= 0) row[cols.angle] = p.angle || '';
    if (cols.punch >= 0) row[cols.punch] = p.punchId || '';
    // Canonical "MM:SS.mmm" text. Safe only because the _sec cells are set
    // to plain-text format before the values land (below) — in a general
    // cell Sheets coerces time-looking strings to serial dates, corrupting
    // the timing on round-trip (why this briefly wrote raw numbers instead).
    if (cols.start >= 0) row[cols.start] = p.startTime ? secondsToSheetTime(toSeconds(p.startTime)) : '';
    if (cols.end >= 0) row[cols.end] = p.endTime ? secondsToSheetTime(toSeconds(p.endTime)) : '';
    // Insert in time order among rows for the same video, instead of appending
    var newVideo = normalizeDriveUrl(p.videoName) || '';
    var newStart = toSeconds(p.startTime);
    var insertBeforeRow = -1;
    if (cols.video >= 0 && cols.start >= 0) {
      for (var i = 1; i < data.length; i++) {
        if (normalizeDriveUrl(data[i][cols.video]) !== newVideo) continue;
        if (toSeconds(data[i][cols.start]) > newStart) {
          insertBeforeRow = i + 1; // 1-based sheet row
          break;
        }
      }
    }
    var targetRow;
    if (insertBeforeRow > 0) {
      sheet.insertRowBefore(insertBeforeRow);
      targetRow = insertBeforeRow;
    } else {
      targetRow = data.length + 1;
      if (targetRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
    }
    if (cols.start >= 0) sheet.getRange(targetRow, cols.start + 1).setNumberFormat('@');
    if (cols.end >= 0) sheet.getRange(targetRow, cols.end + 1).setNumberFormat('@');
    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'ok', action: 'added', id: newId,
        punch_uuid: cols.uuid >= 0 ? row[cols.uuid] : ''
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === UPDATE an existing label by ID ===
  if (action === 'update' && p.id) {
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    var row = findRowById(data, cols, p.id, p.video);
    if (row < 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'ID not found: ' + p.id, sheet: sheetName, cols: cols, headers: String(data[0]) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var updated = [];
    if (p.punchId && cols.punch >= 0) { sheet.getRange(row, cols.punch + 1).setValue(p.punchId); updated.push('punch'); }
    if (p.angle && cols.angle >= 0) { sheet.getRange(row, cols.angle + 1).setValue(p.angle); updated.push('angle'); }
    if (p.trainingType && cols.trainingType >= 0) { sheet.getRange(row, cols.trainingType + 1).setValue(p.trainingType); updated.push('trainingType'); }
    if (p.stance && cols.stance >= 0) { sheet.getRange(row, cols.stance + 1).setValue(p.stance); updated.push('stance'); }
    if (p.fighter && cols.fighter >= 0) { sheet.getRange(row, cols.fighter + 1).setValue(p.fighter); updated.push('fighter'); }
    if (p.startTime && cols.start >= 0) { var sc = sheet.getRange(row, cols.start + 1); sc.setNumberFormat('@'); sc.setValue(secondsToSheetTime(toSeconds(p.startTime))); updated.push('start'); }
    if (p.endTime && cols.end >= 0) { var ec = sheet.getRange(row, cols.end + 1); ec.setNumberFormat('@'); ec.setValue(secondsToSheetTime(toSeconds(p.endTime))); updated.push('end'); }
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', action: 'updated', sheet: sheetName, row: row, cols: cols, updated: updated }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === DELETE a label by ID ===
  if (action === 'delete' && p.id) {
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    var row = findRowById(data, cols, p.id, p.video);
    if (row < 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'ID not found: ' + p.id, sheet: sheetName, video: p.video }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    sheet.deleteRow(row);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', action: 'deleted', sheet: sheetName, row: row }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === Default: status check ===
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'Label receiver is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Rules-labeler endpoints
// ============================================================

// listRules for ?labeler=combined: serve the cross-labeler rule answers
// from the merged Combined Form Labels sheet. Returns an empty list if
// the sheet hasn't been built yet (run MyCorner > Rebuild Combined Form
// Labels). The sheet has one row per (punch_uuid, labeler), so the same
// uuid can appear multiple times; the client merges last-row-wins.
function doListCombinedRules(p) {
  if (!p.video) {
    return jsonOut({ status: 'error', message: 'video parameter required' });
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COMBINED_FORM_LABELS_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    return jsonOut({ status: 'ok', rules: [] });
  }
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var videoCol = rulesColIndex(headers, 'video_file');
  var target = normalizeDriveUrl(p.video);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (videoCol >= 0 && normalizeDriveUrl(data[i][videoCol]) !== target) continue;
    var row = {};
    for (var c = 0; c < headers.length; c++) row[String(headers[c])] = data[i][c];
    out.push(row);
  }
  return jsonOut({ status: 'ok', rules: out });
}

function doGetRules(p, labeler, action) {
  // Read-only "all labelers" view, served from the merged Combined Form
  // Labels sheet (built by rebuildCombinedFormLabels). Saves can't target
  // this view because every row needs an explicit labeler; clients must
  // pick a real labeler ID before writing.
  if (labeler === 'combined') {
    if (action === 'saveRule') {
      return jsonOut({ status: 'error', message: 'saveRule requires a per-labeler id, not combined' });
    }
    return doListCombinedRules(p);
  }

  var info = getOrCreateRulesSheet(labeler);
  var sheet = info.sheet;
  var headers = info.headers;

  // === LIST all rule answers for a video ===
  if (action === 'listRules') {
    if (!p.video) {
      return jsonOut({ status: 'error', message: 'video parameter required' });
    }
    var videoCol = rulesColIndex(headers, 'video_file');
    var data = sheet.getDataRange().getValues();
    var out = [];
    var target = normalizeDriveUrl(p.video);
    for (var i = 1; i < data.length; i++) {
      if (videoCol >= 0 && normalizeDriveUrl(data[i][videoCol]) !== target) continue;
      var row = {};
      for (var c = 0; c < headers.length; c++) row[String(headers[c])] = data[i][c];
      out.push(row);
    }
    return jsonOut({ status: 'ok', rules: out });
  }

  // === SAVE (upsert) a single rule answer, keyed on punch_uuid ===
  if (action === 'saveRule') {
    if (p.punch_uuid == null || p.punch_uuid === '' || !p.rule || !p.answer) {
      return jsonOut({ status: 'error', message: 'punch_uuid, rule, answer required' });
    }
    // Serialize concurrent saveRule calls. Without this, rapid click sequences
    // on the 5 rule rows fire overlapping fetches that each read the sheet
    // before the others have committed, decide "no row yet", and each
    // append a fresh row with their single answer — producing one duplicate
    // per parallel call. The lock forces strict ordering so the first call
    // appends the row and the rest see+update it.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return jsonOut({ status: 'error', message: 'Could not acquire lock; try again' });
    }
    try {
      var uuidCol = rulesColIndex(headers, 'punch_uuid');
      if (uuidCol < 0) return jsonOut({ status: 'error', message: 'form labels sheet missing punch_uuid column' });
      var data = sheet.getDataRange().getValues();
      var targetUuid = String(p.punch_uuid);
      // Collect every row with this uuid. Under the new lock there should
      // never be more than one, but pre-lock duplicates from earlier
      // labeling can exist — merge them into the first match.
      var matches = [];
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][uuidCol]) === targetUuid) matches.push(i);
      }
      var ruleCol = rulesColIndex(headers, p.rule);
      if (ruleCol < 0) {
        return jsonOut({ status: 'error', message: 'unknown rule: ' + p.rule });
      }
      var labeledAtCol = rulesColIndex(headers, 'labeled_at');
      var now = new Date().toISOString();
      var ruleColIdxs = RULE_IDS.map(function (r) { return rulesColIndex(headers, r); });

      if (matches.length === 0) {
        var row = new Array(headers.length).fill('');
        setIf(row, headers, 'id', sheet.getLastRow());
        setIf(row, headers, 'punch_uuid', targetUuid);
        setIf(row, headers, 'video_file', p.video ? normalizeDriveUrl(p.video) : '');
        setIf(row, headers, 'punch_type', p.punch_type || '');
        setIf(row, headers, 'hand', p.hand || '');
        setIf(row, headers, 'stance', p.stance || '');
        setIf(row, headers, 'start_sec', p.start_sec || '');
        setIf(row, headers, 'end_sec', p.end_sec || '');
        row[ruleCol] = p.answer;
        if (labeledAtCol >= 0) row[labeledAtCol] = now;
        sheet.appendRow(row);
        return jsonOut({ status: 'ok', action: 'added', punch_uuid: targetUuid, rule: p.rule });
      }

      var primary = matches[0];
      // Heal pre-existing duplicates: pull any filled rule cells from
      // extras into the primary row, then delete the extras. Non-rule
      // identity cells (video_file, punch_type, etc.) are already the
      // same across duplicates so we don't need to copy them.
      if (matches.length > 1) {
        ruleColIdxs.forEach(function (ci) {
          if (ci < 0) return;
          if (data[primary][ci]) return;
          for (var m = 1; m < matches.length; m++) {
            var v = data[matches[m]][ci];
            if (v) { data[primary][ci] = v; break; }
          }
        });
        // Write the merged rule cells back to the primary row
        var startCol = Math.min.apply(null, ruleColIdxs.filter(function (c) { return c >= 0; }));
        if (isFinite(startCol)) {
          var endCol = Math.max.apply(null, ruleColIdxs);
          var slice = data[primary].slice(startCol, endCol + 1);
          sheet.getRange(primary + 1, startCol + 1, 1, slice.length).setValues([slice]);
        }
        // Delete duplicate rows in descending order so indices stay valid
        for (var m = matches.length - 1; m >= 1; m--) {
          sheet.deleteRow(matches[m] + 1);
        }
      }

      var foundRow = primary + 1;
      sheet.getRange(foundRow, ruleCol + 1).setValue(p.answer);
      if (labeledAtCol >= 0) sheet.getRange(foundRow, labeledAtCol + 1).setValue(now);
      return jsonOut({
        status: 'ok', action: matches.length > 1 ? 'merged+updated' : 'updated',
        row: foundRow, rule: p.rule,
        merged: matches.length > 1 ? matches.length : undefined
      });
    } finally {
      lock.releaseLock();
    }
  }

  return jsonOut({ status: 'error', message: 'Unknown rules action: ' + action });
}

function setIf(row, headers, name, value) {
  var i = rulesColIndex(headers, name);
  if (i >= 0) row[i] = value;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Bodyshot review — temporary tool that lists all
// `lead_bodyshot` / `rear_bodyshot` rows from Combined Data and
// lets a reviewer reclassify each one as a hook/uppercut variant.
// Writes back to BOTH the originating labeler sheet (canonical) and
// Combined Data (so the next sweep filters out already-handled rows
// without waiting for a manual rebuild).
// ============================================================
var BODYSHOT_TYPES = ['lead_bodyshot', 'rear_bodyshot'];
var BODYSHOT_RECLASSIFY_TARGETS = [
  'lead_hook_body', 'rear_hook_body',
  'lead_uppercut_body', 'rear_uppercut_body',
  'jab_body', 'cross_body',
  'lead_bodyshot', 'rear_bodyshot'
];

function doGetBodyshots(p, action) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var combined = ss.getSheetByName(COMBINED_NAME);
  if (!combined) return jsonOut({ status: 'error', message: 'Combined Data sheet not found' });

  if (action === 'listBodyshots') {
    var data = combined.getDataRange().getValues();
    if (data.length < 2) return jsonOut({ status: 'ok', shots: [] });
    var idx = headerIndex(data[0]);
    var shots = [];
    var nameCache = {}; // file_id -> filename, populated lazily via DriveApp
    for (var i = 1; i < data.length; i++) {
      var punch = String(pickFromRow(data[i], idx, 'label') || pickFromRow(data[i], idx, 'punch_type') || '').toLowerCase().trim();
      if (BODYSHOT_TYPES.indexOf(punch) < 0) continue;
      var vfile = pickFromRow(data[i], idx, 'video_file');
      var vname = pickFromRow(data[i], idx, 'video_name');
      // Fill empty video_name from DriveApp (cached per file_id, only ~5
      // unique calls expected for the legacy bodyshot tail). Single-call
      // DriveApp lookups are fast — no 6-min timeout risk at this scale.
      if (!vname || String(vname).trim() === '') {
        var fid = extractFileId(String(vfile));
        if (fid) {
          if (nameCache[fid] === undefined) {
            try { nameCache[fid] = DriveApp.getFileById(fid).getName(); }
            catch (e) { nameCache[fid] = ''; }
          }
          vname = nameCache[fid];
        }
      }
      shots.push({
        id:         pickFromRow(data[i], idx, 'id'),
        punch_uuid: String(pickFromRow(data[i], idx, 'punch_uuid') || ''),
        video_file: vfile,
        video_name: vname,
        punch:      punch,
        start_sec:  toSeconds(pickFromRow(data[i], idx, 'start_sec')),
        end_sec:    toSeconds(pickFromRow(data[i], idx, 'end_sec')),
        stance:     pickFromRow(data[i], idx, 'stance'),
        labeler:    pickFromRow(data[i], idx, 'labeler')
      });
    }
    return jsonOut({ status: 'ok', shots: shots });
  }

  if (action === 'reclassify') {
    if (!p.punch_uuid || !p.new_punch_type) {
      return jsonOut({ status: 'error', message: 'punch_uuid and new_punch_type required' });
    }
    if (BODYSHOT_RECLASSIFY_TARGETS.indexOf(p.new_punch_type) < 0) {
      return jsonOut({ status: 'error', message: 'unknown new_punch_type: ' + p.new_punch_type });
    }
    var targetUuid = String(p.punch_uuid);
    var newType = p.new_punch_type;
    var labelerHits = [];
    var combinedHit = null;
    var archiveHit = null;

    // 1) Labeler sheets — search every "Labeled Data ..." sheet for the uuid.
    //    Only update the punch_type column. Fingerprint identity (start/end)
    //    stays the same. Multiple matches across labeler sheets all get
    //    updated so cross-labeler agreement on the same event is consistent.
    var sheets = ss.getSheets();
    for (var s = 0; s < sheets.length; s++) {
      var sheet = sheets[s];
      var name = sheet.getName();
      if (name.indexOf(LABELER_PREFIX) !== 0) continue;
      if (name === COMBINED_NAME || name === COMBINED_BACKUP_NAME ||
          name === COMBINED_ARCHIVE_NAME) continue;
      if (sheet.getLastRow() < 2) continue;
      var sd = sheet.getDataRange().getValues();
      var sCols = findColumns(sd[0]);
      if (sCols.uuid < 0 || sCols.punch < 0) continue;
      for (var r = 1; r < sd.length; r++) {
        if (String(sd[r][sCols.uuid]) === targetUuid) {
          sheet.getRange(r + 1, sCols.punch + 1).setValue(newType);
          labelerHits.push({ sheet: name, row: r + 1 });
        }
      }
    }

    // 2) Combined Data Archive — frozen historical rows whose source
    //    labeler sheet has been deleted. Rebuild Combined Data carries
    //    Archive rows in verbatim, so without updating Archive a
    //    reclassify of an old row would revert on the next rebuild.
    var archive = ss.getSheetByName(COMBINED_ARCHIVE_NAME);
    if (archive && archive.getLastRow() >= 2) {
      var ad = archive.getDataRange().getValues();
      var aCols = findColumns(ad[0]);
      if (aCols.uuid >= 0 && aCols.punch >= 0) {
        for (var ar = 1; ar < ad.length; ar++) {
          if (String(ad[ar][aCols.uuid]) === targetUuid) {
            archive.getRange(ar + 1, aCols.punch + 1).setValue(newType);
            archiveHit = { row: ar + 1 };
            break;
          }
        }
      }
    }

    // 3) Combined Data — update directly so the bodyshot tool's next
    //    listBodyshots call no longer surfaces this row. Steps 1+2 already
    //    keep the upstream sources correct, but waiting on a manual
    //    "Rebuild Combined Data" run before the queue updates would feel
    //    laggy during a sweep.
    var cdata = combined.getDataRange().getValues();
    var cIdx = headerIndex(cdata[0]);
    var labelCol = cIdx['label'] != null ? cIdx['label'] : cIdx['punch_type'];
    var uuidCol = cIdx['punch_uuid'];
    if (labelCol != null && uuidCol != null) {
      for (var ci = 1; ci < cdata.length; ci++) {
        if (String(cdata[ci][uuidCol]) === targetUuid) {
          combined.getRange(ci + 1, labelCol + 1).setValue(newType);
          combinedHit = { row: ci + 1 };
          break;
        }
      }
    }

    return jsonOut({
      status: 'ok',
      action: 'reclassified',
      punch_uuid: targetUuid,
      new_punch_type: newType,
      labeler_hits: labelerHits,
      archive_hit: archiveHit,
      combined_hit: combinedHit
    });
  }

  return jsonOut({ status: 'error', message: 'Unknown bodyshot action: ' + action });
}

// Build a lowercase header→index map. Reused by bodyshot actions.
function headerIndex(headerRow) {
  var idx = {};
  for (var c = 0; c < headerRow.length; c++) {
    var h = String(headerRow[c]).toLowerCase().trim();
    if (h) idx[h] = c;
  }
  return idx;
}

// ============================================================
// AUTO-MERGE: Labeler sheets → Combined Data
//
// Workflow:
//   1. Labelers label punches in their own "Labeled Data ..." sheet.
//   2. Mathe reviews each row, sets `reviewed = "yes"` on that sheet.
//   3. Mathe runs MyCorner > Rebuild Combined Data (custom menu).
//   4. Combined Data is rebuilt from all reviewed=yes rows. The previous
//      Combined Data is snapshotted to "Combined Data Backup" first.
//
// Why: rows used to be copy-pasted into Combined Data, which dropped
// `punch_uuid` and let `ensureUuidColumn` mint a fresh one — so the same
// punch ended up with different UUIDs in different sheets. Auto-merge
// keeps the labeler sheet as the single source of truth; UUIDs flow
// through verbatim and never diverge.
// ============================================================

var LABELER_PREFIX = 'Labeled Data';
var COMBINED_NAME = 'Combined Data';
var COMBINED_BACKUP_NAME = 'Combined Data Backup';
// Frozen historical rows from before the auto-merge workflow. Their source
// labeler sheets have been deleted, so we treat the archive as already-
// reviewed canonical data and merge it in verbatim on every rebuild.
var COMBINED_ARCHIVE_NAME = 'Combined Data Archive';

// Column order written to Combined Data. Matches the spec in CLAUDE.md:
// downstream notebooks read `video_name` (filename) and `label` (punch type),
// so the rebuild translates the labeler-side schema (`video_file` URL +
// `punch_type`) into that shape. URL→filename comes from buildVideoNameLookup.
var COMBINED_HEADERS = [
  'id', 'video_name', 'video_file', 'training_type', 'stance',
  'fighter', 'angle', 'label', 'start_sec', 'end_sec',
  'labeler', 'reviewed', 'punch_uuid'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MyCorner')
    .addItem('Rebuild Combined Data', 'rebuildCombinedData')
    .addItem('Rebuild Combined Form Labels', 'rebuildCombinedFormLabels')
    .addItem('Replace YouTube URLs with Drive URLs', 'replaceVideoUrls') // ONE-TIME: remove this line after running
    .addToUi();
}

// ═══════════════════════════════════════════════════════════════
// ONE-TIME MIGRATION — delete this whole block after running once
// ═══════════════════════════════════════════════════════════════
// Some early labeler rows store a YouTube URL in `video_file` instead of a
// Drive share URL. The rebuild's resolveVideoName() only understands Drive
// (file_id → DriveApp filename), so those rows end up with blank
// video_name. Swap them here, then run Rebuild Combined Data.
function replaceVideoUrls() {
  var URL_MAP = {
    'https://www.youtube.com/shorts/GFKmYChP8vY': 'https://drive.google.com/file/d/1KbMKrplyD6h-_TqIXpDhP-A5b-MkwANS/view?usp=sharing',
    'https://www.youtube.com/shorts/IBZf2QyFV2Q': 'https://drive.google.com/file/d/1npL0wTvsg0e6XvrUrlg85txbGQFGQYF0/view?usp=sharing',
    'https://www.youtube.com/shorts/bWDOGuj_fZ0': 'https://drive.google.com/file/d/1wjSkaB2asxAQojvWbpb6aUb8Hc4I6ue2/view?usp=sharing',
    'https://www.youtube.com/shorts/hgNjQhHZVKg': 'https://drive.google.com/file/d/1pfs2Z_CTdWVNSlrfoV27EeinKeIJGlmU/view?usp=sharing',
    'https://www.youtube.com/shorts/pwMowI4E7nk': 'https://drive.google.com/file/d/1Os1cDKT88NGpS9qJnDGcz120-HkB7Z-5/view?usp=sharing',
    'https://www.youtube.com/shorts/xIi9ePIdqVM': 'https://drive.google.com/file/d/1p297XJa9E0kFvxbhh4eHpoMcc8YsxzZd/view?usp=sharing',
    'https://www.youtube.com/shorts/8XNwN2O4C9Q': 'https://drive.google.com/file/d/1UJ_4fOamW779XDZ1hYv7pVdbWL81eV_e/view?usp=sharing',
    'https://www.youtube.com/watch?v=8L5Io9TOLk0': 'https://drive.google.com/file/d/168c57-gL4XNRfk7WOqfLA38GLg1Mu_ld/view?usp=sharing',
    'https://www.youtube.com/watch?v=8gTxzGUbYII': 'https://drive.google.com/file/d/1B0pjlghWY03YKywGkIz1T9gGtz5Lunke/view?usp=sharing',
    'https://www.youtube.com/watch?v=PAj6rwaPOsU': 'https://drive.google.com/file/d/1s5PYYue2ErZufTzAFR5XHD7cR2wP6z9W/view?usp=sharing',
    'https://www.youtube.com/watch?v=ZId6Ne20Kag': 'https://drive.google.com/file/d/1opGmMYouPxT33c9h6mV0CGBIAnItzFG9/view?usp=sharing',
    'https://www.youtube.com/watch?v=gHiHeUECLeU': 'https://drive.google.com/file/d/1VXVTsXBHhUIGdI-2A8eWVuC2uX7dT3dJ/view?usp=sharing'
  };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var perSheet = [];
  var unmatched = {};  // YouTube URLs we found but had no mapping for

  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var name = sheet.getName();
    // Skip Combined Data + backup — they're regenerated from sources.
    if (name === COMBINED_NAME || name === COMBINED_BACKUP_NAME) continue;
    if (sheet.getLastRow() < 2) continue;

    var data = sheet.getDataRange().getValues();
    var colIdx = -1;
    for (var c = 0; c < data[0].length; c++) {
      if (String(data[0][c]).toLowerCase().trim() === 'video_file') {
        colIdx = c; break;
      }
    }
    if (colIdx < 0) continue;

    var replaced = 0;
    for (var r = 1; r < data.length; r++) {
      var val = String(data[r][colIdx] || '').trim();
      if (!val) continue;
      if (URL_MAP[val]) {
        sheet.getRange(r + 1, colIdx + 1).setValue(URL_MAP[val]);
        replaced++;
      } else if (val.indexOf('youtube.com') > -1 || val.indexOf('youtu.be') > -1) {
        unmatched[val] = (unmatched[val] || 0) + 1;
      }
    }
    if (replaced > 0) perSheet.push(name + ': ' + replaced);
  }

  var msg = 'Replaced URLs by sheet:\n  ' + (perSheet.length ? perSheet.join('\n  ') : '(none)');
  var unmatchedKeys = Object.keys(unmatched);
  if (unmatchedKeys.length > 0) {
    msg += '\n\nYouTube URLs NOT in mapping (' + unmatchedKeys.length + ' distinct):';
    for (var u = 0; u < unmatchedKeys.length; u++) {
      msg += '\n  ' + unmatched[unmatchedKeys[u]] + '× ' + unmatchedKeys[u];
    }
  }
  SpreadsheetApp.getUi().alert('Replace Video URLs', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}
// ═══════════════════════════════════════════════════════════════
// END ONE-TIME MIGRATION
// ═══════════════════════════════════════════════════════════════

function pickFromRow(rowVals, idx, header) {
  return idx[header] != null ? rowVals[idx[header]] : '';
}

// Extract the Drive file_id from a share URL. Handles all common variants
// (?usp=sharing, ?usp=drive_link, /view, no query string).
function extractFileId(url) {
  if (!url) return null;
  var m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function rebuildCombinedData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Snapshot old Combined Data → Combined Data Backup. One step back is
  // enough: the labeler sheets are the real source of truth, so piling
  // up generations of backups isn't worth the clutter.
  var combined = ss.getSheetByName(COMBINED_NAME);
  if (combined) {
    var prev = ss.getSheetByName(COMBINED_BACKUP_NAME);
    if (prev) ss.deleteSheet(prev);
    combined.copyTo(ss).setName(COMBINED_BACKUP_NAME);
    combined.clear();
  } else {
    combined = ss.insertSheet(COMBINED_NAME);
  }
  combined.getRange(1, 1, 1, COMBINED_HEADERS.length).setValues([COMBINED_HEADERS]);
  combined.setFrozenRows(1);

  var rows = [];
  var skipped = [];
  var archiveCount = 0;

  // video_name: archive rows have it populated; labeler-sheet rows don't
  // (labeler tool only stores URLs). For empty values, resolve filename from
  // Drive via file_id, cached per unique file_id so each video costs exactly
  // one DriveApp call per rebuild regardless of how many rows reference it.
  var nameCache = {};
  function resolveVideoName(vfile) {
    var fid = extractFileId(String(vfile));
    if (!fid) return '';
    if (nameCache[fid] === undefined) {
      try { nameCache[fid] = DriveApp.getFileById(fid).getName(); }
      catch (e) { nameCache[fid] = ''; }
    }
    return nameCache[fid];
  }

  // Archive — frozen historical rows. No `reviewed` filter; everything is
  // canonical. Stamp UUIDs in place on any row missing one so the archive
  // remains a complete record.
  var archive = ss.getSheetByName(COMBINED_ARCHIVE_NAME);
  if (archive && archive.getLastRow() >= 2) {
    var aData = archive.getDataRange().getValues();
    var aCols = findColumns(aData[0]);
    var aEnsured = ensureUuidColumn(archive, aData, aCols);
    aData = aEnsured.data;
    var aIdx = {};
    for (var ac = 0; ac < aData[0].length; ac++) {
      var ah = String(aData[0][ac]).toLowerCase().trim();
      if (ah) aIdx[ah] = ac;
    }
    for (var ar = 1; ar < aData.length; ar++) {
      var aRow = aData[ar];
      // Skip empty rows (trailing blanks in the archive)
      var aVideoFile = pickFromRow(aRow, aIdx, 'video_file');
      if (!aVideoFile) continue;
      var aVideoName = String(pickFromRow(aRow, aIdx, 'video_name') || '').trim();
      if (!aVideoName) aVideoName = resolveVideoName(aVideoFile);
      rows.push([
        pickFromRow(aRow, aIdx, 'id'),
        aVideoName,
        aVideoFile,
        pickFromRow(aRow, aIdx, 'training_type'),
        pickFromRow(aRow, aIdx, 'stance'),
        pickFromRow(aRow, aIdx, 'fighter'),
        pickFromRow(aRow, aIdx, 'angle'),
        pickFromRow(aRow, aIdx, 'punch_type') || pickFromRow(aRow, aIdx, 'label'),
        pickFromRow(aRow, aIdx, 'start_sec'),
        pickFromRow(aRow, aIdx, 'end_sec'),
        pickFromRow(aRow, aIdx, 'labeler'),
        'yes',
        pickFromRow(aRow, aIdx, 'punch_uuid')
      ]);
      archiveCount++;
    }
  }

  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var name = sheet.getName();
    if (name.indexOf(LABELER_PREFIX) !== 0) continue;
    if (name === COMBINED_NAME || name === COMBINED_BACKUP_NAME ||
        name === COMBINED_ARCHIVE_NAME) continue;
    if (sheet.getLastRow() < 2) continue;

    // Make sure the labeler sheet has a punch_uuid column with every row
    // populated — guarantees we never carry an empty UUID into Combined.
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    var ensured = ensureUuidColumn(sheet, data, cols);
    data = ensured.data; cols = ensured.cols;

    // Header lookup, case-insensitive (handles 'Angle' vs 'angle' etc.)
    var idx = {};
    for (var c = 0; c < data[0].length; c++) {
      var h = String(data[0][c]).toLowerCase().trim();
      if (h) idx[h] = c;
    }
    if (idx['reviewed'] == null) {
      skipped.push(name + ' (no `reviewed` column)');
      continue;
    }

    var labelerName = name.substring(LABELER_PREFIX.length).trim();

    for (var r = 1; r < data.length; r++) {
      var rowVals = data[r];
      var flag = String(rowVals[idx['reviewed']] || '').toLowerCase().trim();
      if (flag !== 'yes') continue;

      var lVideoFile = pickFromRow(rowVals, idx, 'video_file');
      var lVideoName = String(pickFromRow(rowVals, idx, 'video_name') || '').trim();
      if (!lVideoName) lVideoName = resolveVideoName(lVideoFile);
      rows.push([
        pickFromRow(rowVals, idx, 'id'),
        lVideoName,
        lVideoFile,
        pickFromRow(rowVals, idx, 'training_type'),
        pickFromRow(rowVals, idx, 'stance'),
        pickFromRow(rowVals, idx, 'fighter'),
        pickFromRow(rowVals, idx, 'angle'),
        pickFromRow(rowVals, idx, 'punch_type') || pickFromRow(rowVals, idx, 'label'),
        pickFromRow(rowVals, idx, 'start_sec'),
        pickFromRow(rowVals, idx, 'end_sec'),
        labelerName,
        'yes',
        pickFromRow(rowVals, idx, 'punch_uuid')
      ]);
    }
  }

  // Dedup by punch_uuid. Run "Unify Duplicate UUIDs" once first so the same
  // logical event has the same UUID across Archive and labeler sheets.
  var seenU = {}, deduped = [], dupesDropped = 0;
  for (var di = 0; di < rows.length; di++) {
    var u = rows[di][12]; // punch_uuid (last column in COMBINED_HEADERS)
    if (u && seenU[u]) { dupesDropped++; continue; }
    if (u) seenU[u] = true;
    deduped.push(rows[di]);
  }
  rows = deduped;

  if (rows.length > 0) {
    combined.getRange(2, 1, rows.length, COMBINED_HEADERS.length).setValues(rows);
  }

  var msg = 'Wrote ' + rows.length + ' rows ('
            + dupesDropped + ' duplicates dropped).\n'
            + 'Resolved ' + Object.keys(nameCache).length + ' video_name(s) via Drive.\n'
            + 'Backup → ' + COMBINED_BACKUP_NAME + '.';
  if (skipped.length > 0) msg += '\n\nSkipped:\n  ' + skipped.join('\n  ');
  SpreadsheetApp.getUi().alert('Rebuild Combined Data', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

// ============================================================
// AUTO-MERGE: Form Labels sheets → Combined Form Labels
//
// Mirrors rebuildCombinedData but for the per-labeler rule answers:
//   sources:  every "Form Labels {Name}" sheet
//   target:   "Combined Form Labels" (prev → "Combined Form Labels Backup")
//   key:      (punch_uuid, labeler) — same uuid intentionally appears
//             across labelers (inter-rater data); only collapse same-uuid
//             same-labeler duplicates.
//
// Header mapping is by name, not column position, because John's and
// Arianne's form sheets historically have the rule columns in different
// orders. Missing columns in a source sheet just leave that cell blank
// in the output.
// ============================================================
var FORM_LABELS_PREFIX = 'Form Labels';
var COMBINED_FORM_LABELS_NAME = 'Combined Form Labels';
var COMBINED_FORM_LABELS_BACKUP_NAME = 'Combined Form Labels Backup';

var COMBINED_FORM_LABELS_HEADERS = [
  'id', 'punch_uuid', 'video_file', 'punch_type', 'hand', 'stance',
  'start_sec', 'end_sec',
  'rule_hand_extended', 'rule_hand_low', 'rule_hand_ushape',
  'rule_hip_rotation', 'rule_rear_heel_lift', 'rule_resting_hand',
  'rule_extension', 'rule_punch_height',
  'labeled_at', 'labeler'
];

function rebuildCombinedFormLabels() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var combined = ss.getSheetByName(COMBINED_FORM_LABELS_NAME);
  if (combined) {
    var prev = ss.getSheetByName(COMBINED_FORM_LABELS_BACKUP_NAME);
    if (prev) ss.deleteSheet(prev);
    combined.copyTo(ss).setName(COMBINED_FORM_LABELS_BACKUP_NAME);
    combined.clear();
  } else {
    combined = ss.insertSheet(COMBINED_FORM_LABELS_NAME);
  }
  combined.getRange(1, 1, 1, COMBINED_FORM_LABELS_HEADERS.length)
          .setValues([COMBINED_FORM_LABELS_HEADERS]);
  combined.setFrozenRows(1);

  var rows = [];
  var skipped = [];
  var sheets = ss.getSheets();

  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var name = sheet.getName();
    if (name.indexOf(FORM_LABELS_PREFIX) !== 0) continue;
    if (name === COMBINED_FORM_LABELS_NAME ||
        name === COMBINED_FORM_LABELS_BACKUP_NAME) continue;
    if (sheet.getLastRow() < 2) continue;

    var data = sheet.getDataRange().getValues();
    var idx = {};
    for (var c = 0; c < data[0].length; c++) {
      var h = String(data[0][c]).toLowerCase().trim();
      if (h) idx[h] = c;
    }
    if (idx['punch_uuid'] == null) {
      skipped.push(name + ' (no punch_uuid column)');
      continue;
    }

    var labelerName = name.substring(FORM_LABELS_PREFIX.length).trim();

    for (var r = 1; r < data.length; r++) {
      var rowVals = data[r];
      var uuid = rowVals[idx['punch_uuid']];
      if (!uuid) continue;
      rows.push([
        pickFromRow(rowVals, idx, 'id'),
        uuid,
        pickFromRow(rowVals, idx, 'video_file'),
        pickFromRow(rowVals, idx, 'punch_type'),
        pickFromRow(rowVals, idx, 'hand'),
        pickFromRow(rowVals, idx, 'stance'),
        pickFromRow(rowVals, idx, 'start_sec'),
        pickFromRow(rowVals, idx, 'end_sec'),
        pickFromRow(rowVals, idx, 'rule_hand_extended'),
        pickFromRow(rowVals, idx, 'rule_hand_low'),
        pickFromRow(rowVals, idx, 'rule_hand_ushape'),
        pickFromRow(rowVals, idx, 'rule_hip_rotation'),
        pickFromRow(rowVals, idx, 'rule_rear_heel_lift'),
        pickFromRow(rowVals, idx, 'rule_resting_hand'),
        pickFromRow(rowVals, idx, 'rule_extension'),
        pickFromRow(rowVals, idx, 'rule_punch_height'),
        pickFromRow(rowVals, idx, 'labeled_at'),
        labelerName
      ]);
    }
  }

  // Dedup by (punch_uuid, labeler). Multi-labeler-per-uuid is the whole
  // point, so we only collapse exact duplicates within one labeler's sheet.
  var seen = {}, deduped = [], dupesDropped = 0;
  for (var di = 0; di < rows.length; di++) {
    var key = rows[di][1] + '|' + rows[di][17];
    if (seen[key]) { dupesDropped++; continue; }
    seen[key] = true;
    deduped.push(rows[di]);
  }
  rows = deduped;

  for (var i = 0; i < rows.length; i++) rows[i][0] = i + 1;

  if (rows.length > 0) {
    combined.getRange(2, 1, rows.length, COMBINED_FORM_LABELS_HEADERS.length)
            .setValues(rows);
  }

  var msg = 'Wrote ' + rows.length + ' rows ('
            + dupesDropped + ' duplicates dropped).\n'
            + 'Backup → ' + COMBINED_FORM_LABELS_BACKUP_NAME + '.';
  if (skipped.length > 0) msg += '\n\nSkipped:\n  ' + skipped.join('\n  ');
  SpreadsheetApp.getUi().alert(
    'Rebuild Combined Form Labels', msg,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================================================
// Orientation labeler — frame-level facing direction labels
// ============================================================

var ORIENTATION_SHEET_NAME = 'Orientation Labels';
var ORIENTATION_HEADERS = ['ts', 'labeler', 'video', 'round', 'frame', 'label', 'deleted'];
var ORIENTATION_VALID_BINS = [-180, -135, -90, -45, 0, 45, 90, 135, 180];

function getOrCreateOrientationSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ORIENTATION_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(ORIENTATION_SHEET_NAME);
    sh.appendRow(ORIENTATION_HEADERS);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(ORIENTATION_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function orientationHeaderIndex(headerRow) {
  var idx = {};
  for (var i = 0; i < headerRow.length; i++) idx[String(headerRow[i])] = i;
  return idx;
}

function doGetOrientation(p, labeler, action) {
  // === LIST distinct video_name values from Combined Data ===
  // Lets the orientation labeler's dropdown show every video already in
  // the punch-labels system, including ones without glove caches.
  if (action === 'listCombinedVideos') {
    var cd = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Combined Data');
    if (!cd) return jsonOut({ status: 'ok', videos: [] });
    var cdData = cd.getDataRange().getValues();
    if (cdData.length <= 1) return jsonOut({ status: 'ok', videos: [] });
    var cdCols = findColumns(cdData[0]);
    if (cdCols.videoName < 0) return jsonOut({ status: 'ok', videos: [] });
    var counts = {};
    for (var r = 1; r < cdData.length; r++) {
      var name = String(cdData[r][cdCols.videoName] || '').trim();
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }
    var videos = Object.keys(counts).map(function (n) {
      return { stem: n.replace(/\.(mp4|mov|webm)$/i, ''), name: n, n_labels: counts[n] };
    }).sort(function (a, b) { return b.n_labels - a.n_labels; });
    return jsonOut({ status: 'ok', videos: videos });
  }

  var sh = getOrCreateOrientationSheet();
  var data = sh.getDataRange().getValues();
  var idx = orientationHeaderIndex(data[0]);

  // === LIST labels for a video (optionally filtered by labeler) ===
  if (action === 'listOrientation') {
    var video = p.video || '';
    var filterLabeler = p.labeler || '';
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (String(r[idx.deleted]) === '1') continue;
      if (video && r[idx.video] !== video) continue;
      if (filterLabeler && r[idx.labeler] !== filterLabeler) continue;
      rows.push({
        ts: r[idx.ts],
        labeler: r[idx.labeler],
        video: r[idx.video],
        round: Number(r[idx.round]),
        frame: Number(r[idx.frame]),
        label: r[idx.label] === '' ? null : Number(r[idx.label])
      });
    }
    return jsonOut({ status: 'ok', rows: rows });
  }

  // === SAVE a label (insert; supersedes any prior row for same key) ===
  if (action === 'saveOrientation') {
    var required = ['labeler', 'video', 'round', 'frame'];
    for (var k = 0; k < required.length; k++) {
      if (p[required[k]] === undefined || p[required[k]] === '') {
        return jsonOut({ status: 'error', message: 'missing field: ' + required[k] });
      }
    }
    var lbl = p.label;
    if (lbl === undefined || lbl === '' || lbl === 'null') {
      lbl = '';
    } else if (ORIENTATION_VALID_BINS.indexOf(Number(lbl)) === -1) {
      return jsonOut({ status: 'error', message: 'invalid label: ' + lbl });
    } else {
      lbl = Number(lbl);
      if (lbl === 180) lbl = -180;
    }
    // Mark any prior row for the same (labeler, video, round, frame) deleted
    for (var i2 = 1; i2 < data.length; i2++) {
      if (String(data[i2][idx.deleted]) === '1') continue;
      if (data[i2][idx.labeler] !== p.labeler) continue;
      if (data[i2][idx.video] !== p.video) continue;
      if (Number(data[i2][idx.round]) !== Number(p.round)) continue;
      if (Number(data[i2][idx.frame]) !== Number(p.frame)) continue;
      sh.getRange(i2 + 1, idx.deleted + 1).setValue('1');
    }
    sh.appendRow([
      new Date().toISOString(),
      p.labeler,
      p.video,
      Number(p.round),
      Number(p.frame),
      lbl,
      ''
    ]);
    return jsonOut({ status: 'ok' });
  }

  // === DELETE: mark all current rows for the key as deleted ===
  if (action === 'deleteOrientation') {
    var found = 0;
    for (var i3 = 1; i3 < data.length; i3++) {
      if (String(data[i3][idx.deleted]) === '1') continue;
      if (data[i3][idx.labeler] !== p.labeler) continue;
      if (data[i3][idx.video] !== p.video) continue;
      if (Number(data[i3][idx.round]) !== Number(p.round)) continue;
      if (Number(data[i3][idx.frame]) !== Number(p.frame)) continue;
      sh.getRange(i3 + 1, idx.deleted + 1).setValue('1');
      found++;
    }
    return jsonOut({ status: 'ok', deleted: found });
  }

  return jsonOut({ status: 'error', message: 'unknown orientation action: ' + action });
}

// ============================================================
// Punch Direction labeling — second mode of the orientation labeler.
//
// Frame mode (existing) labels facing direction at 5s-bucket frames.
// Punch mode (new) labels facing direction once per punch (keyed by
// punch_uuid from Combined Data). Used to test whether the inter-ankle
// arrow predicts "where the enemy is" — see boxing_ai/orientation_model/
// 07_punch_directions.py.
// ============================================================

var PUNCH_DIR_SHEET_NAME = 'Punch Directions';
// `label_secondary` is the optional second bin for "soft" labels expressed
// as a 50/50 split between two bins (e.g., a punch that's between +45° and
// +90° is labelled label=45, label_secondary=90 → analysis uses 67.5° as
// the continuous GT angle). Blank means single-bin / 100% confident.
var PUNCH_DIR_HEADERS = ['ts', 'labeler', 'punch_uuid', 'video', 'label', 'deleted', 'label_secondary'];
var PUNCH_DIR_VALID_BINS = ORIENTATION_VALID_BINS;   // reuse the 8-bin convention

function getOrCreatePunchDirectionSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PUNCH_DIR_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(PUNCH_DIR_SHEET_NAME);
    sh.appendRow(PUNCH_DIR_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(PUNCH_DIR_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  // Auto-migrate: if `label_secondary` column is missing, add it at the end
  // so the 2600+ existing rows stay untouched (they get a blank cell which
  // the analysis treats as "no secondary, 100% confident").
  var headerRow = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  var hasSecondary = headerRow.some(function (h) { return String(h) === 'label_secondary'; });
  if (!hasSecondary) {
    sh.getRange(1, headerRow.length + 1).setValue('label_secondary');
  }
  return sh;
}

function punchDirHeaderIndex(headerRow) {
  var idx = {};
  for (var i = 0; i < headerRow.length; i++) idx[String(headerRow[i])] = i;
  return idx;
}

// Round-marker labels in Combined Data — never labelable as punches.
var NON_PUNCH_LABELS = ['round_start', 'round_end', 'rest_start', 'rest_end'];
function isPunchLabel(lbl) {
  if (lbl === null || lbl === undefined || lbl === '') return false;
  var s = String(lbl).toLowerCase();
  return NON_PUNCH_LABELS.indexOf(s) === -1;
}

function doGetPunchDirections(p, labeler, action) {
  // === LIST every punch (from Combined Data) for a given video, with
  //     stance + punch_type + start/end seconds so the labeler can seek. ===
  // `video` here is the video_name (filename, with or without extension).
  // We also accept a stem match so the orientation labeler — which uses
  // stems from videos.json — can pass its stem directly.
  if (action === 'listPunchesForVideo') {
    var vid = String(p.video || '').trim();
    if (!vid) return jsonOut({ status: 'error', message: 'video required' });
    var cd = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Combined Data');
    if (!cd) return jsonOut({ status: 'ok', punches: [] });
    var cdData = cd.getDataRange().getValues();
    if (cdData.length <= 1) return jsonOut({ status: 'ok', punches: [] });
    var cdIdx = punchDirHeaderIndex(cdData[0]);
    var requiredCols = ['video_name', 'label', 'start_sec', 'end_sec', 'punch_uuid'];
    for (var ci = 0; ci < requiredCols.length; ci++) {
      if (cdIdx[requiredCols[ci]] === undefined) {
        return jsonOut({ status: 'error',
                         message: 'Combined Data missing column: ' + requiredCols[ci] });
      }
    }
    var vidLc = vid.toLowerCase();
    var punches = [];
    for (var i = 1; i < cdData.length; i++) {
      var row = cdData[i];
      var vn = String(row[cdIdx.video_name] || '').trim();
      if (!vn) continue;
      // Match: exact OR extension-stripped name == passed stem.
      var vnLc = vn.toLowerCase();
      var stemLc = vnLc.replace(/\.(mp4|mov|webm|m4v|avi)$/i, '');
      if (vnLc !== vidLc && stemLc !== vidLc) continue;
      var lbl = row[cdIdx.label];
      if (!isPunchLabel(lbl)) continue;
      var uuid = String(row[cdIdx.punch_uuid] || '').trim();
      if (!uuid) continue;
      punches.push({
        punch_uuid: uuid,
        video_name: vn,
        label: String(lbl),
        stance: cdIdx.stance !== undefined ? String(row[cdIdx.stance] || '') : '',
        start_sec: row[cdIdx.start_sec],
        end_sec: row[cdIdx.end_sec],
        id: cdIdx.id !== undefined ? row[cdIdx.id] : '',
      });
    }
    return jsonOut({ status: 'ok', punches: punches });
  }

  var sh = getOrCreatePunchDirectionSheet();
  var data = sh.getDataRange().getValues();
  var idx = punchDirHeaderIndex(data[0]);

  // === LIST direction labels (optionally filtered by labeler / video) ===
  if (action === 'listPunchDirections') {
    var video = p.video || '';
    var filterLabeler = p.labeler || '';
    var rows = [];
    var hasSecondaryCol = idx.label_secondary !== undefined;
    for (var li = 1; li < data.length; li++) {
      var lr = data[li];
      if (String(lr[idx.deleted]) === '1') continue;
      if (video && lr[idx.video] !== video) continue;
      if (filterLabeler && lr[idx.labeler] !== filterLabeler) continue;
      var sec = hasSecondaryCol ? lr[idx.label_secondary] : '';
      rows.push({
        ts: lr[idx.ts],
        labeler: lr[idx.labeler],
        punch_uuid: lr[idx.punch_uuid],
        video: lr[idx.video],
        label: lr[idx.label] === '' ? null : Number(lr[idx.label]),
        label_secondary: (sec === '' || sec == null) ? null : Number(sec),
      });
    }
    return jsonOut({ status: 'ok', rows: rows });
  }

  // === SAVE a label keyed by (labeler, punch_uuid). Supersedes prior. ===
  // Optional `label_secondary` param: when set, this is a "soft" label that
  // the analysis treats as a 50/50 split between (label, label_secondary).
  // Blank/missing = single-bin / 100% confident.
  if (action === 'savePunchDirection') {
    var required = ['labeler', 'punch_uuid', 'video'];
    for (var k = 0; k < required.length; k++) {
      if (p[required[k]] === undefined || p[required[k]] === '') {
        return jsonOut({ status: 'error', message: 'missing field: ' + required[k] });
      }
    }
    function _coerceLabel(v) {
      if (v === undefined || v === '' || v === 'null') return '';
      if (PUNCH_DIR_VALID_BINS.indexOf(Number(v)) === -1) return null; // invalid
      var n = Number(v);
      if (n === 180) n = -180;
      return n;
    }
    var lbl = _coerceLabel(p.label);
    if (lbl === null) return jsonOut({ status: 'error', message: 'invalid label: ' + p.label });
    var lbl2 = _coerceLabel(p.label_secondary);
    if (lbl2 === null) return jsonOut({ status: 'error', message: 'invalid label_secondary: ' + p.label_secondary });
    // Soft labels only make sense when both bins are present and different.
    if (lbl2 !== '' && (lbl === '' || lbl === lbl2)) lbl2 = '';

    for (var i2 = 1; i2 < data.length; i2++) {
      if (String(data[i2][idx.deleted]) === '1') continue;
      if (data[i2][idx.labeler] !== p.labeler) continue;
      if (data[i2][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i2 + 1, idx.deleted + 1).setValue('1');
    }
    // Build the row by header position so additions/reorderings don't break.
    var newRow = [];
    var headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    for (var c = 0; c < headerRow.length; c++) {
      var col = String(headerRow[c]);
      if (col === 'ts') newRow.push(new Date().toISOString());
      else if (col === 'labeler') newRow.push(p.labeler);
      else if (col === 'punch_uuid') newRow.push(p.punch_uuid);
      else if (col === 'video') newRow.push(p.video);
      else if (col === 'label') newRow.push(lbl);
      else if (col === 'label_secondary') newRow.push(lbl2);
      else if (col === 'deleted') newRow.push('');
      else newRow.push('');
    }
    sh.appendRow(newRow);
    return jsonOut({ status: 'ok' });
  }

  // === DELETE: mark every current row for (labeler, punch_uuid) deleted ===
  if (action === 'deletePunchDirection') {
    var found = 0;
    for (var i3 = 1; i3 < data.length; i3++) {
      if (String(data[i3][idx.deleted]) === '1') continue;
      if (data[i3][idx.labeler] !== p.labeler) continue;
      if (data[i3][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i3 + 1, idx.deleted + 1).setValue('1');
      found++;
    }
    return jsonOut({ status: 'ok', deleted: found });
  }

  return jsonOut({ status: 'error', message: 'unknown punch-direction action: ' + action });
}

// ── 22.5° punch-direction labeler ─────────────────────────────────────────
// Same per-(labeler, punch_uuid) model as Punch Directions, but `label` is
// one of 16 bins (22.5° steps) rather than 8. Lives in its own sheet so the
// two labeling efforts never collide. No `label_secondary` — the finer bins
// make the soft-label hack unnecessary. Candidate listing reuses the existing
// listPunchesForVideo handler (the page filters to straight punches itself).
var PUNCH_DIR16_SHEET_NAME = 'Punch Directions 16';
var PUNCH_DIR16_HEADERS = ['ts', 'labeler', 'punch_uuid', 'video', 'label', 'deleted'];
var PUNCH_DIR16_VALID_BINS = [
  0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180,
  -22.5, -45, -67.5, -90, -112.5, -135, -157.5, -180,
];

// ── Hip-rotation rubric labeler — ordinal 1–4 score per qualified punch.
// Separate sheet; candidate listing reuses listPunchesForVideo (the page
// filters to the hip_rotation rule's APPLIES_TO types client-side). Stores
// punch_type + start/end so the label set is self-describing for the
// downstream metric-vs-label analysis (no join back to Combined Data needed).
var HIP_ROTATION_SHEET_NAME = 'Hip Rotation Rubric';
var HIP_ROTATION_HEADERS = ['ts', 'labeler', 'punch_uuid', 'video', 'punch_type', 'start_sec', 'end_sec', 'label', 'deleted'];
var HIP_ROTATION_VALID_SCORES = [1, 2, 3, 4];

function getOrCreateHipRotationSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(HIP_ROTATION_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(HIP_ROTATION_SHEET_NAME);
    sh.appendRow(HIP_ROTATION_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(HIP_ROTATION_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function doGetHipRotation(p, labeler, action) {
  var sh = getOrCreateHipRotationSheet();
  var data = sh.getDataRange().getValues();
  var idx = punchDirHeaderIndex(data[0]);

  // === LIST rubric labels (optionally filtered by labeler / video) ===
  if (action === 'listHipRotation') {
    var video = p.video || '';
    var filterLabeler = p.labeler || '';
    var rows = [];
    for (var li = 1; li < data.length; li++) {
      var lr = data[li];
      if (String(lr[idx.deleted]) === '1') continue;
      if (video && lr[idx.video] !== video) continue;
      if (filterLabeler && lr[idx.labeler] !== filterLabeler) continue;
      rows.push({
        ts: lr[idx.ts],
        labeler: lr[idx.labeler],
        punch_uuid: lr[idx.punch_uuid],
        video: lr[idx.video],
        punch_type: lr[idx.punch_type],
        start_sec: lr[idx.start_sec],
        end_sec: lr[idx.end_sec],
        label: lr[idx.label] === '' ? null : Number(lr[idx.label]),
      });
    }
    return jsonOut({ status: 'ok', rows: rows });
  }

  // === SAVE a label keyed by (labeler, punch_uuid). Supersedes prior. ===
  // Blank/missing label = "skip" (can't tell), stored as an empty cell.
  if (action === 'saveHipRotation') {
    var required = ['labeler', 'punch_uuid', 'video'];
    for (var k = 0; k < required.length; k++) {
      if (p[required[k]] === undefined || p[required[k]] === '') {
        return jsonOut({ status: 'error', message: 'missing field: ' + required[k] });
      }
    }
    var lbl;
    if (p.label === undefined || p.label === '' || p.label === 'null') {
      lbl = '';   // skip / can't tell
    } else if (HIP_ROTATION_VALID_SCORES.indexOf(Number(p.label)) === -1) {
      return jsonOut({ status: 'error', message: 'invalid label: ' + p.label });
    } else {
      lbl = Number(p.label);
    }

    for (var i2 = 1; i2 < data.length; i2++) {
      if (String(data[i2][idx.deleted]) === '1') continue;
      if (data[i2][idx.labeler] !== p.labeler) continue;
      if (data[i2][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i2 + 1, idx.deleted + 1).setValue('1');
    }
    var newRow = [];
    var headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    for (var c = 0; c < headerRow.length; c++) {
      var col = String(headerRow[c]);
      if (col === 'ts') newRow.push(new Date().toISOString());
      else if (col === 'labeler') newRow.push(p.labeler);
      else if (col === 'punch_uuid') newRow.push(p.punch_uuid);
      else if (col === 'video') newRow.push(p.video);
      else if (col === 'punch_type') newRow.push(p.punch_type || '');
      else if (col === 'start_sec') newRow.push(p.start_sec === undefined ? '' : p.start_sec);
      else if (col === 'end_sec') newRow.push(p.end_sec === undefined ? '' : p.end_sec);
      else if (col === 'label') newRow.push(lbl);
      else if (col === 'deleted') newRow.push('');
      else newRow.push('');
    }
    sh.appendRow(newRow);
    return jsonOut({ status: 'ok' });
  }

  // === DELETE: mark every current row for (labeler, punch_uuid) deleted ===
  if (action === 'deleteHipRotation') {
    var found = 0;
    for (var i3 = 1; i3 < data.length; i3++) {
      if (String(data[i3][idx.deleted]) === '1') continue;
      if (data[i3][idx.labeler] !== p.labeler) continue;
      if (data[i3][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i3 + 1, idx.deleted + 1).setValue('1');
      found++;
    }
    return jsonOut({ status: 'ok', deleted: found });
  }

  return jsonOut({ status: 'error', message: 'unknown hip-rotation action: ' + action });
}

function getOrCreatePunchDirection16Sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PUNCH_DIR16_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(PUNCH_DIR16_SHEET_NAME);
    sh.appendRow(PUNCH_DIR16_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(PUNCH_DIR16_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function doGetPunchDirections16(p, labeler, action) {
  var sh = getOrCreatePunchDirection16Sheet();
  var data = sh.getDataRange().getValues();
  var idx = punchDirHeaderIndex(data[0]);

  // === LIST direction labels (optionally filtered by labeler / video) ===
  if (action === 'listPunchDirections16') {
    var video = p.video || '';
    var filterLabeler = p.labeler || '';
    var rows = [];
    for (var li = 1; li < data.length; li++) {
      var lr = data[li];
      if (String(lr[idx.deleted]) === '1') continue;
      if (video && lr[idx.video] !== video) continue;
      if (filterLabeler && lr[idx.labeler] !== filterLabeler) continue;
      rows.push({
        ts: lr[idx.ts],
        labeler: lr[idx.labeler],
        punch_uuid: lr[idx.punch_uuid],
        video: lr[idx.video],
        label: lr[idx.label] === '' ? null : Number(lr[idx.label]),
      });
    }
    return jsonOut({ status: 'ok', rows: rows });
  }

  // === SAVE a label keyed by (labeler, punch_uuid). Supersedes prior. ===
  // Blank/missing label = "skip" (unclear), stored as an empty cell.
  if (action === 'savePunchDirection16') {
    var required = ['labeler', 'punch_uuid', 'video'];
    for (var k = 0; k < required.length; k++) {
      if (p[required[k]] === undefined || p[required[k]] === '') {
        return jsonOut({ status: 'error', message: 'missing field: ' + required[k] });
      }
    }
    var lbl;
    if (p.label === undefined || p.label === '' || p.label === 'null') {
      lbl = '';   // skip / unclear
    } else if (PUNCH_DIR16_VALID_BINS.indexOf(Number(p.label)) === -1) {
      return jsonOut({ status: 'error', message: 'invalid label: ' + p.label });
    } else {
      lbl = Number(p.label);
      if (lbl === 180) lbl = -180;   // collapse the single straight-back bin
    }

    for (var i2 = 1; i2 < data.length; i2++) {
      if (String(data[i2][idx.deleted]) === '1') continue;
      if (data[i2][idx.labeler] !== p.labeler) continue;
      if (data[i2][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i2 + 1, idx.deleted + 1).setValue('1');
    }
    var newRow = [];
    var headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    for (var c = 0; c < headerRow.length; c++) {
      var col = String(headerRow[c]);
      if (col === 'ts') newRow.push(new Date().toISOString());
      else if (col === 'labeler') newRow.push(p.labeler);
      else if (col === 'punch_uuid') newRow.push(p.punch_uuid);
      else if (col === 'video') newRow.push(p.video);
      else if (col === 'label') newRow.push(lbl);
      else if (col === 'deleted') newRow.push('');
      else newRow.push('');
    }
    sh.appendRow(newRow);
    return jsonOut({ status: 'ok' });
  }

  // === DELETE: mark every current row for (labeler, punch_uuid) deleted ===
  if (action === 'deletePunchDirection16') {
    var found = 0;
    for (var i3 = 1; i3 < data.length; i3++) {
      if (String(data[i3][idx.deleted]) === '1') continue;
      if (data[i3][idx.labeler] !== p.labeler) continue;
      if (data[i3][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i3 + 1, idx.deleted + 1).setValue('1');
      found++;
    }
    return jsonOut({ status: 'ok', deleted: found });
  }

  return jsonOut({ status: 'error', message: 'unknown punch-direction-16 action: ' + action });
}

// ── Impact-frame labeler ──────────────────────────────────────────────────
// Same per-(labeler, punch_uuid) model as Punch Directions 16, but the label
// is the absolute frame index (in the source video) of the punch's turnaround
// frame (forward motion → back to guard; usually bag contact, sometimes 1–2
// frames later). A punch is either labelled (impact_frame set, skip_reason
// empty) or skipped (impact_frame empty, skip_reason set). `fps` records the
// frame rate the page used for the time↔frame mapping, so downstream can
// round-trip to seconds without re-deriving it. Candidate listing reuses
// listPunchesForVideo.
var IMPACT_FRAME_SHEET_NAME = 'Impact Frames';
var IMPACT_FRAME_HEADERS = ['ts', 'labeler', 'punch_uuid', 'video', 'impact_frame', 'fps', 'skip_reason', 'deleted'];
var IMPACT_FRAME_SKIP_REASONS = ['occluded', 'unclear', 'no_punch', 'bad_clip'];

function getOrCreateImpactFrameSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(IMPACT_FRAME_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(IMPACT_FRAME_SHEET_NAME);
    sh.appendRow(IMPACT_FRAME_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(IMPACT_FRAME_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function doGetImpactFrames(p, labeler, action) {
  var sh = getOrCreateImpactFrameSheet();
  var data = sh.getDataRange().getValues();
  var idx = punchDirHeaderIndex(data[0]);

  // === LIST impact labels (optionally filtered by labeler / video) ===
  if (action === 'listImpactFrames') {
    var video = p.video || '';
    var filterLabeler = p.labeler || '';
    var rows = [];
    for (var li = 1; li < data.length; li++) {
      var lr = data[li];
      if (String(lr[idx.deleted]) === '1') continue;
      if (video && lr[idx.video] !== video) continue;
      if (filterLabeler && lr[idx.labeler] !== filterLabeler) continue;
      rows.push({
        ts: lr[idx.ts],
        labeler: lr[idx.labeler],
        punch_uuid: lr[idx.punch_uuid],
        video: lr[idx.video],
        impact_frame: lr[idx.impact_frame] === '' ? null : Number(lr[idx.impact_frame]),
        fps: lr[idx.fps] === '' ? null : Number(lr[idx.fps]),
        skip_reason: lr[idx.skip_reason] === '' ? null : String(lr[idx.skip_reason]),
      });
    }
    return jsonOut({ status: 'ok', rows: rows });
  }

  // === SAVE a label keyed by (labeler, punch_uuid). Supersedes prior. ===
  // Exactly one of impact_frame / skip_reason must be set.
  if (action === 'saveImpactFrame') {
    var required = ['labeler', 'punch_uuid', 'video'];
    for (var k = 0; k < required.length; k++) {
      if (p[required[k]] === undefined || p[required[k]] === '') {
        return jsonOut({ status: 'error', message: 'missing field: ' + required[k] });
      }
    }
    var hasFrame = p.impact_frame !== undefined && p.impact_frame !== '';
    var hasSkip = p.skip_reason !== undefined && p.skip_reason !== '';
    if (hasFrame === hasSkip) {
      return jsonOut({ status: 'error', message: 'need exactly one of impact_frame / skip_reason' });
    }
    var frameVal = '';
    var skipVal = '';
    if (hasFrame) {
      frameVal = Number(p.impact_frame);
      if (!isFinite(frameVal) || frameVal < 0 || frameVal !== Math.floor(frameVal)) {
        return jsonOut({ status: 'error', message: 'invalid impact_frame: ' + p.impact_frame });
      }
    } else {
      if (IMPACT_FRAME_SKIP_REASONS.indexOf(String(p.skip_reason)) === -1) {
        return jsonOut({ status: 'error', message: 'invalid skip_reason: ' + p.skip_reason });
      }
      skipVal = String(p.skip_reason);
    }
    var fpsVal = (p.fps === undefined || p.fps === '') ? '' : Number(p.fps);

    for (var i2 = 1; i2 < data.length; i2++) {
      if (String(data[i2][idx.deleted]) === '1') continue;
      if (data[i2][idx.labeler] !== p.labeler) continue;
      if (data[i2][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i2 + 1, idx.deleted + 1).setValue('1');
    }
    var newRow = [];
    var headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    for (var c = 0; c < headerRow.length; c++) {
      var col = String(headerRow[c]);
      if (col === 'ts') newRow.push(new Date().toISOString());
      else if (col === 'labeler') newRow.push(p.labeler);
      else if (col === 'punch_uuid') newRow.push(p.punch_uuid);
      else if (col === 'video') newRow.push(p.video);
      else if (col === 'impact_frame') newRow.push(frameVal);
      else if (col === 'fps') newRow.push(fpsVal);
      else if (col === 'skip_reason') newRow.push(skipVal);
      else if (col === 'deleted') newRow.push('');
      else newRow.push('');
    }
    sh.appendRow(newRow);
    return jsonOut({ status: 'ok' });
  }

  // === DELETE: mark every current row for (labeler, punch_uuid) deleted ===
  if (action === 'deleteImpactFrame') {
    var found = 0;
    for (var i3 = 1; i3 < data.length; i3++) {
      if (String(data[i3][idx.deleted]) === '1') continue;
      if (data[i3][idx.labeler] !== p.labeler) continue;
      if (data[i3][idx.punch_uuid] !== p.punch_uuid) continue;
      sh.getRange(i3 + 1, idx.deleted + 1).setValue('1');
      found++;
    }
    return jsonOut({ status: 'ok', deleted: found });
  }

  return jsonOut({ status: 'error', message: 'unknown impact-frame action: ' + action });
}

// ============================================================
// Callout labeler — one row per called-out punch / combo / defense.
// Each row stores the [start_sec, end_sec] window the callout was spoken
// over + the compact combo string + the canonical token ids (pipe-joined).
// `callout.js` submits the whole per-video set in one `saveCalloutEvents` GET
// (the client keeps localStorage as its source of truth, so re-sending the
// whole set lets a dropped save self-heal). Each event carries a stable
// `event_id`; the backend reconciles by id — it updates only the rows that
// changed, appends new ones, and deletes ones the labeler removed. So a
// typical save touches a single row instead of rewriting the whole set, and
// no superseded snapshots accumulate.
// ============================================================
var CALLOUT_SHEET_NAME = 'Callout Events';
var CALLOUT_HEADERS = ['ts', 'labeler', 'video_filename', 'video_id', 'video_url',
                       'start_sec', 'end_sec', 'callout_raw', 'callout_ids', 'event_id', 'submitted_at', 'deleted'];

// Canonical video key — mirrors the frontend's currentVideoKey() (Drive id
// preferred, else filename). Video identity is DATA, never the match key; saves
// reconcile on event_id, and this key only scopes which rows a delete may touch.
function calloutKey(vid, vfile) {
  return String(vid || '') || String(vfile || '');
}

// Inverse of the frontend's tokenCode(): canonical callout id -> compact code,
// so a date-coerced callout_raw can be rebuilt from the intact callout_ids.
var CALLOUT_ID_TO_CODE = {
  jab_head: '1', jab_body: '1b',
  cross_head: '2', cross_body: '2b',
  lead_hook_head: '3', lead_hook_body: '3b',
  rear_hook_head: '4', rear_hook_body: '4b',
  lead_uppercut_head: '5', lead_uppercut_body: '5b',
  rear_uppercut_head: '6', rear_uppercut_body: '6b',
  slip: 'slip', roll: 'roll', duck: 'duck',
  pull_back: 'pull', step_back: 'step', pivot: 'pivot', block: 'block',
};
// Rebuild a hyphen-joined callout_raw ("1-2b-slip") from the '|'-joined
// callout_ids cell. Returns null if the cell is empty or holds any unknown id,
// so callers can leave such rows alone instead of guessing.
function calloutIdsToCode(idsJoined) {
  var ids = String(idsJoined || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  if (ids.length === 0) return null;
  var codes = [];
  for (var i = 0; i < ids.length; i++) {
    var cm = ids[i].match(/^combo_([1-9])$/);
    if (cm) { codes.push('c' + cm[1]); continue; }
    if (CALLOUT_ID_TO_CODE[ids[i]]) { codes.push(CALLOUT_ID_TO_CODE[ids[i]]); continue; }
    return null;
  }
  return codes.join('-');
}

// Force the callout_raw column to plain-text format so Sheets stops parsing
// token strings like "1-2" or "5-6-1" into dates when setValues writes them.
function ensureCalloutRawText(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var c = 0; c < header.length; c++) {
    if (String(header[c]) === 'callout_raw') {
      sh.getRange(1, c + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      return;
    }
  }
}

function getOrCreateCalloutSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CALLOUT_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CALLOUT_SHEET_NAME);
    sh.appendRow(CALLOUT_HEADERS);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(CALLOUT_HEADERS);
    sh.setFrozenRows(1);
  }
  ensureCalloutRawText(sh);   // keep callout_raw as text so "1-2" isn't date-coerced
  return sh;
}

// Build one sheet row for a callout event, aligned to the live header order
// (so it tolerates per-sheet column ordering and the migrated event_id column).
function buildCalloutRow(headerRow, ev, eid, lbl, vfile, vid, vurl, submittedAt, ts) {
  var ids = Array.isArray(ev.callout_ids) ? ev.callout_ids.join('|') : String(ev.callout_ids || '');
  var row = [];
  for (var c = 0; c < headerRow.length; c++) {
    var col = String(headerRow[c]);
    if (col === 'ts') row.push(ts);
    else if (col === 'labeler') row.push(lbl);
    else if (col === 'video_filename') row.push(vfile);
    else if (col === 'video_id') row.push(vid);
    else if (col === 'video_url') row.push(vurl);
    else if (col === 'start_sec') row.push(ev.start_sec);
    else if (col === 'end_sec') row.push(ev.end_sec);
    else if (col === 'callout_raw') row.push(ev.callout_raw || '');
    else if (col === 'callout_ids') row.push(ids);
    else if (col === 'event_id') row.push(eid);
    else if (col === 'submitted_at') row.push(submittedAt);
    else if (col === 'deleted') row.push('');
    else row.push('');
  }
  return row;
}

function doGetCalloutEvents(p, labeler, action) {
  var sh = getOrCreateCalloutSheet();
  var data = sh.getDataRange().getValues();
  var idx = punchDirHeaderIndex(data[0]);   // header-name -> column index

  // === LIST events (optionally filtered by labeler and/or video) ===
  if (action === 'listCalloutEvents') {
    var video = p.video || '';
    var filterLabeler = p.labeler || '';
    var rows = [];
    for (var li = 1; li < data.length; li++) {
      var lr = data[li];
      if (String(lr[idx.deleted]) === '1') continue;
      if (filterLabeler && lr[idx.labeler] !== filterLabeler) continue;
      if (video && lr[idx.video_filename] !== video && lr[idx.video_id] !== video) continue;
      rows.push({
        ts: lr[idx.ts],
        labeler: lr[idx.labeler],
        video_filename: lr[idx.video_filename],
        video_id: lr[idx.video_id],
        video_url: lr[idx.video_url],
        start_sec: Number(lr[idx.start_sec]),
        end_sec: Number(lr[idx.end_sec]),
        callout_raw: lr[idx.callout_raw],
        callout_ids: String(lr[idx.callout_ids] || '').split('|').filter(function (s) { return s; }),
        submitted_at: lr[idx.submitted_at],
        event_id: idx.event_id !== undefined ? String(lr[idx.event_id] || '') : '',
      });
    }
    return jsonOut({ status: 'ok', rows: rows });
  }

  // === SAVE the whole per-video set; reconcile by event_id (touch only the
  //     rows that changed, add new ones, delete the ones the labeler removed) ===
  if (action === 'saveCalloutEvents') {
    if (!p.payload) return jsonOut({ status: 'error', message: 'missing payload' });
    var payload;
    try { payload = JSON.parse(p.payload); }
    catch (err) { return jsonOut({ status: 'error', message: 'bad payload JSON: ' + err.message }); }

    var lbl = payload.labeler || labeler || 'anon';
    var vfile = payload.video_filename || '';
    var vid = payload.video_id || '';
    var vurl = payload.video_url || '';
    var submittedAt = payload.submitted_at || new Date().toISOString();
    var events = payload.events || [];

    // Self-migrate: sheets created before per-event ids lack the event_id
    // column. Add it once, then re-read the snapshot so the indices line up.
    if (idx.event_id === undefined) {
      sh.insertColumnAfter(sh.getLastColumn());
      sh.getRange(1, sh.getLastColumn()).setValue('event_id');
      data = sh.getDataRange().getValues();
      idx = punchDirHeaderIndex(data[0]);
    }
    var headerRow = data[0];

    // Index ALL of this labeler's rows by event_id — video is DATA, not part of
    // the match key (mirrors the punch labeler keying on punch_uuid). A given
    // event_id must end up on exactly ONE row per labeler, so when video drift
    // left stale copies under a different filename/id we collapse them here on
    // the next save. Separately, collect the rows belonging to the *currently
    // saved* video by canonical key (video_id || video_filename, matching the
    // frontend's currentVideoKey) so deletes of removed callouts stay scoped to
    // this video alone and never touch another video's rows.
    var curKey = calloutKey(vid, vfile);
    var rowsById = {};          // event_id -> [1-based row, ...] (topmost first)
    var currentVideoRows = [];  // { row: 1-based, id: string } for this video
    for (var i = 1; i < data.length; i++) {
      if (data[i][idx.labeler] !== lbl) continue;
      var rid = String(data[i][idx.event_id] || '');
      if (rid) {
        if (!rowsById[rid]) rowsById[rid] = [];
        rowsById[rid].push(i + 1);
      }
      if (curKey && calloutKey(data[i][idx.video_id], data[i][idx.video_filename]) === curKey) {
        currentVideoRows.push({ row: i + 1, id: rid });
      }
    }

    // Walk the incoming set. Match each event by id anywhere for this labeler:
    // keep the topmost existing row, mark any extra copies for deletion (this
    // collapses drift dups), and rewrite the keeper in place — which also re-
    // tags it to the current video, healing a stale video identity. Brand-new
    // ids get appended; a single, fully-unchanged row is left as-is.
    var incomingIds = {};
    var toAppend = [];
    var toDelete = {};          // set of 1-based row numbers (deduped)
    var nUpdated = 0;
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      var eid = String(ev.id || ev.event_id || '');
      if (!eid) eid = Utilities.getUuid();   // defensive: never reconcile a blank id
      incomingIds[eid] = true;

      var existing = rowsById[eid] || [];
      if (existing.length === 0) {
        toAppend.push(buildCalloutRow(headerRow, ev, eid, lbl, vfile, vid, vurl, submittedAt, new Date().toISOString()));
        continue;
      }
      var keepRow = existing[0];
      for (var x = 1; x < existing.length; x++) toDelete[existing[x]] = true;

      var cur = data[keepRow - 1];
      var idsJoined = Array.isArray(ev.callout_ids) ? ev.callout_ids.join('|') : String(ev.callout_ids || '');
      var sameContent = String(cur[idx.start_sec]) === String(ev.start_sec) &&
                        String(cur[idx.end_sec]) === String(ev.end_sec) &&
                        String(cur[idx.callout_raw]) === String(ev.callout_raw || '') &&
                        String(cur[idx.callout_ids]) === idsJoined;
      var sameVideo = String(cur[idx.video_id] || '') === String(vid) &&
                      String(cur[idx.video_filename] || '') === String(vfile);
      if (existing.length === 1 && sameContent && sameVideo) continue;

      var keepTs = cur[idx.ts] || new Date().toISOString();
      var updRow = buildCalloutRow(headerRow, ev, eid, lbl, vfile, vid, vurl, submittedAt, keepTs);
      sh.getRange(keepRow, 1, 1, headerRow.length).setValues([updRow]);
      nUpdated++;
    }

    // Delete this video's rows whose id is gone from the incoming set (the
    // labeler removed that callout) plus any legacy blank-id / tombstone rows.
    for (var m = 0; m < currentVideoRows.length; m++) {
      var cr = currentVideoRows[m];
      if (!cr.id || !incomingIds[cr.id]) toDelete[cr.row] = true;
    }

    // Updates above don't change row count, so these snapshot row numbers are
    // still valid; delete bottom-up so they stay valid as rows shift, then
    // append the brand-new rows below the (now shorter) sheet.
    var delRows = Object.keys(toDelete).map(Number).sort(function (a, b) { return a - b; });
    for (var d = delRows.length - 1; d >= 0; d--) sh.deleteRow(delRows[d]);

    if (toAppend.length > 0) {
      sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, headerRow.length).setValues(toAppend);
    }
    return jsonOut({ status: 'ok', updated: nUpdated, added: toAppend.length, deleted: delRows.length });
  }

  return jsonOut({ status: 'error', message: 'unknown callout action: ' + action });
}
