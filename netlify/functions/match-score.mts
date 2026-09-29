// TEST FEATURE — on-site live scoring for the match-day staff portal.
//
// A match is one continuous relay race to 100 cumulative points across 5
// fixed legs (WD, XD1, XD2, XD3, MD) — not 5 independent games — so it can
// finish before all 5 legs are logged. Staff enter each team's *cumulative*
// running total right after a leg ends; there is no separate "leg winner" —
// the match is decided purely by whichever team's running total crosses the
// 100-point target first (or, failing that, whoever is ahead after MD).
//
// Reads (GET by matchId) are public — a live score isn't sensitive and this
// keeps a future spectator scoreboard trivial to add. Writes (entering or
// correcting a leg, or resetting a match) require the same organizer
// passcode used everywhere else on the site.

// A match can only be scored once BOTH teams have submitted their lineup
// (match_lineups) — no lineup, no game. Every successful write is also
// mirrored, best-effort, to the "HKPPT Season 2 - Match Scores" Google Sheet
// via docs/match-scores-apps-script.gs (MATCH_SCORES_GAS_API_URL). Netlify
// Database stays the source of truth: a dead or slow sheet never blocks
// staff from recording a score.

import { getDatabase } from '@netlify/database'

const LEG_ORDER = ['WD', 'XD1', 'XD2', 'XD3', 'MD'] as const
type Leg = (typeof LEG_ORDER)[number]
const TARGET_POINTS = 100

function configuredPasscode(): string | undefined {
  const value = Netlify.env.get('ADMIN_PASSCODE')
  return value && value.length > 0 ? value : undefined
}

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

type LineupLegs = Record<string, string[]>

type Meta = {
  isoDate?: string
  date?: string
  time?: string
  venue?: string
  court?: string
  divisionZh?: string
  teamALabel?: string
  teamBLabel?: string
}

function cleanMeta(raw: unknown): Meta {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const k of ['isoDate', 'date', 'time', 'venue', 'court', 'divisionZh', 'teamALabel', 'teamBLabel']) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v).slice(0, 200)
  }
  return out as Meta
}

function sheetUrl(): string | undefined {
  return Netlify.env.get('MATCH_SCORES_GAS_API_URL') || undefined
}

// Fire-and-forget-with-a-timeout, same pattern as the roster/acknowledgment
// mirrors: awaited so it gets a real chance to run, never allowed to fail
// the staff member's save.
async function mirrorToSheet(body: Record<string, unknown>): Promise<void> {
  const url = sheetUrl()
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    // best-effort only
  }
}

async function loadLineups(db: ReturnType<typeof getDatabase>, matchId: string): Promise<Map<string, LineupLegs>> {
  const rows = (await db.sql<{ team: string; legs: LineupLegs }>`
    SELECT team, legs FROM match_lineups WHERE match_id = ${matchId}
  `) as unknown as { team: string; legs: LineupLegs }[]
  return new Map(rows.map((r) => [r.team, r.legs]))
}

type LegEntry = { leg: Leg; teamA: number; teamB: number; enteredAt: string }

type ScoreRow = {
  match_id: string
  division: string
  team_a: string
  team_b: string
  legs: LegEntry[]
  status: 'in_progress' | 'final'
  winner: string | null
  updated_at: string
}

async function loadRow(db: ReturnType<typeof getDatabase>, matchId: string): Promise<ScoreRow | null> {
  const rows = (await db.sql<ScoreRow>`
    SELECT match_id, division, team_a, team_b, legs, status, winner, updated_at
    FROM match_scores WHERE match_id = ${matchId}
  `) as unknown as ScoreRow[]
  return rows[0] || null
}

