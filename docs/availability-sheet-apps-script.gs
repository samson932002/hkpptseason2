// HKPPT Season 2 — Availability survey Google Sheet mirror
//
// This is a courtesy, human-readable BACKUP of the availability survey.
// Netlify Database is the real source of truth for the site (see
// netlify/functions/availability.mts) — this sheet is one-way and
// best-effort: if it's slow, wrong, or unreachable, captains can still
// submit the survey normally. Nothing here is ever read back by the site.
//
// One row per team, upserted by Team (updated in place on re-submission,
// same as netlify/functions/availability.mts does in Postgres).
//
// SETUP
// 1. Create a new Google Sheet (e.g. "HKPPT Season 2 - Availability").
//    First-row headers are created automatically the first time a row is
//    written, so you can leave the sheet empty.
// 2. Extensions > Apps Script. Delete the placeholder code and paste this
//    whole file in.
// 3. Save the project (any name).
// 4. Deploy > New deployment > gear icon > Web app.
//      Execute as: Me
//      Who has access: Anyone
//    Click Deploy, authorize when prompted (Advanced > Go to project
//    (unsafe) > Allow — this warning is normal for your own script).
// 5. Copy the Web app URL (ends in /exec).
// 6. In the Netlify site: Site configuration > Environment variables, add
//      AVAILABILITY_GAS_API_URL = <that URL>
//    The site works fine without this — the "同步至 Google Sheet" button in
//    the organizer view stays disabled and every submission simply skips
//    the mirror — so only add it once you actually want the backup sheet.
// 7. Redeploy the Netlify site (env var changes need a new deploy to take
//    effect) and use "同步至 Google Sheet" in the organizer view once to
//    backfill any answers submitted before the variable was set.
//
// If you ever need to change this script, redeploy it as a NEW VERSION of
// the SAME deployment (Deploy > Manage deployments > pencil icon > Version:
// New version > Deploy) so the URL — and therefore the env var — doesn't
// change.

const HEADERS = ['Team', 'Group Avoid', 'Group Count', 'Knockout Avoid', 'Knockout Count', 'Submitted At', 'Updated At'];

function doGet(e) {
  return jsonOut({ ok: true, sheet: 'availability' });
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const sheet = getSheet();

    if (payload.action === 'record') {
      const rowIndex = findTeamRow(sheet, payload.team);
      const now = new Date().toISOString();
      const rowValues = [
        payload.team,
        (payload.groupLabels || []).join(', '),
        payload.groupCount || 0,
        (payload.knockoutLabels || []).join(', '),
        payload.knockoutCount || 0,
        payload.submittedAt || now,
        now,
      ];
      if (rowIndex > 0) {
        sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([rowValues]);
      } else {
        sheet.appendRow(rowValues);
      }
      return jsonOut({ ok: true });
    }

    if (payload.action === 'clear') {
      const rowIndex = findTeamRow(sheet, payload.team);
      if (rowIndex > 0) {
        sheet.deleteRow(rowIndex);
      }
      return jsonOut({ ok: true });
    }

    return jsonOut({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheets()[0];
  ensureHeaders(sheet);
  return sheet;
}

function ensureHeaders(sheet) {
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const hasHeaders = firstRow.some(v => v !== '');
  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

// Returns the 1-indexed sheet row for a team, or -1 if it has no row yet.
function findTeamRow(sheet, team) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === team) return i + 1;
  }
  return -1;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
