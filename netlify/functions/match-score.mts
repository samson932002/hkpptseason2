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
// Rulebook 3.3: a leg ends the moment either team reaches that leg's fixed
// target, so after a leg exactly one team is on the target and the other is
// below it. (A team can pass 40 during XD2 without ending it — only 60 does.)
const LEG_TARGET: Record<Leg, number> = { WD: 20, XD1: 40, XD2: 60, XD3: 80, MD: 100 }

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

type LegEntry = { leg: Leg; teamA: number; teamB: number; enteredAt: string; editedAt?: string }

type Confirmation = { status: 'confirmed' | 'disputed'; name: string; note: string; at: string }

type ScoreRow = {
  match_id: string
  division: string
  team_a: string
  team_b: string
  legs: LegEntry[]
  status: 'in_progress' | 'final'
  winner: string | null
  confirmations: Record<string, Confirmation>
  started_at: string | null
  updated_at: string
}

async function loadRow(db: ReturnType<typeof getDatabase>, matchId: string): Promise<ScoreRow | null> {
  const rows = (await db.sql<ScoreRow>`
    SELECT match_id, division, team_a, team_b, legs, status, winner, confirmations, started_at, updated_at
    FROM match_scores WHERE match_id = ${matchId}
  `) as unknown as ScoreRow[]
  return rows[0] || null
}

// Checks a whole leg list against the scoring rules: legs in fixed order
// (WD, XD1, XD2, XD3, MD, no gaps), after each leg exactly one team is on
// that leg's target and the other below it, and running totals never go
// down from one leg to the next. Returns null when valid.
function validateLegSequence(legs: { leg: Leg; teamA: number; teamB: number }[]):
  { error: string; leg: Leg; target?: number; prev?: { teamA: number; teamB: number } } | null {
  let prevA = 0
  let prevB = 0
  for (let i = 0; i < legs.length; i++) {
    const e = legs[i]
    if (e.leg !== LEG_ORDER[i]) return { error: 'wrong_leg', leg: e.leg }
    const target = LEG_TARGET[e.leg]
    if (Math.max(e.teamA, e.teamB) !== target || Math.min(e.teamA, e.teamB) >= target) {
      return { error: 'invalid_leg_total', leg: e.leg, target }
    }
    if (e.teamA < prevA || e.teamB < prevB) {
      return { error: 'score_must_not_decrease', leg: e.leg, prev: { teamA: prevA, teamB: prevB } }
    }
    prevA = e.teamA
    prevB = e.teamB
  }
  return null
}

