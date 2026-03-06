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

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Labeled Data Software');
  var data = sheet.getDataRange().getValues();
  var labels = [];

  // Skip header row (row 0)
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === videoFile) {
      labels.push({
        videoName: data[i][0],
        angle: data[i][4],
        punch: data[i][5],
        startTime: data[i][6],
        endTime: data[i][7]
      });
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', labels: labels }))
    .setMimeType(ContentService.MimeType.JSON);
}
