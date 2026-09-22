// HKPPT Season 2 — Team acknowledgment (waiver) records
//
// Unlike payment-receipts / logo-submission, this is a BEST-EFFORT mirror,
// same spirit as availability-sheet-apps-script.gs: Netlify Database is the
// real source of truth for a team's acknowledgment (captain name, date,
// submitted_at) — a dead or unconfigured script here must never fail a
// captain's submission. This script just gives the organizer a
// human-readable, auditable copy of each team's signed waiver as an actual
// file in Drive, since that was asked for specifically.
//
// One text file per team, named "<Team Name> - Acknowledgment.txt", holding
// the captain's name, the date, and the full bilingual waiver text they
// agreed to. Re-submitting replaces the team's previous file.
//
// SETUP
// 1. This script is NOT bound to a Sheet — create it standalone instead:
//    script.google.com/home > New project. (A Drive folder already exists
//    for these records: "HKPPT Season 2 - Team Acknowledgments", id
//    1BWJdbeUGNoXfuk6lX0tQCHEoGC-oUaUd — FOLDER_ID below is already set to
//    it.)
// 2. Delete the placeholder code, paste this whole file in. Save.
// 3. Deploy > New deployment > gear icon > Web app.
//      Execute as: Me
//      Who has access: Anyone
//    Deploy, then authorize (Advanced > Go to project (unsafe) > Allow).
// 4. Open the resulting .../exec URL yourself in a private/incognito window
//    and confirm you see {"ok":true,"acknowledgments":true}.
// 5. In the Netlify site: Site configuration > Environment variables, add
//      ACKNOWLEDGMENT_GAS_API_URL = <that URL>
//    Redeploy the site (env var changes need a new deploy).
//
// To change this script later, redeploy it as a NEW VERSION of the SAME
// deployment so the URL — and the env var — doesn't change.

const FOLDER_ID = '1BWJdbeUGNoXfuk6lX0tQCHEoGC-oUaUd';

function doGet(e) {
  return jsonOut({ ok: true, acknowledgments: true });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const folder = DriveApp.getFolderById(FOLDER_ID);

    if (payload.action === 'record') {
      trashExisting(folder, payload.team);

      const safeName = `${sanitize(payload.team)} - Acknowledgment.txt`;
      const content = buildRecordText(payload);
      const blob = Utilities.newBlob(content, 'text/plain', safeName);
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

function buildRecordText(payload) {
  return [
    'HKPPT Season 2 — 隊伍確認聲明 Team Acknowledgment',
    '========================================================',
    `隊伍 Team：${payload.team || ''}`,
    `隊長全名 Captain's Full Name：${payload.captainName || ''}`,
    `日期 Date：${payload.date || ''}`,
    `提交時間 Submitted At：${payload.submittedAt || ''}`,
    `已確認將分享畀全隊隊員 Confirmed shared with team members：${payload.shared ? '是 Yes' : '否 No'}`,
    '',
    '隊長已代表全隊確認閱讀、理解並同意以下條款：',
    'The captain confirmed, on behalf of the whole team, having read, understood, and agreed to the following terms:',
    '',
    payload.waiverText || '',
  ].join('\n');
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