function resultOf(legs: LegEntry[], teamA: string, teamB: string): { status: ScoreRow['status']; winner: string | null } {
  const last = legs[legs.length - 1]
  if (!last) return { status: 'in_progress', winner: null }
  const isFinal = Math.max(last.teamA, last.teamB) >= TARGET_POINTS || last.leg === 'MD'
  if (!isFinal) return { status: 'in_progress', winner: null }
  return { status: 'final', winner: last.teamA === last.teamB ? null : last.teamA > last.teamB ? teamA : teamB }
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
    confirmations: {},
    started_at: null,
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
        SELECT match_id, division, team_a, team_b, legs, status, winner, confirmations, started_at, updated_at FROM match_scores
        ORDER BY updated_at DESC
      `) as unknown as ScoreRow[]
      return Response.json({ ok: true, matches: rows })
    }

    // Public: one team's match statuses, so the captain's match list can
    // flag finished matches still waiting for their confirmation.
    const teamParam = url.searchParams.get('team') || ''
    if (teamParam) {
      const rows = (await db.sql<ScoreRow>`
        SELECT match_id, team_a, team_b, legs, status, winner, confirmations, started_at FROM match_scores
        WHERE team_a = ${teamParam} OR team_b = ${teamParam}
      `) as unknown as ScoreRow[]
      return Response.json({
        ok: true,
        matches: rows.map((r) => ({
          matchId: r.match_id,
          teamA: r.team_a,
          teamB: r.team_b,
          legs: r.legs,
          status: r.status,
          winner: r.winner,
          confirmations: r.confirmations || {},
          startedAt: r.started_at,
          myConfirmation: (r.confirmations || {})[teamParam] || null,
        })),
      })
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

      const target = LEG_TARGET[leg]
      if (Math.max(teamAScore, teamBScore) !== target || Math.min(teamAScore, teamBScore) >= target) {
        return Response.json({ ok: false, error: 'invalid_leg_total', target }, { status: 400 })
      }

      const existing = await loadRow(db, matchId)
      // Scores can only be recorded after staff press "Confirm lineups &
      // start match" (which also freezes both lineups).
      if (!existing || !existing.started_at) {
        return Response.json({ ok: false, error: 'not_started' }, { status: 409 })
      }
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

      const { status, winner } = resultOf(legs, teamA, teamB)

      const saved = (await db.sql<ScoreRow>`
        INSERT INTO match_scores (match_id, division, team_a, team_b, legs, status, winner)
        VALUES (${matchId}, ${division}, ${teamA}, ${teamB}, ${JSON.stringify(legs)}::jsonb, ${status}, ${winner})
        ON CONFLICT (match_id) DO UPDATE SET
          legs = EXCLUDED.legs,
          status = EXCLUDED.status,
          winner = EXCLUDED.winner,
          -- any score change means captains must re-confirm the new result
          confirmations = '{}'::jsonb,
          updated_at = now()
        RETURNING match_id, division, team_a, team_b, legs, status, winner, confirmations, started_at, updated_at
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
        confirmations: saved[0].confirmations || {},
        updatedAt: saved[0].updated_at,
      })

      return Response.json({ ok: true, score: saved[0] })
    }

    // Staff correct any already-saved leg(s) directly — no need to undo
    // later legs first. Several legs can be corrected in one save (e.g. a
    // whole match entered on the wrong side). The corrected match must still
    // pass every scoring rule as a whole (validateLegSequence), so a fix to
    // one leg can't leave it out of step with the legs around it. Allowed on
    // finished matches too; the winner is recomputed from the last leg and
    // both captains' confirmations are cleared if anything changed.
    if (payload.action === 'correctLegs') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      if (!matchId) return Response.json({ ok: false, error: 'missing_match_id' }, { status: 400 })
      const raw = payload.corrections
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return Response.json({ ok: false, error: 'invalid_corrections' }, { status: 400 })
      }
      const row = await loadRow(db, matchId)
      if (!row || !row.started_at) return Response.json({ ok: false, error: 'not_started' }, { status: 409 })

      const legs: LegEntry[] = row.legs.map((e) => ({ ...e }))
      const now = new Date().toISOString()
      let changed = false
      for (const [legKey, val] of Object.entries(raw as Record<string, unknown>)) {
        const idx = legs.findIndex((e) => e.leg === legKey)
        if (idx < 0) return Response.json({ ok: false, error: 'leg_not_entered', leg: legKey }, { status: 400 })
        const v = val as { teamA?: unknown; teamB?: unknown } | null
        const a = v ? v.teamA : undefined
        const b = v ? v.teamB : undefined
        if (
          typeof a !== 'number' || !Number.isInteger(a) || a < 0 ||
          typeof b !== 'number' || !Number.isInteger(b) || b < 0
        ) {
          return Response.json({ ok: false, error: 'invalid_score', leg: legKey }, { status: 400 })
        }
        if (legs[idx].teamA !== a || legs[idx].teamB !== b) {
          legs[idx] = { ...legs[idx], teamA: a, teamB: b, editedAt: now } as LegEntry
          changed = true
        }
      }
      const invalid = validateLegSequence(legs)
      if (invalid) return Response.json({ ok: false, ...invalid }, { status: 400 })
      if (!changed) return Response.json({ ok: true, unchanged: true, score: row })

      const { status, winner } = resultOf(legs, row.team_a, row.team_b)
      const saved = (await db.sql<ScoreRow>`
        UPDATE match_scores SET
          legs = ${JSON.stringify(legs)}::jsonb,
          status = ${status},
          winner = ${winner},
          confirmations = '{}'::jsonb,
          updated_at = now()
        WHERE match_id = ${matchId}
        RETURNING match_id, division, team_a, team_b, legs, status, winner, confirmations, started_at, updated_at
      `) as unknown as ScoreRow[]

      const lineups = await loadLineups(db, matchId)
      await mirrorToSheet({
        action: 'upsertMatch',
        matchId,
        meta: cleanMeta(payload.meta),
        teamA: row.team_a,
        teamB: row.team_b,
        lineupA: lineups.get(row.team_a) || {},
        lineupB: lineups.get(row.team_b) || {},
        legs: saved[0].legs,
        status: saved[0].status,
        winner: saved[0].winner,
        confirmations: saved[0].confirmations || {},
        updatedAt: saved[0].updated_at,
      })

      return Response.json({ ok: true, score: saved[0] })
    }

    // Captains (no passcode — same trust model as lineup submission) confirm
    // or dispute the final result. A confirmation is final until staff change
    // a score (which clears all confirmations); a dispute can later be
    // changed to a confirmation.
    // Staff confirm both lineups and start the match. From here on captains
    // can't change their lineup (match-lineup.mts checks started_at) and leg
    // scores can be entered. Idempotent: pressing it twice changes nothing.
    // "Reset" (below) deletes the row, which also re-opens both lineups.
    if (payload.action === 'startMatch') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      const division = typeof payload.division === 'string' ? payload.division.trim() : ''
      const teamA = typeof payload.teamA === 'string' ? payload.teamA.trim() : ''
      const teamB = typeof payload.teamB === 'string' ? payload.teamB.trim() : ''
      if (!matchId || !division || !teamA || !teamB) {
        return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 })
      }
      const lineups = await loadLineups(db, matchId)
      const missing = [teamA, teamB].filter((t) => !lineups.has(t))
      if (missing.length > 0) {
        return Response.json({ ok: false, error: 'lineups_missing', missing }, { status: 409 })
      }
      const saved = (await db.sql<ScoreRow>`
        INSERT INTO match_scores (match_id, division, team_a, team_b, legs, status, started_at)
        VALUES (${matchId}, ${division}, ${teamA}, ${teamB}, '[]'::jsonb, 'in_progress', now())
        ON CONFLICT (match_id) DO UPDATE SET
          started_at = COALESCE(match_scores.started_at, now()),
          updated_at = now()
        RETURNING match_id, division, team_a, team_b, legs, status, winner, confirmations, started_at, updated_at
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
        confirmations: saved[0].confirmations || {},
        updatedAt: saved[0].updated_at,
      })

      return Response.json({ ok: true, score: saved[0] })
    }

    if (payload.action === 'confirm') {
      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      const decision = payload.decision === 'confirm' ? 'confirm' : payload.decision === 'dispute' ? 'dispute' : ''
      const name = typeof payload.captainName === 'string' ? payload.captainName.trim().slice(0, 60) : ''
      const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 500) : ''
      if (!matchId || !team || !decision) {
        return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 })
      }
      if (!name) return Response.json({ ok: false, error: 'missing_name' }, { status: 400 })
      if (decision === 'dispute' && !note) return Response.json({ ok: false, error: 'note_required' }, { status: 400 })

      const row = await loadRow(db, matchId)
      if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
      if (row.status !== 'final') return Response.json({ ok: false, error: 'not_final' }, { status: 409 })
      if (team !== row.team_a && team !== row.team_b) {
        return Response.json({ ok: false, error: 'not_in_match' }, { status: 400 })
      }
      const prev = (row.confirmations || {})[team]
      if (prev && prev.status === 'confirmed') {
        return Response.json({ ok: false, error: 'already_confirmed', confirmation: prev }, { status: 409 })
      }

      const entry: Confirmation = {
        status: decision === 'confirm' ? 'confirmed' : 'disputed',
        name,
        note: decision === 'dispute' ? note : '',
        at: new Date().toISOString(),
      }
      const saved = (await db.sql<ScoreRow>`
        UPDATE match_scores
        SET confirmations = COALESCE(confirmations, '{}'::jsonb) || jsonb_build_object(${team}::text, ${JSON.stringify(entry)}::jsonb)
        WHERE match_id = ${matchId}
        RETURNING match_id, division, team_a, team_b, legs, status, winner, confirmations, started_at, updated_at
      `) as unknown as ScoreRow[]

      await mirrorToSheet({
        action: 'confirmMatch',
        matchId,
        teamA: saved[0].team_a,
        teamB: saved[0].team_b,
        confirmations: saved[0].confirmations || {},
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
