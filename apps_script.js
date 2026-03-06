// Paste this into Google Apps Script (Extensions > Apps Script in your Google Sheet)
// Then deploy as a Web App with access set to "Anyone"

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Labeled Data Software');
  var data = JSON.parse(e.postData.contents);

  // Columns: video_file | training_type | stance | fighter | Angle | punch_type | start_sec | end_sec
  sheet.appendRow([
    data.videoName,
    data.trainingType || '',
    data.stance || '',
    data.fighter || '',
    data.angle,
    data.punchId,
    data.startTime,
    data.endTime
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Convert time cell value to seconds (handles Date objects, numbers, strings)
function toSeconds(val) {
  if (!val && val !== 0) return 0;
  // Date object (Google Sheets returns time-formatted cells as Date)
  if (val instanceof Date) {
    return val.getHours() * 3600 + val.getMinutes() * 60 + val.getSeconds() + val.getMilliseconds() / 1000;
  }
  // Number: could be fraction of day (< 1) or already seconds
  if (typeof val === 'number') {
    if (val < 1) return val * 86400;
    return val;
  }
  // String: parse MM:SS,ms or HH:MM:SS.ms etc.
  var s = String(val).replace(',', '.');
  var parts = s.split(':');
  if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(s) || 0;
}

function doGet(e) {
  var videoFile = e && e.parameter && e.parameter.video;

  // Debug mode: return headers and first row
  if (e && e.parameter && e.parameter.debug) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Labeled Data Software');
    var data = sheet.getDataRange().getValues();
    var header = data[0];
    var sample = data.length > 1 ? data[1] : [];
    var types = sample.map(function(v) { return typeof v + (v instanceof Date ? ' (Date)' : ''); });
    return ContentService
      .createTextOutput(JSON.stringify({ headers: header, sampleRow: sample.map(String), types: types }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (!videoFile) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', message: 'Label receiver is running' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Labeled Data Software');
  var data = sheet.getDataRange().getValues();
  var labels = [];

  var header = data[0];
  var colId = -1, colVideo = -1, colAngle = -1, colPunch = -1, colStart = -1, colEnd = -1;
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]).toLowerCase().trim();
    if (h === 'id') colId = c;
    else if (h === 'video_file') colVideo = c;
    else if (h === 'angle') colAngle = c;
    else if (h === 'punch_type') colPunch = c;
    else if (h === 'start_sec') colStart = c;
    else if (h === 'end_sec') colEnd = c;
  }

  for (var i = 1; i < data.length; i++) {
    if (data[i][colVideo] === videoFile) {
      labels.push({
        id: colId >= 0 ? data[i][colId] : i + 1,
        videoName: data[i][colVideo],
        angle: colAngle >= 0 ? data[i][colAngle] : '',
        punch: data[i][colPunch],
        startTime: colStart >= 0 ? toSeconds(data[i][colStart]) : 0,
        endTime: colEnd >= 0 ? toSeconds(data[i][colEnd]) : 0,
      });
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', labels: labels, headers: header.map(String), colId: colId }))
    .setMimeType(ContentService.MimeType.JSON);
}
