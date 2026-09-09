// HKPPT Season 2 — Lineup submissions Google Sheet mirror
//
// Netlify Database is now the real source of truth for the lineup tab (see
// netlify/functions/roster.mts) — this Sheet is a best-effort, human
// readable backup only. A slow or dead sheet no longer blocks a captain's
// submission or an organizer's reopen.
//
// 'submit' always UPSERTS: any existing rows for that team are deleted and
// replaced with the new set, so a captain who edits and resubmits after the
// organizer reopens their lineup ends up with exactly one current set of
// rows for their team — never duplicates, never stale leftovers. The
// already-submitted / locked check that used to live here has moved to
// roster.mts (backed by the database), so this script no longer needs to
// reject a second submission itself.
//
// THIS REPLACES THE SCRIPT ALREADY DEPLOYED BEHIND YOUR LINEUP SHEET.
// It doesn't care what your header row (row 1) actually says — it only
// reads and writes columns by position, in the same order already in use:
// Team, Name, Preferred Name, Gender, DUPR ID, DUPR, Submitted At,
// Avg DUPR, Male Count, Female Count. So this is safe to drop in regardless
// of the exact header text already in your sheet.
//
// SETUP (updating your existing deployment)
// 1. Open the Apps Script project behind your lineup Sheet — from the Sheet:
//    Extensions > Apps Script (or find it at script.google.com/home).
// 2. Select all the existing code and replace it with this whole file. Save.
// 3. Deploy > Manage deployments > pencil icon on the existing deployment >
//    Version: New version > Deploy. This keeps the same .../exec URL, so
//    GAS_API_URL in Netlify (or the site's built-in default) does NOT need
//    to change — no redeploy of the Netlify site is required for this step
//    alone.
// 4. Optional self-check: open the .../exec URL in a private/incognito
//    window — you should see {"ok":true,"rows":[...]} same as before.

function doGet(e) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  const rows = values
    .filter(r => r[0])
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = r[i]);
      return obj;
    });
  return jsonOut({ ok: true, rows: rows });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const sheet = getSheet();

    if (payload.action === 'submit') {
      deleteTeamRows(sheet, payload.team);
      const savedAt = payload.submittedAt || new Date().toISOString();
      (payload.players || []).forEach(p => {
        sheet.appendRow([
          payload.team,
          p.name || '',
          p.preferredName || '',
          p.gender || '',
          p.duprId || '',
          p.dupr || '',
          savedAt,
          payload.avgDupr || 0,
          payload.maleCount || 0,
          payload.femaleCount || 0
        ]);
      });
      return jsonOut({ ok: true, savedAt: savedAt });
    }

    return jsonOut({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheets()[0];
}

function findTeamRowIndexes(sheet, team) {
  const values = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === team) out.push(i + 1); // 1-indexed sheet rows
  }
  return out;
}

function deleteTeamRows(sheet, team) {
  const rowIndexes = findTeamRowIndexes(sheet, team);
  for (let i = rowIndexes.length - 1; i >= 0; i--) {
    sheet.deleteRow(rowIndexes[i]);
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
