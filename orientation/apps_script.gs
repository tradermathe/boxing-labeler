/**
 * Cornerman — Orientation Labeler Apps Script backend.
 *
 * Paste this block at the bottom of Code.gs (or as a new file — same
 * thing at runtime). Then Deploy → New deployment → Web app, "Execute
 * as: me", "Anyone with the link". Copy the deployment URL into
 * labeler/orientation/videos.json's "appsScriptUrl".
 *
 * All identifiers are namespaced with ORIENTATION_ / orientation* so
 * nothing collides with existing Code.gs symbols (SHEET_NAME, HEADERS,
 * helper utilities, etc.). The only globally-visible names this adds
 * are `doGet` and `doPost` — Apps Script web apps must use those exact
 * names. Your current Code.gs doesn't define either (the existing
 * functions are menu-driven), so there's no conflict.
 *
 * Endpoints (web app URL after deploy):
 *   GET  ?action=labels&video=<stem>&labeler=<name>  → labels for that
 *                                                       labeler+video
 *   GET  ?action=count                                → total label count
 *   POST { labeler, video, round, frame, label }     → append one row
 *   POST { labeler, video, round, frame, action:"delete" }
 *                                                   → mark prior row deleted
 *
 * Sheet contract (the tab is auto-created on first write):
 *   Tab: "Orientation Labels"
 *   Columns: ts | labeler | video | round | frame | label | deleted
 *     label ∈ {-180, -135, -90, -45, 0, 45, 90, 135}, or "" for skip
 *     deleted = "1" on the row a later edit superseded
 *
 * Sheet binding: defaults to the spreadsheet this script is bound to.
 * If you ever move this code to a standalone Apps Script project, set
 * ORIENTATION_SHEET_ID to the spreadsheet's ID instead.
 */

// ─── orientation labeler config ──────────────────────────────────────────
const ORIENTATION_SHEET_ID = "";  // "" → use bound spreadsheet
const ORIENTATION_SHEET_NAME = "Orientation Labels";
const ORIENTATION_LABELS_HEADERS = [
  "ts", "labeler", "video", "round", "frame", "label", "deleted"
];
const ORIENTATION_VALID_BINS = [-180, -135, -90, -45, 0, 45, 90, 135, 180];

function orientationGetOrCreateSheet_() {
  const ss = ORIENTATION_SHEET_ID
    ? SpreadsheetApp.openById(ORIENTATION_SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("No bound spreadsheet and no ORIENTATION_SHEET_ID set.");
  let sh = ss.getSheetByName(ORIENTATION_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(ORIENTATION_SHEET_NAME);
    sh.appendRow(ORIENTATION_LABELS_HEADERS);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(ORIENTATION_LABELS_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function doGet(e) {
  const action = (e.parameter.action || "labels").toLowerCase();
  const sh = orientationGetOrCreateSheet_();
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return orientationJsonOut_({ ok: true, rows: [] });

  const idx = orientationHeaderIndex_(data[0]);

  if (action === "count") {
    let n = 0;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idx.deleted]) !== "1") n++;
    }
    return orientationJsonOut_({ ok: true, count: n });
  }

  // action === "labels"
  const video = e.parameter.video || "";
  const labeler = e.parameter.labeler || "";
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (String(r[idx.deleted]) === "1") continue;
    if (video && r[idx.video] !== video) continue;
    if (labeler && r[idx.labeler] !== labeler) continue;
    rows.push({
      ts: r[idx.ts],
      labeler: r[idx.labeler],
      video: r[idx.video],
      round: Number(r[idx.round]),
      frame: Number(r[idx.frame]),
      label: r[idx.label] === "" ? null : Number(r[idx.label]),
    });
  }
  return orientationJsonOut_({ ok: true, rows });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return orientationJsonOut_({ ok: false, error: "invalid JSON" }); }

  const required = ["labeler", "video", "round", "frame"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null) {
      return orientationJsonOut_({ ok: false, error: "missing field: " + k });
    }
  }

  // Label must be in the bin set, null (skip), or absent (also skip).
  let lbl = body.label;
  if (lbl === null || lbl === undefined || lbl === "") {
    lbl = "";
  } else if (ORIENTATION_VALID_BINS.indexOf(Number(lbl)) === -1) {
    return orientationJsonOut_({ ok: false, error: "invalid label: " + lbl });
  } else {
    // Normalise +180 → -180 for storage consistency
    lbl = Number(lbl);
    if (lbl === 180) lbl = -180;
  }

  const sh = orientationGetOrCreateSheet_();
  const data = sh.getDataRange().getValues();
  const idx = orientationHeaderIndex_(data[0]);

  // If a prior label for (labeler, video, round, frame) exists, mark it
  // deleted so the latest write is the authoritative answer on read.
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx.deleted]) === "1") continue;
    if (data[i][idx.labeler] !== body.labeler) continue;
    if (data[i][idx.video] !== body.video) continue;
    if (Number(data[i][idx.round]) !== Number(body.round)) continue;
    if (Number(data[i][idx.frame]) !== Number(body.frame)) continue;
    sh.getRange(i + 1, idx.deleted + 1).setValue("1");
  }

  if (body.action === "delete") {
    return orientationJsonOut_({ ok: true, deleted: true });
  }

  sh.appendRow([
    new Date().toISOString(),
    body.labeler,
    body.video,
    Number(body.round),
    Number(body.frame),
    lbl,
    "",
  ]);
  return orientationJsonOut_({ ok: true });
}

function orientationJsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function orientationHeaderIndex_(headerRow) {
  const idx = {};
  for (let i = 0; i < headerRow.length; i++) idx[String(headerRow[i])] = i;
  return idx;
}
