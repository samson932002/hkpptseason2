// HKPPT Season 2 — Payment receipt uploads
//
// Unlike the roster/availability Sheets, this is NOT a best-effort mirror —
// this script is the actual storage for receipt photos (Google Drive can
// hold files; Netlify Database only stores small JSON documents, so it
// holds the metadata — team, file id/link, timestamp — while this script
// holds the file itself). netlify/functions/payment.mts treats a failed
// call to this script as a failed submission, on purpose.
//
// One current file per team: uploading again trashes the team's previous
// receipt and stores the new one, matching how the rest of the site treats
// resubmission.
//
// SETUP
// 1. This script is NOT bound to a Sheet — create it standalone instead:
//    script.google.com/home > New project. (A Drive folder already exists
//    for these receipts: "HKPPT Season 2 - Payment Receipts", id
//    1vfXRZd1b29FT2nND-NIZxafeTqQBZXLj — FOLDER_ID below is already set to
//    it. If you'd rather use your own folder, open/create it in Drive,
//    copy the id out of its URL, and replace FOLDER_ID.)
// 2. Delete the placeholder code, paste this whole file in. Save.
// 3. Deploy > New deployment > gear icon > Web app.
//      Execute as: Me
//      Who has access: Anyone
//    Deploy, then authorize (Advanced > Go to project (unsafe) > Allow).
// 4. Before doing anything else, open the resulting .../exec URL yourself
//    in a private/incognito window and confirm you see
//    {"ok":true,"receipts":true} — this is the same check that caught the
//    availability sheet's broken deployment earlier, do it every time.
// 5. In the Netlify site: Site configuration > Environment variables, add
//      PAYMENT_GAS_API_URL = <that URL>
//    Redeploy the site (env var changes need a new deploy).
//
// To change this script later, redeploy it as a NEW VERSION of the SAME
// deployment (Deploy > Manage deployments > pencil icon > Version: New
// version > Deploy) so the URL — and the env var — doesn't change.

const FOLDER_ID = '1vfXRZd1b29FT2nND-NIZxafeTqQBZXLj';

function doGet(e) {
  return jsonOut({ ok: true, receipts: true });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const folder = DriveApp.getFolderById(FOLDER_ID);

    if (payload.action === 'upload') {
      trashExisting(folder, payload.team);

      const bytes = Utilities.base64Decode(payload.dataBase64);
      const safeName = `${sanitize(payload.team)}__${Date.now()}__${sanitize(payload.filename || 'receipt')}`;
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

function sanitize(name) {
  return String(name).replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 80);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
