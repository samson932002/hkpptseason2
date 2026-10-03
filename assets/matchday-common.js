// HKPPT Season 2 — shared helpers for the two match-day pages:
//   /match  — captains submit each match's 5-leg lineup
//   /staff  — helpers record leg-by-leg scores (organizer passcode)
//
// The public information site (/index.html) is deliberately separate and
// doesn't load this file. The helpers below mirror the ones in index.html
// (same data files, same team identifiers / display names, same division
// labels) so all three pages always show teams and divisions identically.
// If a division label, colour or team-name rule changes in index.html,
// change it here too.

const ROSTER_API = "/api/roster";
const MATCH_LINEUP_API = "/api/match-lineup";
const MATCH_SCORE_API = "/api/match-score";

const PASSCODE_UNSET_MSG = "大會密碼未設定，請於網站設定 ADMIN_PASSCODE。Organizer passcode is not configured — set ADMIN_PASSCODE in the site settings.";

// Index i matches divisionOrder[i] in schedule.json / divisions.json.
const DIVISIONS = [
  { name: "鑽石組 Diamond", color: "#B3E9FF", text: "#001F3D" },
  { name: "白金組 Platinum", color: "#A6DED3", text: "#001F3D" },
  { name: "金組 Gold", color: "#F4CC5A", text: "#001F3D" },
  { name: "銀組 Silver", color: "#CDD2D8", text: "#001F3D" },
  { name: "銅組 Bronze", color: "#DDA46F", text: "#001F3D" },
];

// Internal division codes never change; only the public label does.
const DIVISION_EN_LABEL = {
  Premier: "Diamond",
  Championship: "Platinum",
  Challenger: "Gold",
  Development: "Silver",
  Rookie: "Bronze",
};

function el(id) { return document.getElementById(id); }

