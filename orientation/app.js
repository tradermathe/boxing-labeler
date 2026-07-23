// Cornerman orientation labeler — frontend glue.
//
// Flow:
//   1. Load videos.json (list of videos + their round meta + Apps Script URL).
//   2. Labeler picks a video from the dropdown.
//   3. Labeler picks the local .mp4 (must match the video stem; we don't
//      ship video bytes — the team labels off their Drive-for-Desktop copy).
//   4. We compute the deterministic candidate set for the video and fetch
//      any existing labels for (this labeler, this video) from Sheets so
//      we can skip what's already done.
//   5. Show one candidate at a time, seeked via the HTML5 <video> element.
//      Labeler hits a numpad key (or button); the label POSTs to Sheets
//      and we auto-advance.

import { pickCandidates, candidatesSummary } from "./sampler.js";
import { configure, fetchLabels, saveLabel, deleteLabel } from "./sheets-client.js";

const BUILD = "2026-05-15.1";
document.getElementById("build").textContent = `build ${BUILD}`;

const BIN_KEYS = {
  "1": -45, "2": null, "3":  45,
  "4": -90, "5":   0, "6":  90,
  "7":-135, "8": 180, "9": 135,
};

const state = {
  videos: [],
  currentVideo: null,          // selected video from videos.json
  videoUrl: null,              // object URL for the picked file
  candidates: [],              // [{ round, frame }, ...]
  doneKeys: new Set(),         // "round:frame" → already labelled (skipped or labelled)
  cursor: 0,                   // index in candidates
  labelByKey: new Map(),       // "round:frame" → angle (or null for skip)
  videoEl: null,
};

const els = {};
function bind() {
  els.labelerInput = document.getElementById("labeler-input");
  els.videoSelect  = document.getElementById("video-select");
  els.pickFile     = document.getElementById("pick-file");
  els.fileInput    = document.getElementById("file-input");
  els.setupStatus  = document.getElementById("setup-status");
  els.frameStatus  = document.getElementById("frame-status");
  els.sheetStatus  = document.getElementById("sheet-status");
  els.videoEl      = document.getElementById("video");
  els.videoEmpty   = document.getElementById("video-empty");
  els.banner       = document.getElementById("frame-banner");
  els.frameInfo    = document.getElementById("frame-info");
  els.frameProgress= document.getElementById("frame-progress");
  els.progressBar  = document.getElementById("progress-bar");
  els.progressText = document.getElementById("progress-text");
  els.distText     = document.getElementById("dist");
  els.orientButtons= document.querySelectorAll(".orient-btn");
  state.videoEl = els.videoEl;
}

async function loadConfig() {
  const res = await fetch("./videos.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`videos.json fetch failed: ${res.status}`);
  const cfg = await res.json();
  // The Apps Script deployment URL is a write credential for the labels Sheet,
  // so it lives in an untracked config.local.json (copy config.local.example.json)
  // — never in this public repo. A missing file just means read-only mode.
  try {
    const localRes = await fetch("./config.local.json", { cache: "no-cache" });
    if (localRes.ok) {
      const local = await localRes.json();
      if (local.appsScriptUrl) cfg.appsScriptUrl = local.appsScriptUrl;
    }
  } catch { /* no local config — labels can't be saved, labeling still works */ }
  return cfg;
}

function persistLabelerName(name) {
  try { localStorage.setItem("ol_labeler_name", name); } catch {}
}
function restoreLabelerName() {
  try { return localStorage.getItem("ol_labeler_name") || ""; } catch { return ""; }
}

function populateVideoSelect(videos) {
  els.videoSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = `— pick a video (${videos.length}) —`;
  els.videoSelect.appendChild(placeholder);
  for (const v of videos) {
    if (v.heldOut) continue;     // hold-out set is hidden from labelers
    const opt = document.createElement("option");
    opt.value = v.stem;
    const nRounds = (v.rounds || []).length;
    opt.textContent = `${v.stem}  ·  ${nRounds} round${nRounds === 1 ? "" : "s"}`;
    els.videoSelect.appendChild(opt);
  }
}

async function onVideoSelected() {
  const stem = els.videoSelect.value;
  if (!stem) return;
  state.currentVideo = state.videos.find(v => v.stem === stem);
  state.candidates = pickCandidates(state.currentVideo);
  state.doneKeys = new Set();
  state.labelByKey = new Map();
  state.cursor = 0;
  const summary = candidatesSummary(state.currentVideo, state.candidates);
  setText("setup-status", `${summary.total} candidate frames generated across ${Object.keys(summary.perRound).length} round(s).`);

  // Fetch any existing labels for this labeler+video so we resume cleanly.
  await syncFromSheet();
  // Reset video element if a previous video was picked
  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
    els.videoEl.src = "";
    showEmptyState();
  }
  setText("frame-status", "Pick the local .mp4 file next to continue.");
  setText("sheet-status", "");
  redrawProgress();
}

