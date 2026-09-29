// TEST FEATURE — per-match starting lineups.
//
// Distinct from roster.mts (the season-long team roster, "隊伍名單 Lineup"
// tab): this is the *starting lineup for one specific match*, which a
// captain can submit and freely resubmit any time before that match is
// played. There is no lock/reopen flow here on purpose — this is explicitly
// a trial feature, and captains fixing a lineup mistake shouldn't need to
// wait on an organizer.
//
// match_id is an opaque string the client builds from schedule.json +
// divisions.json team identifiers (e.g. "Rookie__E1__E3"). This function
// never tries to reconstruct or validate it against schedule.json — it's
// just the key the lineup is filed under.
//
// Best-effort roster cross-check: if the team has a submitted season roster
// (roster_submissions), player names are checked against it and gender is
// checked leg-by-leg (WD = 2F, MD = 2M, XDn = 1M+1F). If the team has no
// roster on file yet, those checks are skipped rather than blocking
// submission — the structural checks (exactly 5 legs, 2 players each, a
// player capped at 2 legs total, no repeat across the three XD legs) always
// run regardless.

import { getDatabase } from '@netlify/database'

const LEG_ORDER = ['WD', 'XD1', 'XD2', 'XD3', 'MD'] as const
type Leg = (typeof LEG_ORDER)[number]
const XD_LEGS: Leg[] = ['XD1', 'XD2', 'XD3']

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

type LineupRow = {
  match_id: string
  division: string
  team: string
  legs: Record<string, string[]>
  submitted_at: string
  updated_at: string
}

type RosterPlayer = { name?: unknown; preferredName?: unknown; gender?: unknown }

function normalizeName(s: string): string {
  return s.trim().toLowerCase()
}

// Returns a name -> 'M'|'F' map built from whichever of name/preferredName
// the client happened to display, so either form matches.
async function loadRosterGenderMap(db: ReturnType<typeof getDatabase>, team: string): Promise<Map<string, string> | null> {
  const rows = (await db.sql<{ players: unknown }>`
    SELECT players FROM roster_submissions WHERE team = ${team}
  `) as unknown as { players: unknown }[]
  if (rows.length === 0) return null
  const players = rows[0].players
  if (!Array.isArray(players)) return null
  const map = new Map<string, string>()
  for (const p of players as RosterPlayer[]) {
    const gender = typeof p.gender === 'string' ? p.gender : ''
    if (gender !== 'M' && gender !== 'F') continue
    for (const key of [p.name, p.preferredName]) {
      if (typeof key === 'string' && key.trim()) {
        map.set(normalizeName(key), gender)
      }
    }
  }
  return map
}

function validateLegsShape(legs: unknown): { ok: true; value: Record<Leg, [string, string]> } | { ok: false; error: string } {
  if (!legs || typeof legs !== 'object' || Array.isArray(legs)) {
    return { ok: false, error: 'invalid_legs' }
  }
  const obj = legs as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== LEG_ORDER.length || !LEG_ORDER.every((l) => keys.includes(l))) {
    return { ok: false, error: 'invalid_legs' }
  }
  const result: Record<string, [string, string]> = {}
  for (const leg of LEG_ORDER) {
    const arr = obj[leg]
    if (!Array.isArray(arr) || arr.length !== 2) {
      return { ok: false, error: `invalid_leg_${leg}` }
    }
    const [a, b] = arr
    if (typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) {
      return { ok: false, error: `invalid_leg_${leg}` }
    }
    if (normalizeName(a) === normalizeName(b)) {
      return { ok: false, error: `duplicate_player_in_leg_${leg}` }
    }
    result[leg] = [a.trim(), b.trim()]
  }
  return { ok: true, value: result as Record<Leg, [string, string]> }
}