function showToast(msg, isError) {
  const t = el("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { t.className = "toast"; }, 2800);
}

function formatSavedAt(iso) {
  try {
    return new Date(iso).toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong" });
  } catch (e) {
    return iso;
  }
}

async function postAction(api, payload) {
  const res = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ── Schedule ──────────────────────────────────────────────────────────────
let SCHEDULE_DATA = null;

async function loadScheduleData() {
  if (SCHEDULE_DATA) return SCHEDULE_DATA;
  const res = await fetch("/schedule.json", { cache: "no-store" });
  if (!res.ok) throw new Error("schedule_fetch_failed");
  SCHEDULE_DATA = await res.json();
  return SCHEDULE_DATA;
}

function divisionMeta(code) {
  const idx = (SCHEDULE_DATA.divisionOrder || []).indexOf(code);
  const d = DIVISIONS[idx] || { name: code, color: "#EEF3FA", text: "#001F3D" };
  return { code, en: DIVISION_EN_LABEL[code] || code, label: d.name, color: d.color, text: d.text, zh: (SCHEDULE_DATA.divisionZh || {})[code] || code };
}

// ── Teams (identifiers A1–E8 + public display names) ─────────────────────
let DIVISIONS_DATA = null;
let DIVISIONS_PROMISE = null;
let TEAM_ID = {};
let TEAM_ORDER = [];
// A team's key (e.g. "Dink9") is what every DB record and schedule.json use;
// a renamed team only gets a "displayName" in divisions.json.
let TEAM_DISPLAY = {};

function buildTeamIndex() {
  TEAM_ID = {};
  TEAM_ORDER = [];
  TEAM_DISPLAY = {};
  (DIVISIONS_DATA.divisionOrder || []).forEach(code => {
    const div = (DIVISIONS_DATA.divisions || []).find(d => d.code === code);
    if (!div) return;
    div.teams.forEach(t => {
      if (t.id) TEAM_ID[t.team] = t.id;
      if (t.displayName) TEAM_DISPLAY[t.team] = t.displayName;
      TEAM_ORDER.push(t.team);
    });
  });
}

function teamName(team) { return TEAM_DISPLAY[team] || team; }

function idLabel(team) {
  const id = TEAM_ID[team];
  return id ? `${id} ${teamName(team)}` : teamName(team);
}

async function loadDivisionsData() {
  if (DIVISIONS_DATA) return DIVISIONS_DATA;
  if (!DIVISIONS_PROMISE) {
    DIVISIONS_PROMISE = (async () => {
      const res = await fetch("/divisions.json", { cache: "no-store" });
      if (!res.ok) throw new Error("divisions_fetch_failed");
      DIVISIONS_DATA = await res.json();
      buildTeamIndex();
      return DIVISIONS_DATA;
    })();
  }
  return DIVISIONS_PROMISE;
}

// ── Match structure ──────────────────────────────────────────────────────
// 5 fixed legs, one continuous relay to 100. A leg ends the moment either
// team's running total reaches that leg's target (rulebook 3.3) — the target
// is fixed per leg (WD 20, XD1 40, XD2 60, XD3 80, MD 100), not "any multiple
// of 20": a team can pass 40 during XD2 without ending it (worked example 3.5).
const LEG_ORDER = ["WD", "XD1", "XD2", "XD3", "MD"];
const LEG_TARGET = { WD: 20, XD1: 40, XD2: 60, XD3: 80, MD: 100 };
const LEG_LABEL = {
  WD: "女雙 Women's Doubles (WD)",
  XD1: "混雙一 Mixed Doubles 1 (XD1)",
  XD2: "混雙二 Mixed Doubles 2 (XD2)",
  XD3: "混雙三 Mixed Doubles 3 (XD3)",
  MD: "男雙 Men's Doubles (MD)",
};
const LEG_LABEL_SHORT = { WD: "WD 女雙", XD1: "XD1 混雙1", XD2: "XD2 混雙2", XD3: "XD3 混雙3", MD: "MD 男雙" };
// Which gender fills each of a leg's 2 slots.
const LEG_SLOT_GENDER = { WD: ["F", "F"], XD1: ["M", "F"], XD2: ["M", "F"], XD3: ["M", "F"], MD: ["M", "M"] };

// Stable key for a match: "<teamA id>-<teamB id>", e.g. "A1-A3". Each pair
// meets once in the round robin, so this is unique, and the letter already
// says the division (A = Diamond … E = Bronze). No division *name* in the
// key on purpose, so renaming a division never breaks the link between the
// website, the database and the scores sheet. (The division argument is
// kept so callers don't change.)
function buildMatchId(division, teamA, teamB) {
  const idA = TEAM_ID[teamA] || teamA;
  const idB = TEAM_ID[teamB] || teamB;
  return `${idA}-${idB}`;
}

// ── "Today first" ordering ───────────────────────────────────────────────
// Both pages are mostly used on the day itself, so today's matches (Hong
// Kong time) are listed first. For testing before the season starts, add
// ?today=2026-10-10 to the page address to pretend it's that date.
function hkToday() {
  const override = new URLSearchParams(location.search).get("today");
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

// Splits [{..., date}] into today / upcoming / earlier groups, keeping each
// item's original index so <option value> still points into the full list.
function groupByToday(items) {
  const today = hkToday();
  const withIdx = items.map((m, idx) => ({ m, idx }));
  return [
    { key: "today", label: "📍 今日比賽 Today", rows: withIdx.filter(x => x.m.date === today) },
    { key: "upcoming", label: "即將舉行 Upcoming", rows: withIdx.filter(x => x.m.date > today) },
    { key: "earlier", label: "已完結 Earlier", rows: withIdx.filter(x => x.m.date < today) },
  ].filter(g => g.rows.length);
}

function appendGroupedOptions(sel, groups, labelFn) {
  groups.forEach(g => {
    const og = document.createElement("optgroup");
    og.label = g.label;
    g.rows.forEach(({ m, idx }) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = labelFn(m);
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
}
