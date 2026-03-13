// Paste this into Google Apps Script (Extensions > Apps Script in your Google Sheet)
// Then deploy as a Web App with access set to "Anyone"
// All operations use doGet with URL parameters for reliable CORS support

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
  var cols = { id: -1, video: -1, angle: -1, punch: -1, start: -1, end: -1 };
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]).toLowerCase().trim();
    if (h === 'id') cols.id = c;
    else if (h === 'video_file') cols.video = c;
    else if (h === 'angle') cols.angle = c;
    else if (h === 'punch_type') cols.punch = c;
    else if (h === 'start_sec') cols.start = c;
    else if (h === 'end_sec') cols.end = c;
  }
  return cols;
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

// Find the sheet row number (1-based) for a given ID value
function findRowById(data, cols, id) {
  var targetId = parseInt(id);
  for (var i = 1; i < data.length; i++) {
    if (parseInt(data[i][cols.id]) === targetId) {
      return i + 1; // 1-based row number
    }
  }
  return -1;
}

function doGet(e) {
  var p = e ? e.parameter : {};
  var action = p.action || 'list';
  var labeler = p.labeler || '1';

  var sheetName;
  if (labeler === 'combined') {
    sheetName = 'Combined Data';
  } else {
    sheetName = 'Labeled Data Software ' + labeler;
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
    var labels = [];
    for (var i = 1; i < data.length; i++) {
      if (data[i][cols.video] === p.video) {
        labels.push({
          id: parseInt(data[i][cols.id]) || (i + 1),
          videoName: data[i][cols.video],
          angle: cols.angle >= 0 ? data[i][cols.angle] : '',
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
    var newId = nextId(data, cols);
    sheet.appendRow([
      newId,
      p.videoName || '',
      p.trainingType || '',
      p.stance || '',
      p.fighter || '',
      p.angle || '',
      p.punchId || '',
      p.startTime || '',
      p.endTime || ''
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', action: 'added', id: newId }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === UPDATE an existing label by ID ===
  if (action === 'update' && p.id) {
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    var row = findRowById(data, cols, p.id);
    if (row < 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'ID not found: ' + p.id }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (p.punchId && cols.punch >= 0) sheet.getRange(row, cols.punch + 1).setValue(p.punchId);
    if (p.angle && cols.angle >= 0) sheet.getRange(row, cols.angle + 1).setValue(p.angle);
    if (p.startTime && cols.start >= 0) sheet.getRange(row, cols.start + 1).setValue(p.startTime);
    if (p.endTime && cols.end >= 0) sheet.getRange(row, cols.end + 1).setValue(p.endTime);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', action: 'updated' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === DELETE a label by ID ===
  if (action === 'delete' && p.id) {
    var data = sheet.getDataRange().getValues();
    var cols = findColumns(data[0]);
    var row = findRowById(data, cols, p.id);
    if (row < 0) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'error', message: 'ID not found: ' + p.id }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    sheet.deleteRow(row);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', action: 'deleted' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // === Default: status check ===
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'Label receiver is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}
