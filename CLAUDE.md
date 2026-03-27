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

## Setup

See `SETUP.md` for Google Sheets + Apps Script deployment instructions.