function validateEligibility(
  legs: Record<Leg, [string, string]>,
  genderMap: Map<string, string> | null,
): string | null {
  // Cap: any one player appears in at most 2 legs total.
  const legCount = new Map<string, number>()
  for (const leg of LEG_ORDER) {
    for (const name of legs[leg]) {
      const key = normalizeName(name)
      legCount.set(key, (legCount.get(key) || 0) + 1)
    }
  }
  for (const [key, count] of legCount) {
    if (count > 2) return `player_over_leg_cap:${key}`
  }

  // No player may repeat across the three XD legs.
  const xdSeen = new Set<string>()
  for (const leg of XD_LEGS) {
    for (const name of legs[leg]) {
      const key = normalizeName(name)
      if (xdSeen.has(key)) return `player_repeats_in_xd:${key}`
      xdSeen.add(key)
    }
  }

  if (!genderMap) return null // no roster on file yet — skip gender checks

  const genderOf = (name: string): string | undefined => genderMap.get(normalizeName(name))

  for (const name of legs.WD) {
    if (genderOf(name) === 'M') return `wd_requires_female:${name}`
  }
  for (const name of legs.MD) {
    if (genderOf(name) === 'F') return `md_requires_male:${name}`
  }
  for (const leg of XD_LEGS) {
    const genders = legs[leg].map(genderOf)
    const hasM = genders.includes('M')
    const hasF = genders.includes('F')
    if (!hasM || !hasF) return `xd_requires_mixed_pair:${leg}`
  }

  return null
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const db = getDatabase()

  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected
      const rows = (await db.sql<LineupRow>`
        SELECT match_id, division, team, legs, submitted_at, updated_at FROM match_lineups
        ORDER BY updated_at DESC
      `) as unknown as LineupRow[]
      return Response.json({ ok: true, lineups: rows })
    }

    const matchId = url.searchParams.get('matchId') || ''
    if (!matchId) {
      return Response.json({ ok: false, error: 'missing_match_id' }, { status: 400 })
    }
    const team = url.searchParams.get('team') || ''

    if (team) {
      const rows = (await db.sql<LineupRow>`
        SELECT match_id, division, team, legs, submitted_at, updated_at FROM match_lineups
        WHERE match_id = ${matchId} AND team = ${team}
      `) as unknown as LineupRow[]
      return Response.json({ ok: true, lineup: rows[0] || null })
    }

    // No team specified: both sides' lineups for this match (used by the
    // on-site scoring portal to show who's playing).
    const rows = (await db.sql<LineupRow>`
      SELECT match_id, division, team, legs, submitted_at, updated_at FROM match_lineups
      WHERE match_id = ${matchId}
    `) as unknown as LineupRow[]
    return Response.json({ ok: true, lineups: rows })
  }

  if (req.method === 'POST') {
    let payload: Record<string, unknown>
    try {
      payload = await req.json()
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
    }

    if (payload.action === 'submit') {
      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      const division = typeof payload.division === 'string' ? payload.division.trim() : ''
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''

      if (!matchId) return Response.json({ ok: false, error: 'missing_match_id' }, { status: 400 })
      if (!division) return Response.json({ ok: false, error: 'missing_division' }, { status: 400 })
      if (!team) return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })

      // Rulebook 3.7: a lineup can't change once the match has started. The
      // first leg score being recorded is the "match has started" signal.
      const started = (await db.sql<{ n: number | string }>`
        SELECT jsonb_array_length(legs) AS n FROM match_scores WHERE match_id = ${matchId}
      `) as unknown as { n: number | string }[]
      if (started.length > 0 && Number(started[0].n) > 0) {
        return Response.json({ ok: false, error: 'match_started' }, { status: 409 })
      }

      const shapeCheck = validateLegsShape(payload.legs)
      if (!shapeCheck.ok) {
        return Response.json({ ok: false, error: shapeCheck.error }, { status: 400 })
      }

      let genderMap: Map<string, string> | null = null
      try {
        genderMap = await loadRosterGenderMap(db, team)
      } catch {
        genderMap = null // roster lookup failing must never block a lineup submission
      }

      const eligibilityError = validateEligibility(shapeCheck.value, genderMap)
      if (eligibilityError) {
        return Response.json({ ok: false, error: eligibilityError }, { status: 400 })
      }

      const rows = (await db.sql<LineupRow>`
        INSERT INTO match_lineups (match_id, division, team, legs)
        VALUES (${matchId}, ${division}, ${team}, ${JSON.stringify(shapeCheck.value)}::jsonb)
        ON CONFLICT (match_id, team) DO UPDATE SET
          division = EXCLUDED.division,
          legs = EXCLUDED.legs,
          updated_at = now()
        RETURNING submitted_at, updated_at
      `) as unknown as LineupRow[]

      return Response.json({ ok: true, submittedAt: rows[0].submitted_at, updatedAt: rows[0].updated_at })
    }

    if (payload.action === 'reset') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const matchId = typeof payload.matchId === 'string' ? payload.matchId.trim() : ''
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      if (!matchId || !team) {
        return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 })
      }
      await db.sql`DELETE FROM match_lineups WHERE match_id = ${matchId} AND team = ${team}`
      return Response.json({ ok: true })
    }

    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/match-lineup',
}
