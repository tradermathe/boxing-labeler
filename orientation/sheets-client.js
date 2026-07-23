// Thin wrapper around the Apps Script web-app endpoint.
//
// The endpoint URL is provided via the `appsScriptUrl` field in
// videos.json. All requests use form-encoded POST bodies (rather than
// application/json) to avoid CORS preflight — Apps Script is fine reading
// the body either way.

let endpoint = null;

export function configure(url) {
  endpoint = url;
}

export async function fetchLabels({ video, labeler }) {
  if (!endpoint) throw new Error("Sheets endpoint not configured");
  const url = new URL(endpoint);
  url.searchParams.set("action", "labels");
  if (video) url.searchParams.set("video", video);
  if (labeler) url.searchParams.set("labeler", labeler);
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error(`fetchLabels failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`fetchLabels: ${body.error || "unknown"}`);
  return body.rows;
}

export async function saveLabel({ labeler, video, round, frame, label }) {
  return _post({ labeler, video, round, frame, label });
}

export async function deleteLabel({ labeler, video, round, frame }) {
  return _post({ labeler, video, round, frame, action: "delete" });
}

async function _post(payload) {
  if (!endpoint) throw new Error("Sheets endpoint not configured");
  // Apps Script web apps accept text/plain bodies without preflight.
  // We send JSON-stringified text; doPost(e).postData.contents parses it.
  const res = await fetch(endpoint, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`saveLabel failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`saveLabel: ${body.error || "unknown"}`);
  return body;
}