async function syncFromSheet() {
  const labeler = els.labelerInput.value.trim();
  if (!labeler || !state.currentVideo) return;
  try {
    setText("sheet-status", "Loading existing labels…");
    const rows = await fetchLabels({ video: state.currentVideo.stem, labeler });
    state.doneKeys = new Set();
    state.labelByKey = new Map();
    for (const r of rows) {
      const k = `${r.round}:${r.frame}`;
      state.doneKeys.add(k);
      state.labelByKey.set(k, r.label);
    }
    setText("sheet-status", `Loaded ${rows.length} prior label(s) for "${labeler}".`);
    advanceToNextUnlabeled(/*from=*/0);
    redrawProgress();
  } catch (e) {
    setText("sheet-status", `Couldn't fetch labels: ${e.message}`, "err");
  }
}

function showEmptyState() {
  els.videoEmpty.hidden = false;
  els.videoEl.style.display = "none";
  els.banner.hidden = true;
}
function showVideo() {
  els.videoEmpty.hidden = true;
  els.videoEl.style.display = "block";
  els.banner.hidden = false;
}

function onFilePicked(file) {
  if (!file) return;
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  els.videoEl.src = state.videoUrl;
  els.videoEl.addEventListener("loadedmetadata", () => {
    showVideo();
    seekToCurrent();
    redrawProgress();
  }, { once: true });
  setText("setup-status",
    `Loaded "${file.name}" (${(file.size / 1e6).toFixed(0)} MB). Use the numpad to label.`);
}

function seekToCurrent() {
  if (!state.currentVideo || !state.candidates.length) return;
  if (state.cursor >= state.candidates.length) {
    setText("frame-status", "All candidates labelled for this video. Pick another video.");
    return;
  }
  const c = state.candidates[state.cursor];
  // Convert (round, frame) → absolute video time using round meta
  const r = (state.currentVideo.rounds || []).find(x => (x.round ?? 0) === c.round);
  if (!r) {
    setText("frame-status", `No meta for round ${c.round} in this video.`, "err");
    return;
  }
  const startSec = Number(r.actual_start_sec ?? r.start_sec ?? 0);
  const fps = Number(r.fps);
  // +0.5/fps lands the seek in the middle of the source frame's slot
  const t = startSec + (c.frame + 0.5) / fps;
  els.videoEl.currentTime = t;
  els.frameInfo.textContent =
    `round ${c.round} · frame ${c.frame}  ·  t=${t.toFixed(2)}s`;
  els.frameProgress.textContent =
    `${state.cursor + 1}/${state.candidates.length}`;
  updateButtonHighlight();
  setText("frame-status", "");
}

function updateButtonHighlight() {
  const c = state.candidates[state.cursor];
  const k = c ? `${c.round}:${c.frame}` : null;
  const existingLabel = k && state.labelByKey.has(k) ? state.labelByKey.get(k) : undefined;
  for (const btn of els.orientButtons) {
    const key = btn.dataset.key;
    const angle = BIN_KEYS[key];
    const matches = existingLabel === undefined ? false
      : existingLabel === null ? angle === null
      : Number(existingLabel) === Number(angle);
    btn.classList.toggle("selected", matches);
  }
}

async function applyKey(key) {
  if (!state.currentVideo) return;
  const labeler = els.labelerInput.value.trim();
  if (!labeler) {
    setText("setup-status", "Set your name first.", "err");
    els.labelerInput.focus();
    return;
  }
  if (!(key in BIN_KEYS)) return;
  const angle = BIN_KEYS[key];
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = `${c.round}:${c.frame}`;
  // Optimistic UI update
  state.doneKeys.add(k);
  state.labelByKey.set(k, angle);
  updateButtonHighlight();
  redrawProgress();

  try {
    await saveLabel({
      labeler,
      video: state.currentVideo.stem,
      round: c.round,
      frame: c.frame,
      label: angle,
    });
    setText("sheet-status", `Saved: ${angle === null ? "skip" : `${angle}°`}`, "ok");
  } catch (e) {
    setText("sheet-status", `Save failed: ${e.message}`, "err");
    return;
  }
  advanceToNextUnlabeled(state.cursor + 1);
}

