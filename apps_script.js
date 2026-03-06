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

function doGet(e) {
  var videoFile = e && e.parameter && e.parameter.video;
  if (!videoFile) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', message: 'Label receiver is running' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var labels = [];

  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var name = sheet.getName();
    // Skip non-data sheets
    if (name === 'Videos' || name === 'Explanation') continue;

    var data = sheet.getDataRange().getValues();
    // Find column indices from header row
    var header = data[0];
    var colVideo = -1, colAngle = -1, colPunch = -1, colStart = -1, colEnd = -1;
    for (var c = 0; c < header.length; c++) {
      var h = String(header[c]).toLowerCase().trim();
      if (h === 'video_file') colVideo = c;
      else if (h === 'angle') colAngle = c;
      else if (h === 'punch_type') colPunch = c;
      else if (h === 'start_sec') colStart = c;
      else if (h === 'end_sec') colEnd = c;
    }
    if (colVideo === -1 || colPunch === -1) continue;

    for (var i = 1; i < data.length; i++) {
      if (data[i][colVideo] === videoFile) {
        labels.push({
          rowId: i + 1,
          videoName: data[i][colVideo],
          angle: colAngle >= 0 ? data[i][colAngle] : '',
          punch: data[i][colPunch],
          startTime: colStart >= 0 ? String(data[i][colStart]) : '',
          endTime: colEnd >= 0 ? String(data[i][colEnd]) : '',
          sheet: name
        });
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', labels: labels }))
    .setMimeType(ContentService.MimeType.JSON);
}
