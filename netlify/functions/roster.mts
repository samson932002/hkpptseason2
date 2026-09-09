// Lineup submissions. Netlify Database (roster_submissions, one row per
// team, unique on team) is the real source of truth — a captain's roster,
// stats, and lock state all live there. The Google Sheet ("HKPPT Season 2 -
// Lineup Submissions") behind GAS_API_URL is now a best-effort, human
// readable mirror only, matching the pattern used by the availability and
// payment tabs: a dead or slow sheet must never fail a captain's submission.
//
// Locking: once a team submits, further submissions are rejected with
// already_submitted until the organizer reopens that team specifically
// (action: 'reopen'). Reopening does NOT clear or touch anything — the
// team's existing roster stays exactly as submitted and is served back to
// them prefilled so they can edit it, and only the next actual resubmission
// replaces it (in both Netlify Database and, best-effort, the Sheet).
//
// Backward compatibility: teams that already submitted before this update
// shipped only exist in the Google Sheet, not yet in roster_submissions.
// Every read and write below falls back to the Sheet for a team with no DB
// row yet, using only the same column keys ('Team', 'Gender', 'DUPR',
// 'Submitted At') the site has always relied on. The one case that needs
// more than that — an organizer reopening a legacy, not-yet-migrated team —
// does a best-effort import of the full roster from the Sheet first; if the
// sheet's extra columns (name / preferred name / DUPR ID) don't match the
// guessed header text exactly, those fields just come back blank for the
// captain to retype, while gender and DUPR (already known-good keys) carry
// over correctly either way.

import { getDatabase } from '@netlify/database'

const DEFAULT_GAS_URL =
  'https://script.google.com/macros/s/AKfycbzPZEgvU7VdUyhkGkVDgl7o8gmSRVQbuMX-s52Vk4sCl-akqSqO5rThET0E5Yqz7IsXQA/exec'

const NR_VALUE = 2.75

type Row = Record<string, unknown>

type Player = {
  name?: unknown
  preferredName?: unknown
  gender?: unknown
  duprId?: unknown
  dupr?: unknown
}

type DbRow = {
  team: string
  players: unknown
  avg_dupr: number | string
  male_count: number
  female_count: number
  reopened: boolean
  submitted_at: string
}

function gasUrl(): string {
  return Netlify.env.get('GAS_API_URL') || DEFAULT_GAS_URL
}

// No fallback on purpose: if ADMIN_PASSCODE is unset the organizer endpoints
// refuse to run rather than accepting a value baked into the source.
function configuredPasscode(): string | undefined {
  const value = Netlify.env.get('ADMIN_PASSCODE')
  return value && value.length > 0 ? value : undefined
}

// Returns a rejection Response when the supplied passcode is missing, wrong,
// or when no passcode has been configured for the site at all.
function rejectPasscode(supplied: unknown): Response | null {
  const expected = configuredPasscode()
  if (!expected) {
    return Response.json({ ok: false, error: 'passcode_not_configured' }, { status: 503 })
  }
  if (typeof supplied !== 'string' || supplied !== expected) {
    return Response.json({ ok: false, error: 'invalid_passcode' }, { status: 401 })
  }
  return null
}

// Strict on purpose: parseFloat("5abc") === 5, so a naive parseFloat check
// would silently accept garbage like "5abc" as a valid 5.0 rating. Only an
// exact plain number (or NR) is treated as valid. Kept in sync with the
// identical check in index.html.
const DUPR_NUMBER_RE = /^\d+(\.\d+)?$/

function isValidDuprInput(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return true // not filled in — allowed
  const trimmed = String(raw).trim()
  if (trimmed.toUpperCase() === 'NR') return true
  return DUPR_NUMBER_RE.test(trimmed)
}

function resolveDupr(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const trimmed = String(raw).trim()
  if (trimmed.toUpperCase() === 'NR') return NR_VALUE
  if (!DUPR_NUMBER_RE.test(trimmed)) return null
  const n = parseFloat(trimmed)
  return Number.isNaN(n) ? null : n
}

function top3Sum(values: number[]): number {
  return [...values].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0)
}

// Legacy shape: raw Sheet rows keyed by header text ('Gender', 'DUPR', …).
function computeStats(rows: Row[]) {
  const males = rows
    .filter((r) => r['Gender'] === 'M')
    .map((r) => resolveDupr(r['DUPR']))
    .filter((v): v is number => v !== null)
  const females = rows
    .filter((r) => r['Gender'] === 'F')
    .map((r) => resolveDupr(r['DUPR']))
    .filter((v): v is number => v !== null)
  const avgDupr =
    males.length >= 3 && females.length >= 3 ? (top3Sum(males) + top3Sum(females)) / 6 : 0
  return { avgDupr, maleCount: males.length, femaleCount: females.length }
}

