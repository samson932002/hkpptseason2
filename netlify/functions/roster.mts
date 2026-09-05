// Proxy in front of the Google Sheets ("HKPPT Season 2 - Lineup Submissions")
// Apps Script Web App. The browser never talks to that backend directly and
// never receives another team's player names, DUPR IDs, or preferred names.
// Team-facing reads get gender counts and the submission time only; the
// average DUPR is organizer-only and is stripped from those responses so it
// cannot be read off the network. The organizer passcode is checked here,
// server-side, instead of living in client-side JS.

const DEFAULT_GAS_URL =
  'https://script.google.com/macros/s/AKfycbzPZEgvU7VdUyhkGkVDgl7o8gmSRVQbuMX-s52Vk4sCl-akqSqO5rThET0E5Yqz7IsXQA/exec'

const NR_VALUE = 2.75

type Row = Record<string, unknown>

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

async function fetchAllRows(): Promise<Row[]> {
  const res = await fetch(gasUrl(), { method: 'GET' })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'gas_error')
  return data.rows as Row[]
}

export default async (req: Request) => {
  const url = new URL(req.url)

  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected

      let rows: Row[]
      try {
        rows = await fetchAllRows()
      } catch {
        return Response.json({ ok: false, error: 'upstream_error' }, { status: 502 })
      }

      const byTeam = new Map<string, Row[]>()
      for (const r of rows) {
        const t = String(r['Team'])
        if (!byTeam.has(t)) byTeam.set(t, [])
        byTeam.get(t)!.push(r)
      }

      const teams = [...byTeam.entries()].map(([team, teamRows]) => ({
        team,
        submittedAt: (teamRows[0]?.['Submitted At'] as string) || null,
        ...computeStats(teamRows),
      }))

      return Response.json({ ok: true, teams })
    }

    const team = url.searchParams.get('team') || ''
    if (!team) {
      return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
    }

    let rows: Row[]
    try {
      rows = await fetchAllRows()
    } catch {
      return Response.json({ ok: false, error: 'upstream_error' }, { status: 502 })
    }

    const teamRows = rows.filter((r) => r['Team'] === team)
    if (teamRows.length === 0) {
      return Response.json({ ok: true, submitted: false })
    }

    // avgDupr is deliberately left out: a team's confirmation screen shows
    // gender counts only, so the average never reaches a team's browser.
    const { maleCount, femaleCount } = computeStats(teamRows)

    return Response.json({
      ok: true,
      submitted: true,
      submittedAt: (teamRows[0]['Submitted At'] as string) || null,
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

    if (payload.action === 'reset') {
      // Reset permanently clears a team's submitted roster, so the passcode is
      // re-verified here on every call — the client is required to collect it
      // again at confirmation time rather than reusing an earlier entry.
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      if (typeof payload.team !== 'string' || payload.team.trim() === '') {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }
    } else if (payload.action === 'submit') {
      // The client already blocks submission of an invalid DUPR value, but
      // that's UX only — a direct API call must be re-checked here so a
      // garbage rating can never reach the Sheet.
      const players = payload.players
      if (!Array.isArray(players)) {
        return Response.json({ ok: false, error: 'missing_players' }, { status: 400 })
      }
      for (const p of players) {
        const dupr = p && typeof p === 'object' ? (p as Record<string, unknown>)['dupr'] : undefined
        if (!isValidDuprInput(dupr)) {
          return Response.json({ ok: false, error: 'invalid_dupr' }, { status: 400 })
        }
      }
    } else {
      return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
    }

    try {
      const res = await fetch(gasUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      return Response.json(data)
    } catch {
      return Response.json({ ok: false, error: 'upstream_error' }, { status: 502 })
    }
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/roster',
}
