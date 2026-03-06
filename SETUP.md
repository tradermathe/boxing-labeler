# Boxing Labeler - Google Sheets Setup

## Step 1: Create a Google Sheet
1. Go to Google Sheets and create a new spreadsheet
2. Name it something like "Boxing Labels"
3. In row 1, add these headers:
   `Video Name | Punch ID | Punch Label | Start Time | End Time | Duration | Timestamp`

## Step 2: Add the Apps Script
1. In your Google Sheet, go to **Extensions > Apps Script**
2. Delete any existing code and paste the contents of `apps_script.js` from this folder
3. Click **Save** (name the project anything, e.g. "Label Receiver")

## Step 3: Deploy the Apps Script
1. Click **Deploy > New deployment**
2. Click the gear icon next to "Select type" and choose **Web app**
3. Set:
   - Description: "Label Receiver"
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. Authorize the app when prompted (click through the "unsafe" warning - it's your own script)
6. **Copy the Web App URL** - it looks like: `https://script.google.com/macros/s/XXXX/exec`

## Step 4: Configure the Labeler
1. Open the labeler at https://tradermathe.github.io/boxing-labeler/
2. Paste the Web App URL into the "Apps Script URL" field in the top bar
3. Click "Save"

That's it! Labels will now auto-save to your Google Sheet in real time. No login required for labelers.