// Current shape: player objects as submitted by the client (lowercase keys).
function computeStatsFromPlayers(players: Player[]) {
  const resolved = players.map((p) => ({ gender: p.gender, val: resolveDupr(p.dupr) }))
  const males = resolved.filter((p) => p.gender === 'M' && p.val !== null).map((p) => p.val as number)
  const females = resolved.filter((p) => p.gender === 'F' && p.val !== null).map((p) => p.val as number)
  const avgDupr =
    males.length >= 3 && females.length >= 3 ? (top3Sum(males) + top3Sum(females)) / 6 : 0
  return { avgDupr, maleCount: males.length, femaleCount: females.length }
}

async function fetchAllRows(): Promise<Row[]> {
  const res = await fetch(gasUrl(), { method: 'GET' })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'gas_error')
  return data.rows as Row[]
}

// Best-guess header text for the columns the site has never needed to read
// back before now — falls back to an empty string per field rather than
// throwing, so an imperfect guess just means a blank field to retype, never
// a broken reopen.
function pick(row: Row, candidates: string[]): string {
  for (const c of candidates) {
    const v = row[c]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
  }
  return ''
}

function playersFromLegacyRows(rows: Row[]): Player[] {
  return rows.map((r) => ({
    name: pick(r, ['Name', 'Full Name', 'English Name']),
    preferredName: pick(r, ['Preferred Name', 'Preferred name']),
    gender: pick(r, ['Gender', 'Sex']),
    duprId: pick(r, ['DUPR ID', 'DUPR Id', 'Dupr Id']),
    dupr: pick(r, ['DUPR', 'DUPR Rating']),
  }))
}

