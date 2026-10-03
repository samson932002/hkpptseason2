// HKPPT Season 2 — Match score mirror (Google Sheet)
//
// Receives a copy of every score the helpers save on the website's
// /staff page (現場計分 Live Scoring) and keeps two tabs in THIS spreadsheet up to date:
//
//   Matches — one row per match: date/time/venue/court, both teams, the
//             cumulative score after each leg (WD, XD1, XD2, XD3, MD), the
//             final score, winner and status. Updated in place every save.
//   Legs    — one row per leg played: which two players each team put out,
//             the cumulative score after the leg, and the points each team
//             scored IN that leg (for individual / pair stats later).
//
// Netlify Database is the real source of truth — this sheet is a
// human-readable mirror. If it's ever out of sync, re-saving a leg for that
// match on the website rewrites both tabs for that match.
//
// SETUP (one time)
// 1. Open the Google Sheet "HKPPT Season 2 - Match Scores"
//    (https://docs.google.com/spreadsheets/d/1bTxG59-JtFutfZ9hBbuBr9jj5q9mPOEhZwLvus-PIoE/edit).
// 2. Extensions > Apps Script. Delete the placeholder code, paste this whole
//    file in, and Save.
// 3. Deploy > New deployment > gear icon > Web app.
//      Execute as: Me
//      Who has access: Anyone
//    Deploy, then authorize (Advanced > Go to project (unsafe) > Allow).
// 4. Open the .../exec URL in a private window — you should see
//    {"ok":true,"matchScores":true}.
// 5. In Netlify: Project configuration > Environment variables, add
//      MATCH_SCORES_GAS_API_URL = <that URL>
//    then redeploy (env var changes need a new deploy).
//
// OPTIONAL — pre-fill the Matches tab with all 140 round-robin matches
// (so the sheet doubles as a full results table from day one): set SITE_URL
// below to the website's address, pick "setupSchedule" in the function
// dropdown at the top of the Apps Script editor, and press Run once.
// Existing rows are never duplicated — each match keeps one row, and live
// scores fill it in as they're saved.
//
// To change this script later, redeploy as a NEW VERSION of the SAME
// deployment (Deploy > Manage deployments > pencil > Version: New version)
// so the URL — and the env var — stays the same.

const SITE_URL = ''; // e.g. 'https://your-site.netlify.app' — only needed for setupSchedule()

const LEG_ORDER = ['WD', 'XD1', 'XD2', 'XD3', 'MD'];
const DIVISION_EN = { Premier: 'Diamond', Championship: 'Platinum', Challenger: 'Gold', Development: 'Silver', Rookie: 'Bronze' };
const TZ = 'Asia/Hong_Kong';

const MATCH_HEADERS = [
  'Match ID', '日期 Date', '時間 Time', '場地 Venue', '球場 Court', '組別 Division',
  '隊伍A Team A', '隊伍B Team B',
  'WD (A-B)', 'XD1 (A-B)', 'XD2 (A-B)', 'XD3 (A-B)', 'MD (A-B)',
  '最終比分 Final (A-B)', '勝方 Winner', '狀態 Status', '更新時間 Updated',
];

const LEG_HEADERS = [
  'Match ID', '日期 Date', '組別 Division', '局 Leg',
  '隊伍A Team A', '隊伍A球員 Team A Players', '隊伍B Team B', '隊伍B球員 Team B Players',
  '累積比分A Cum A', '累積比分B Cum B', '本局得分A Leg Pts A', '本局得分B Leg Pts B', '記錄時間 Entered',
];

