// Paste this into Google Apps Script (Extensions > Apps Script in your Google Sheet)
// Then deploy as a Web App with access set to "Anyone"

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  sheet.appendRow([
    data.videoName,
    data.punchId,
    data.punchLabel,
    data.startTime,
    data.endTime,
    data.duration,
    data.timestamp
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