function emptyScore(matchId: string, division: string, teamA: string, teamB: string): ScoreRow {
  return {
    match_id: matchId,
    division,
    team_a: teamA,
    team_b: teamB,
    legs: [],
    status: 'in_progress',
    winner: null,
    updated_at: new Date().toISOString(),
  }
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const db = getDatabase()

  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected
      const rows = (await db.sql<ScoreRow>`
        SELECT match_id, division, team_a, team_b, legs, status, winner, updated_at FROM match_scores
        ORDER BY updated_at DESC
      `) as unknown as ScoreRow[]
      return Response.json({ ok: true, matches: rows })
    }

    const matchId = url.searchParams.get('matchId') || ''
    if (!matchId) {
      return Response.json({ ok: false, error: 'missing_match_id' }, { status: 400 })
    }
    const row = await loadRow(db, matchId)
    if (!row) {
      return Response.json({ ok: true, score: null })
    }
    return Response.json({ ok: true, score: row })
  }

  if (req.method === 'POST') {
    let payload: Record<string, unknown>
    try {
      payload = await req.json()
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
    }

    if (payload.action === 'enterLeg') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected

      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      const division = typeof payload.division === 'string' ? payload.division.trim() : ''
      const teamA = typeof payload.teamA === 'string' ? payload.teamA.trim() : ''
      const teamB = typeof payload.teamB === 'string' ? payload.teamB.trim() : ''
      const leg = typeof payload.leg === 'string' ? (payload.leg as Leg) : null
      const teamAScore = payload.teamAScore
      const teamBScore = payload.teamBScore

      if (!matchId || !division || !teamA || !teamB) {
        return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 })
      }
      if (!leg || !LEG_ORDER.includes(leg)) {
        return Response.json({ ok: false, error: 'invalid_leg' }, { status: 400 })
      }
      if (
        typeof teamAScore !== 'number' || !Number.isFinite(teamAScore) || !Number.isInteger(teamAScore) || teamAScore < 0 ||
        typeof teamBScore !== 'number' || !Number.isFinite(teamBScore) || !Number.isInteger(teamBScore) || teamBScore < 0
      ) {
        return Response.json({ ok: false, error: 'invalid_score' }, { status: 400 })
      }

      // No lineup, no game: both teams must have submitted before any leg
      // can be recorded.
      const lineups = await loadLineups(db, matchId)
      const missing = [teamA, teamB].filter((t) => !lineups.has(t))
      if (missing.length > 0) {
        return Response.json({ ok: false, error: 'lineups_missing', missing }, { status: 409 })
      }

      const existing = await loadRow(db, matchId)
      const row = existing || emptyScore(matchId, division, teamA, teamB)
      const legs = [...row.legs]

      const lastEntry = legs[legs.length - 1]
      const isCorrection = lastEntry && lastEntry.leg === leg
      const expectedLeg = LEG_ORDER[legs.length]

      if (row.status === 'final' && !isCorrection) {
        return Response.json({ ok: false, error: 'match_already_final' }, { status: 409 })
      }
      if (!isCorrection && leg !== expectedLeg) {
        return Response.json({ ok: false, error: 'wrong_leg', expectedLeg: expectedLeg || null }, { status: 400 })
      }

      const priorIndex = isCorrection ? legs.length - 2 : legs.length - 1
      const priorA = priorIndex >= 0 ? legs[priorIndex].teamA : 0
      const priorB = priorIndex >= 0 ? legs[priorIndex].teamB : 0
      if (teamAScore < priorA || teamBScore < priorB) {
        return Response.json({ ok: false, error: 'score_must_not_decrease' }, { status: 400 })
      }

      const entry: LegEntry = { leg, teamA: teamAScore, teamB: teamBScore, enteredAt: new Date().toISOString() }
      if (isCorrection) {
        legs[legs.length - 1] = entry
      } else {
        legs.push(entry)
      }

      const reachedTarget = Math.max(teamAScore, teamBScore) >= TARGET_POINTS
      const isFinal = reachedTarget || leg === 'MD'
      const status: ScoreRow['status'] = isFinal ? 'final' : 'in_progress'
      const winner = isFinal ? (teamAScore === teamBScore ? null : teamAScore > teamBScore ? teamA : teamB) : null

      const saved = (await db.sql<ScoreRow>`
        INSERT INTO match_scores (match_id, division, team_a, team_b, legs, status, winner)
        VALUES (${matchId}, ${division}, ${teamA}, ${teamB}, ${JSON.stringify(legs)}::jsonb, ${status}, ${winner})
        ON CONFLICT (match_id) DO UPDATE SET
          legs = EXCLUDED.legs,
          status = EXCLUDED.status,
          winner = EXCLUDED.winner,
          updated_at = now()
        RETURNING match_id, division, team_a, team_b, legs, status, winner, updated_at
      `) as unknown as ScoreRow[]

      await mirrorToSheet({
        action: 'upsertMatch',
        matchId,
        meta: cleanMeta(payload.meta),
        teamA,
        teamB,
        lineupA: lineups.get(teamA) || {},
        lineupB: lineups.get(teamB) || {},
        legs: saved[0].legs,
        status: saved[0].status,
        winner: saved[0].winner,
        updatedAt: saved[0].updated_at,
      })

      return Response.json({ ok: true, score: saved[0] })
    }

    if (payload.action === 'reset') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      if (!matchId) {
        return Response.json({ ok: false, error: 'missing_match_id' }, { status: 400 })
      }
      await db.sql`DELETE FROM match_scores WHERE match_id = ${matchId}`
      await mirrorToSheet({ action: 'clearMatch', matchId })
      return Response.json({ ok: true })
    }

    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/match-score',
}
