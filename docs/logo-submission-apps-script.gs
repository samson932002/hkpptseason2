// HKPPT Season 2 — Team logo submissions
//
// Same pattern as payment-receipts-apps-script.gs: Google Drive holds the
// actual logo file; Netlify Database only stores metadata (team, division,
// file id/link, timestamp). netlify/functions/logo.mts treats a failed call
// to this script as a failed submission, on purpose — the logo photo has
// nowhere else to live.
//
// Filenames are exactly "<Team Name>_<Division in Chinese>.<ext>" (e.g.
// "The Pickleball Lab_超級組.png") per the organizer's request, for easy
// sorting in Drive — no extra id or timestamp junk, just the file extension
// so the image still opens correctly.
//
// One current logo per team: uploading again trashes the team's previous
// logo file and stores the new one, matching how the rest of the site
// treats resubmission (payment receipts, lineup, etc.).
//
// SETUP
// 1. This script is NOT bound to a Sheet — create it standalone instead:
//    script.google.com/home > New project. (A Drive folder already exists
//    for these logos: "HKPPT Season 2 - Team Logos", id
//    1jAaaJ9ecOw3Mum8sqejD--m-D7xyJvTU — FOLDER_ID below is already set to
//    it. If you'd rather use your own folder, open/create it in Drive,
//    copy the id out of its URL, and replace FOLDER_ID.)
// 2. Delete the placeholder code, paste this whole file in. Save.
// 3. Deploy > New deployment > gear icon > Web app.
//      Execute as: Me
//      Who has access: Anyone
//    Deploy, then authorize (Advanced > Go to project (unsafe) > Allow).
// 4. Before doing anything else, open the resulting .../exec URL yourself
//    in a private/incognito window and confirm you see
//    {"ok":true,"logos":true} — same check as the payment receipts script.
// 5. In the Netlify site: Site configuration > Environment variables, add
//      LOGO_GAS_API_URL = <that URL>
//    Redeploy the site (env var changes need a new deploy).
//
// To change this script later, redeploy it as a NEW VERSION of the SAME
// deployment (Deploy > Manage deployments > pencil icon > Version: New
// version > Deploy) so the URL — and the env var — doesn't change.

const FOLDER_ID = '1jAaaJ9ecOw3Mum8sqejD--m-D7xyJvTU';

function doGet(e) {
  return jsonOut({ ok: true, logos: true });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const folder = DriveApp.getFolderById(FOLDER_ID);

    if (payload.action === 'upload') {
      trashExisting(folder, payload.team);

      const bytes = Utilities.base64Decode(payload.dataBase64);
      const ext = extensionFor(payload.mimeType, payload.filename);
      const safeName = `${sanitize(payload.team)}_${sanitize(payload.divisionZh)}${ext}`;
      const blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', safeName);
      const file = folder.createFile(blob);
      file.setDescription(payload.team);

      return jsonOut({ ok: true, fileId: file.getId(), viewUrl: file.getUrl() });
    }

    if (payload.action === 'clear') {
      trashExisting(folder, payload.team);
      return jsonOut({ ok: true });
    }

    return jsonOut({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// Team is encoded as both the file's Description and a filename prefix;
// matching on Description is the reliable one (filenames get sanitized).
function trashExisting(folder, team) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getDescription() === team) {
      f.setTrashed(true);
    }
  }
}

function extensionFor(mimeType, filename) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  };
  if (map[mimeType]) return map[mimeType];
  const m = /\.[a-zA-Z0-9]+$/.exec(String(filename || ''));
  return m ? m[0].toLowerCase() : '';
}

function sanitize(name) {
  return String(name).replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 80);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
