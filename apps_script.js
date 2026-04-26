// Paste this into Google Apps Script (Extensions > Apps Script in your Google Sheet)
// Then deploy as a Web App with access set to "Anyone"
// All operations use doGet with URL parameters for reliable CORS support

// ONE-TIME: Run this from Apps Script to backfill IDs in Combined Data.
// Go to Run > backfillCombinedIds, then delete this function after.
function backfillCombinedIds() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Combined Data');
  if (!sheet) { Logger.log('Combined Data sheet not found'); return; }
  var data = sheet.getDataRange().getValues();
  var cols = findColumns(data[0]);
  if (cols.id < 0) { Logger.log('No id column found'); return; }
  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][cols.id] === '' || data[i][cols.id] == null) {
      sheet.getRange(i + 1, cols.id + 1).setValue(i);
      count++;
    }
  }
  Logger.log('Backfilled ' + count + ' IDs in Combined Data');
}

function doPost(e) {
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

  var sheetName;
  if (labeler === 'combined') {
    sheetName = 'Combined Data';
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
    if (cols.start >= 0) row[cols.start] = p.startTime || '';
    if (cols.end >= 0) row[cols.end] = p.endTime || '';
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
    if (insertBeforeRow > 0) {
      sheet.insertRowBefore(insertBeforeRow);
      sheet.getRange(insertBeforeRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
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
    if (p.startTime && cols.start >= 0) { sheet.getRange(row, cols.start + 1).setValue(p.startTime); updated.push('start'); }
    if (p.endTime && cols.end >= 0) { sheet.getRange(row, cols.end + 1).setValue(p.endTime); updated.push('end'); }
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
function doGetRules(p, labeler, action) {
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