// Fire-and-forget-with-a-timeout: awaited so it gets a real chance to run
// before the function returns, but never allowed to fail or slow down the
// caller's own outcome.
async function mirrorReplaceToSheet(
  team: string,
  players: Player[],
  stats: { avgDupr: number; maleCount: number; femaleCount: number },
  submittedAt: string,
): Promise<void> {
  try {
    await fetch(gasUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'submit',
        team,
        players,
        avgDupr: stats.avgDupr,
        maleCount: stats.maleCount,
        femaleCount: stats.femaleCount,
        submittedAt,
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    // Best-effort only — Netlify Database is the real source of truth now,
    // so a dead or slow sheet must never fail a captain's submission.
  }
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const db = getDatabase()

  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected

      const dbRows = (await db.sql<DbRow>`
        SELECT team, avg_dupr, male_count, female_count, reopened, submitted_at FROM roster_submissions
      `) as unknown as DbRow[]
      const dbByTeam = new Map(dbRows.map((r) => [r.team, r]))

      let legacyTeams: { team: string; submittedAt: string | null; avgDupr: number; maleCount: number; femaleCount: number }[] = []
      try {
        const legacyRows = await fetchAllRows()
        const byTeam = new Map<string, Row[]>()
        for (const r of legacyRows) {
          const t = String(r['Team'])
          if (dbByTeam.has(t)) continue // DB is authoritative once a team is migrated
          if (!byTeam.has(t)) byTeam.set(t, [])
          byTeam.get(t)!.push(r)
        }
        legacyTeams = [...byTeam.entries()].map(([team, teamRows]) => ({
          team,
          submittedAt: (teamRows[0]?.['Submitted At'] as string) || null,
          ...computeStats(teamRows),
        }))
      } catch {
        // Legacy sheet unreachable — teams already migrated into Netlify
        // Database still show up correctly; older not-yet-touched teams are
        // just temporarily missing rather than failing the whole view.
      }

      const teams = [
        ...[...dbByTeam.values()].map((r) => ({
          team: r.team,
          submittedAt: r.submitted_at,
          avgDupr: Number(r.avg_dupr),
          maleCount: r.male_count,
          femaleCount: r.female_count,
          reopened: r.reopened,
        })),
        ...legacyTeams.map((t) => ({ ...t, reopened: false })),
      ]

      return Response.json({ ok: true, teams })
    }

    const team = url.searchParams.get('team') || ''
    if (!team) {
      return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
    }

    const dbRows = (await db.sql<DbRow>`
      SELECT players, avg_dupr, male_count, female_count, reopened, submitted_at
      FROM roster_submissions WHERE team = ${team}
    `) as unknown as DbRow[]

    if (dbRows.length > 0) {
      const r = dbRows[0]
      if (r.reopened) {
        // Reopened: the team gets its own full roster back so the form can
        // prefill it for editing. avgDupr is still withheld either way.
        return Response.json({
          ok: true,
          submitted: true,
          reopened: true,
          submittedAt: r.submitted_at,
          maleCount: r.male_count,
          femaleCount: r.female_count,
          players: r.players,
        })
      }
      return Response.json({
        ok: true,
        submitted: true,
        reopened: false,
        submittedAt: r.submitted_at,
        maleCount: r.male_count,
        femaleCount: r.female_count,
      })
    }

    // No DB row yet — fall back to the legacy Sheet, same as before this
    // update.
    let legacyRows: Row[]
    try {
      legacyRows = (await fetchAllRows()).filter((r) => r['Team'] === team)
    } catch {
      return Response.json({ ok: false, error: 'upstream_error' }, { status: 502 })
    }
    if (legacyRows.length === 0) {
      return Response.json({ ok: true, submitted: false })
    }
    const { maleCount, femaleCount } = computeStats(legacyRows)
    return Response.json({
      ok: true,
      submitted: true,
      reopened: false,
      submittedAt: (legacyRows[0]['Submitted At'] as string) || null,
      maleCount,
      femaleCount,
    })
  }

  if (req.method === 'POST') {
    let payload: Record<string, unknown>
    try {
      payload = await req.json()
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
    }

    if (payload.action === 'submit') {
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      const players = payload.players

      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }
      if (!Array.isArray(players)) {
        return Response.json({ ok: false, error: 'missing_players' }, { status: 400 })
      }
      // The client already blocks submission of an invalid DUPR value, but
      // that's UX only — a direct API call must be re-checked here so a
      // garbage rating can never reach the database or the Sheet.
      for (const p of players) {
        const dupr = p && typeof p === 'object' ? (p as Player).dupr : undefined
        if (!isValidDuprInput(dupr)) {
          return Response.json({ ok: false, error: 'invalid_dupr' }, { status: 400 })
        }
      }

      const existing = (await db.sql<DbRow>`
        SELECT reopened FROM roster_submissions WHERE team = ${team}
      `) as unknown as DbRow[]

      if (existing.length > 0) {
        if (!existing[0].reopened) {
          return Response.json({ ok: false, error: 'already_submitted' })
        }
        // reopened === true: fall through, this resubmission replaces it.
      } else {
        // Not in the database yet — a legacy submission (still only in the
        // Sheet) is just as locked as one that's been migrated.
        try {
          const legacyRows = (await fetchAllRows()).filter((r) => r['Team'] === team)
          if (legacyRows.length > 0) {
            return Response.json({ ok: false, error: 'already_submitted' })
          }
        } catch {
          return Response.json({ ok: false, error: 'upstream_error' }, { status: 502 })
        }
      }

      const stats = computeStatsFromPlayers(players as Player[])
      const rows = (await db.sql<DbRow>`
        INSERT INTO roster_submissions (team, players, avg_dupr, male_count, female_count, reopened)
        VALUES (${team}, ${JSON.stringify(players)}::jsonb, ${stats.avgDupr}, ${stats.maleCount}, ${stats.femaleCount}, false)
        ON CONFLICT (team) DO UPDATE SET
          players = EXCLUDED.players,
          avg_dupr = EXCLUDED.avg_dupr,
          male_count = EXCLUDED.male_count,
          female_count = EXCLUDED.female_count,
          reopened = false,
          submitted_at = now(),
          updated_at = now()
        RETURNING submitted_at
      `) as unknown as DbRow[]
      const savedAt = rows[0].submitted_at

      await mirrorReplaceToSheet(team, players as Player[], stats, savedAt)

      return Response.json({ ok: true, savedAt, maleCount: stats.maleCount, femaleCount: stats.femaleCount })
    }

    if (payload.action === 'reopen') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }

      const existing = (await db.sql<DbRow>`
        SELECT team FROM roster_submissions WHERE team = ${team}
      `) as unknown as DbRow[]

      if (existing.length > 0) {
        await db.sql`UPDATE roster_submissions SET reopened = true, updated_at = now() WHERE team = ${team}`
        return Response.json({ ok: true })
      }

      // Legacy team, not yet in the database — import its roster from the
      // Sheet now, best-effort on the extra fields, so reopening behaves the
      // same way for every team regardless of when it originally submitted.
      let legacyRows: Row[]
      try {
        legacyRows = (await fetchAllRows()).filter((r) => r['Team'] === team)
      } catch {
        return Response.json({ ok: false, error: 'upstream_error' }, { status: 502 })
      }
      if (legacyRows.length === 0) {
        return Response.json({ ok: false, error: 'not_submitted' }, { status: 400 })
      }

      const players = playersFromLegacyRows(legacyRows)
      const stats = computeStats(legacyRows)
      const submittedAt = (legacyRows[0]['Submitted At'] as string) || new Date().toISOString()

      await db.sql`
        INSERT INTO roster_submissions (team, players, avg_dupr, male_count, female_count, reopened, submitted_at)
        VALUES (${team}, ${JSON.stringify(players)}::jsonb, ${stats.avgDupr}, ${stats.maleCount}, ${stats.femaleCount}, true, ${submittedAt})
        ON CONFLICT (team) DO UPDATE SET reopened = true, updated_at = now()
      `

      return Response.json({ ok: true, imported: true })
    }

    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/roster',
}
