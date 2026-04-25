// ─────────────────────────────────────────────────────────────────────────────
// Game Design Notebook — Drive Receiver
// Deploy this as a Google Apps Script Web App under your own Google account.
// The form (index.html) POSTs each scout's data to this script's URL silently.
// Files end up in a Drive folder of your choice (set FOLDER_ID below).
//
// SETUP (one time, ~5 minutes):
//   1. Go to https://script.google.com → "New project"
//   2. Replace the default Code.gs contents with everything in this file
//   3. (Optional) Create a Drive folder for submissions, open it, copy the
//      folder ID from the URL (the long string after /folders/), and paste
//      below as FOLDER_ID. Leave blank to drop files in your Drive root.
//   4. Click "Deploy" → "New deployment"
//        - Type: Web app
//        - Description: "Game Design Notebook receiver"
//        - Execute as: Me (your account)
//        - Who has access: Anyone
//   5. Authorize when Google prompts you (it needs Drive permission).
//   6. Copy the Web App URL (ends in /exec) and paste it into index.html
//      as the value of SAVE_URL near the top of the <script> block.
//   7. Done. Each Next click and Export action from a scout silently writes
//      a .txt file to your Drive folder, named after the scout.
//      Re-submissions OVERWRITE the existing file for that scout, so you
//      always have their latest work — no clutter.
//
// SHARING WITH COUNSELORS:
//   Just share the Drive folder with the counselors (View access). They'll
//   see one .txt file per scout, ready to read.
// ─────────────────────────────────────────────────────────────────────────────

const FOLDER_ID = ""; // <-- paste folder ID here, or leave "" for Drive root

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const folder = FOLDER_ID ? DriveApp.getFolderById(FOLDER_ID) : DriveApp.getRootFolder();

    const safeName = sanitize(payload.scoutName || "anonymous");
    const safeTroop = sanitize(payload.troop || "");
    const base = `gamedesign_${safeName}${safeTroop ? "_" + safeTroop : ""}`;
    const txtName = base + ".txt";
    const jsonName = base + ".json";

    // Readable text file (what counselors will actually read)
    upsertFile(folder, txtName, payload.exportText || "", MimeType.PLAIN_TEXT);

    // Raw JSON backup (in case you want to re-import or analyze later)
    upsertFile(folder, jsonName, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);

    return ContentService.createTextOutput(JSON.stringify({ ok: true, file: txtName }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Lets you visit the deploy URL in a browser to confirm it's live.
function doGet() {
  return ContentService.createTextOutput("Game Design Notebook receiver is live.");
}

function upsertFile(folder, filename, content, mime) {
  const existing = folder.getFilesByName(filename);
  if (existing.hasNext()) {
    existing.next().setContent(content);
  } else {
    folder.createFile(filename, content, mime);
  }
}

function sanitize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "anonymous";
}