function advanceToNextUnlabeled(fromIdx) {
  // Wrap-around scan from fromIdx for the first candidate not yet labelled.
  const N = state.candidates.length;
  if (N === 0) return;
  for (let i = 0; i < N; i++) {
    const idx = (fromIdx + i) % N;
    const c = state.candidates[idx];
    const k = `${c.round}:${c.frame}`;
    if (!state.doneKeys.has(k)) {
      state.cursor = idx;
      seekToCurrent();
      return;
    }
  }
  // Everything labelled
  state.cursor = N;
  setText("frame-status", "All candidates labelled for this video — pick another video, or use ←/→ to review.");
}

async function clearCurrent() {
  if (!state.currentVideo) return;
  const labeler = els.labelerInput.value.trim();
  if (!labeler) return;
  const c = state.candidates[state.cursor];
  if (!c) return;
  const k = `${c.round}:${c.frame}`;
  state.doneKeys.delete(k);
  state.labelByKey.delete(k);
  updateButtonHighlight();
  redrawProgress();
  try {
    await deleteLabel({
      labeler, video: state.currentVideo.stem,
      round: c.round, frame: c.frame,
    });
    setText("sheet-status", "Cleared this frame's label.", "ok");
  } catch (e) {
    setText("sheet-status", `Clear failed: ${e.message}`, "err");
  }
}

function gotoPrev() {
  if (!state.candidates.length) return;
  state.cursor = Math.max(0, state.cursor - 1);
  seekToCurrent();
}

function redrawProgress() {
  const N = state.candidates.length;
  const labelled = state.doneKeys.size;
  els.progressBar.style.width = N ? `${(100 * labelled / N).toFixed(1)}%` : "0%";
  els.progressText.textContent = N
    ? `${labelled} / ${N} labelled`
    : "no candidates";
  // Distribution per bin
  const dist = {};
  for (const v of state.labelByKey.values()) {
    const key = v === null ? "skip" : String(v);
    dist[key] = (dist[key] || 0) + 1;
  }
  const orderKeys = ["0", "45", "-45", "90", "-90", "135", "-135", "-180", "180"];
  const parts = orderKeys.map(k => (dist[k] != null ? `${k}°: ${dist[k]}` : null)).filter(Boolean);
  if (dist.skip != null) parts.push(`skip: ${dist.skip}`);
  els.distText.textContent = parts.length ? parts.join(" · ") : "—";
}

function setText(id, value, cls) {
  const el = (id === "setup-status") ? els.setupStatus
           : (id === "frame-status") ? els.frameStatus
           : (id === "sheet-status") ? els.sheetStatus
           : document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.remove("err", "ok");
  if (cls) el.classList.add(cls);
}

// ── wire-up ───────────────────────────────────────────────────────────────

(async function main() {
  bind();
  els.labelerInput.value = restoreLabelerName();
  els.labelerInput.addEventListener("change", () => {
    persistLabelerName(els.labelerInput.value.trim());
    if (state.currentVideo) syncFromSheet();
  });

  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    setText("setup-status", `Couldn't load videos.json: ${e.message}`, "err");
    return;
  }
  state.videos = cfg.videos || [];
  populateVideoSelect(state.videos);
  configure(cfg.appsScriptUrl || "");

  if (!cfg.appsScriptUrl) {
    setText("sheet-status",
      "videos.json has no appsScriptUrl — labels can't be saved.", "err");
  }

  els.videoSelect.addEventListener("change", onVideoSelected);
  els.pickFile.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => onFilePicked(e.target.files[0]));
  for (const btn of els.orientButtons) {
    btn.addEventListener("click", () => applyKey(btn.dataset.key));
  }
  document.getElementById("clear-frame").addEventListener("click", clearCurrent);
  document.getElementById("prev-frame").addEventListener("click", gotoPrev);

  document.addEventListener("keydown", (e) => {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key in BIN_KEYS) { e.preventDefault(); applyKey(e.key); return; }
    if (e.key === "c" || e.key === "C") { e.preventDefault(); clearCurrent(); return; }
    if (e.key === "p" || e.key === "P") { e.preventDefault(); gotoPrev(); return; }
  });
})();