function doGet() {
  return jsonOut({ ok: true, matchScores: true });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.action === 'upsertMatch') {
      upsertMatch(p);
      return jsonOut({ ok: true });
    }
    if (p.action === 'clearMatch') {
      removeRows(ensureSheet('Matches', MATCH_HEADERS), p.matchId);
      removeRows(ensureSheet('Legs', LEG_HEADERS), p.matchId);
      return jsonOut({ ok: true });
    }
    return jsonOut({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function upsertMatch(p) {
  const meta = p.meta || {};
  const legs = p.legs || [];
  const aLabel = meta.teamALabel || p.teamA;
  const bLabel = meta.teamBLabel || p.teamB;
  const byLeg = {};
  legs.forEach(function (l) { byLeg[l.leg] = l; });
  const last = legs.length ? legs[legs.length - 1] : null;
  const winnerLabel = p.winner ? (p.winner === p.teamA ? aLabel : bLabel) : '';
  const status = p.status === 'final' ? '已完結 Final' : '進行中 In progress';

  const row = [
    p.matchId, meta.date || meta.isoDate || '', meta.time || '', meta.venue || '', meta.court || '',
    meta.divisionZh || '', aLabel, bLabel,
  ].concat(LEG_ORDER.map(function (leg) {
    const l = byLeg[leg];
    return l ? (l.teamA + '-' + l.teamB) : '';
  })).concat([
    last ? (last.teamA + '-' + last.teamB) : '',
    winnerLabel,
    status,
    fmt(p.updatedAt),
  ]);

  const matches = ensureSheet('Matches', MATCH_HEADERS);
  const r = findRow(matches, p.matchId);
  // Leading apostrophe keeps "20-14" as text instead of Sheets turning it into a date.
  const safeRow = row.map(function (v, i) { return (i >= 8 && i <= 13 && v) ? "'" + v : v; });
  if (r) matches.getRange(r, 1, 1, safeRow.length).setValues([safeRow]);
  else matches.appendRow(safeRow);

  const legSheet = ensureSheet('Legs', LEG_HEADERS);
  removeRows(legSheet, p.matchId);
  let prevA = 0, prevB = 0;
  const legRows = legs.map(function (l) {
    const pa = (p.lineupA && p.lineupA[l.leg]) ? p.lineupA[l.leg].join(' / ') : '';
    const pb = (p.lineupB && p.lineupB[l.leg]) ? p.lineupB[l.leg].join(' / ') : '';
    const out = [p.matchId, meta.date || meta.isoDate || '', meta.divisionZh || '', l.leg,
      aLabel, pa, bLabel, pb, l.teamA, l.teamB, l.teamA - prevA, l.teamB - prevB, fmt(l.enteredAt)];
    prevA = l.teamA; prevB = l.teamB;
    return out;
  });
  if (legRows.length) {
    legSheet.getRange(legSheet.getLastRow() + 1, 1, legRows.length, LEG_HEADERS.length).setValues(legRows);
  }
}

function setupSchedule() {
  if (!SITE_URL) throw new Error('Set SITE_URL at the top of the script first.');
  const base = SITE_URL.replace(/\/+$/, '');
  const schedule = JSON.parse(UrlFetchApp.fetch(base + '/schedule.json').getContentText());
  const divisions = JSON.parse(UrlFetchApp.fetch(base + '/divisions.json').getContentText());
  const idOf = {}, nameOf = {}, zhOf = {};
  divisions.divisions.forEach(function (d) {
    zhOf[d.code] = d.zh;
    d.teams.forEach(function (t) { idOf[t.team] = t.id; nameOf[t.team] = t.displayName || t.team; });
  });
  const label = function (team) { return (idOf[team] ? idOf[team] + ' ' : '') + nameOf[team]; };
  const sh = ensureSheet('Matches', MATCH_HEADERS);
  const n = sh.getLastRow() - 1;
  const existing = {};
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach(function (r) { existing[r[0]] = true; });
  const rows = [];
  schedule.groupStage.forEach(function (m) {
    const id = m.division + '__' + (idOf[m.teamA] || m.teamA) + '__' + (idOf[m.teamB] || m.teamB);
    if (existing[id]) return;
    rows.push([id, m.dateLabel + '（' + m.weekday + '）', m.time, m.venueZh, m.court ? String(m.court) : '',
      (zhOf[m.division] || m.division) + ' ' + (DIVISION_EN[m.division] || ''), label(m.teamA), label(m.teamB),
      '', '', '', '', '', '', '', '未開始 Not started', '']);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, MATCH_HEADERS.length).setValues(rows);
}

function ensureSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    const first = ss.getSheets()[0];
    if (name === 'Matches' && first && String(first.getRange(1, 1).getValue()) === 'Match ID') {
      first.setName('Matches');
      sh = first;
    } else {
      sh = ss.insertSheet(name);
    }
  }
  if (String(sh.getRange(1, 1).getValue()) !== headers[0]) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRow(sh, matchId) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === matchId) return i + 2;
  return 0;
}

function removeRows(sh, matchId) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] === matchId) sh.deleteRow(i + 2);
}

function fmt(iso) {
  if (!iso) return '';
  try { return Utilities.formatDate(new Date(iso), TZ, 'yyyy-MM-dd HH:mm:ss'); } catch (e) { return String(iso); }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
