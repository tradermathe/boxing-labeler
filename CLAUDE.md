# Labeler

Web-based video labeling tool for boxing punch annotation.

## Stack

- `index.html` + `style.css` + `app.js` — Frontend (vanilla HTML/JS, no framework)
- `apps_script.js` — Google Apps Script backend (deployed as Web App)
- Hosted at: https://tradermathe.github.io/boxing-labeler/

## How It Works

- Users load videos and mark punch segments with type, start/end times, angle, stance
- Labels are saved to Google Sheets via GET requests to the Apps Script web app
- Sheet naming: "Labeled Data Software {N}" per labeler, "Combined Data" for merged view
- All CRUD operations (list/add/update/delete) go through `doGet` with URL params

## Sheet Columns

**Labeler sheets** ("Labeled Data Software {N}"):
id | video_file | training_type | stance | fighter | angle | punch_type | start_sec | end_sec

**Combined Data sheet**:
id | video_name | video_file | training_type | stance | fighter | angle | label | start_sec | end_sec

**Form Labels sheets** ("Form Labels {Name}"):
id | punch_uuid | video_file | punch_type | hand | stance | start_sec | end_sec | rule_hand_extended | rule_hand_low | rule_hand_ushape | rule_hip_rotation | rule_rear_heel_lift | rule_resting_hand | rule_extension | rule_punch_height | labeled_at

**Combined Form Labels sheet**:
Same columns as Form Labels + `labeler`. Built by `rebuildCombinedFormLabels()` (MyCorner > Rebuild Combined Form Labels). Dedupes by (punch_uuid, labeler) — same uuid intentionally appears across labelers (inter-rater data). Header mapping is by name, so per-labeler column-order differences are tolerated.

## Setup

See `SETUP.md` for Google Sheets + Apps Script deployment instructions.
