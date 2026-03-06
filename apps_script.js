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
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: 'Label receiver is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}
