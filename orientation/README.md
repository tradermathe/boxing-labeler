# Cornerman — Orientation Labeler

Standalone web tool for labelling the boxer's facing direction on individual
frames. The labels train an ML orientation classifier whose per-frame
predictions feed every depth-sensitive rule (arm_extension, hip_rotation,
stance_width, and the unstarted hand-return / u-shape rules).

## What's here

| file | role |
|---|---|
| `index.html` + `app.js` | Frontend the labeller team opens in a browser. |
| `sampler.js` | Deterministic frame-candidate picker (5 s buckets, jittered, capped at 100/video, shuffled). |
| `sheets-client.js` | Thin wrapper that POSTs labels to the Apps Script endpoint. |
| `apps_script.gs` | Server side. Deploy this as a Google Apps Script web app; it reads/writes the **Orientation Labels** sheet tab. |
| `videos.json` | List of videos + their round meta (no secrets — committed). |
| `config.local.json` | Untracked: the deployed Apps Script URL. Copy from `config.local.example.json`. |
| `build_videos_json.py` | Regenerates `videos.json` from the glove-cache meta files. Run after every new extraction batch. |

## One-time setup

### 1. Deploy the Apps Script backend

Add the script to the existing **"Boxing AI"** Apps Script project. No conflict with the existing form labeler — that one is menu-driven (no `doGet`/`doPost`), so it stays unaffected.

1. Open the labels Sheet → **Extensions → Apps Script**.
2. In the left-hand "Bestanden" panel click **+ → Script**. Name the new file **`OrientationLabeler`**.
3. Paste the contents of `apps_script.gs` (this directory) into the new file. `Code.gs` stays untouched.
4. **Save** (`Cmd/Ctrl+S`).
5. **Deploy → New deployment → Web app**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone with the link** (or "Anyone in <workspace>")
6. Approve the first-time OAuth prompt — Apps Script needs permission to write to the Sheet.
7. Copy the **Deployment URL** that comes back.

The script reads/writes a new tab called **`Orientation Labels`** which it creates on first write — won't disturb existing tabs.

*Note*: an Apps Script project can have at most ONE `doGet` and ONE `doPost`. If you ever want a second web app inside the same project, you'd need to merge the handlers. The Boxing AI project doesn't currently have either, so we're fine.

### 2. Wire the deployment URL into `config.local.json`

The deployment URL is a write credential for the labels Sheet, so it is **not**
committed (this repo is public). Copy the template and paste your URL in:

```bash
cp orientation/config.local.example.json orientation/config.local.json
```

```json
{
  "appsScriptUrl": "https://script.google.com/macros/s/PASTE_DEPLOYMENT_ID/exec"
}
```

`config.local.json` is gitignored; the page fetches it at runtime and merges it
over `videos.json` (which holds only the video list). Without it the labeler
still runs, but labels can't be saved.

### 3. Serve the labeler

Any static HTTP server works. Easiest is:

```bash
cd labeler/orientation
python3 -m http.server 8080
```

Then point a browser at `http://localhost:8080`. For team-wide access either
host on GitHub Pages, deploy to Netlify, or have each labeler run the
http.server locally with their own Drive-for-Desktop copy of the videos.

## Per-session workflow (for the labeling team)

1. Open the labeler page in Chrome / Safari.
2. Type your **name** into the *Your name* field at the top right.
3. Pick a **video** from the dropdown.
4. Click **Pick local .mp4 file…** and choose the matching video from your
   Drive-for-Desktop sync (the labeler doesn't ship video data; everyone
   labels off their own local copy).
5. Use the **numpad keys** to label each frame. Numpad layout matches the
   angles spatially:

```
7 = -135°    8 = 180°    9 = +135°
4 =  -90°    5 =   0°    6 =  +90°
1 =  -45°    2 = skip    3 =  +45°
```

Convention:

- `0°` = boxer facing the camera (chest toward camera)
- `±45°` = quarter-turned toward the camera
- `±90°` = sideways to the camera (one shoulder pointing at camera)
- `±135°` = quarter-turned away from the camera
- `180°` = back to camera

Each label saves to the **Orientation Labels** tab in the Sheet and the
view auto-advances to the next unlabelled candidate. Hit **C** to clear a
mistake; **P** to step back to the previous candidate.

## Regenerating `videos.json` after new extractions

When new glove caches land in
`~/Google Drive/My Drive/boxing_ai/glove_wrist_cache/`, run:

```bash
python labeler/orientation/build_videos_json.py
```

It walks the directory, groups by stem, and rewrites `videos.json` in place.
`videos.json` holds only the video list; the `appsScriptUrl` lives in the
untracked `config.local.json` and is unaffected by regeneration.

## Held-out videos

Mark a video as held-out (excluded from the labeler queue, reserved for
testing model generalization) by adding its stem to the `HELD_OUT` set at
the top of `build_videos_json.py` and re-running. Held-out videos still
appear in the JSON but with `"heldOut": true`, and the frontend filters
them out of the dropdown.

## Sheet schema

`Orientation Labels` tab has these columns (auto-created on first write):

| column | type | notes |
|---|---|---|
| `ts` | ISO timestamp | server-set on append |
| `labeler` | string | from the *Your name* field |
| `video` | string | video stem |
| `round` | int | round index within the video |
| `frame` | int | frame index within the round's cache |
| `label` | int or "" | one of `{-180, -135, -90, -45, 0, 45, 90, 135}`; empty string = skipped/unclear |
| `deleted` | "" or "1" | when a labeler clears or overwrites a label, the old row is marked `1`; downstream consumers skip those rows |

Read the latest non-deleted label per `(labeler, video, round, frame)` to
get the training set.

## Status: v0.1

What works:

- Deterministic frame sampling per video (5 s buckets, jittered, capped
  at 100, shuffled).
- Numpad-keyed labelling with auto-advance.
- Resume across sessions — the labeler fetches the labeler's existing
  rows from the Sheet on video load and starts from the first unlabelled
  candidate.
- Per-bin distribution display so labelers see when they're over/under
  represented for the round so far.

What's missing (file an issue or hand it back to engineering):

- Pose-overlay rendering on the video — pose caches aren't loaded, so the
  team labels off raw frames. Add only if labelers report difficulty.
- Inter-rater agreement: same frame routed to two labelers, then Cohen's
  κ computed after the fact. Currently the team would have to
  deliberately label overlapping subsets.
- The held-out flag is set by stem in `build_videos_json.py`. A web UI
  for managing it would be nicer.
