// Team availability survey — "which half-days does your team want to avoid".
//
// This function is the single source of truth for the tournament calendar:
// it mints every slot key the browser is allowed to submit, validates every
// submission against that same calendar (unknown keys and over-cap picks are
// rejected here, server-side — the client-side checkbox greying-out is UX
// only, never the real enforcement), and stores answers in Netlify Database,
// one row per team, unique on team, so a re-submission updates the row in
// place and never disturbs the original submitted_at.
//
// A best-effort copy of every answer is mirrored into a separate Google
// Sheet (a different Apps Script Web App than roster.mts's — see
// docs/availability-sheet-apps-script.gs) purely so the organizer has a
// human-readable backup outside Netlify. Netlify Database is the real
// source of truth: a dead or unconfigured sheet must never fail a captain's
// submission, so every mirror call is fire-and-forget-with-a-timeout inside
// its own try/catch.

import { getDatabase } from '@netlify/database'

type Half = 'am' | 'pm'

type SlotDef = {
  key: string
  half: Half
  label: string
  timeLabel: string
}

type DateDef = {
  date: string // YYYY-MM-DD
  label: string // "10/3 (六) Sat"
  weekdayZh: string
  weekdayEn: string
  reserve: boolean
  slots: SlotDef[]
}

type StageDef = {
  key: 'group' | 'knockout'
  nameZh: string
  nameEn: string
  maxAvoid: number
  note?: string
  dates: DateDef[]
}

const GROUP_DATES = [
  '2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11', '2026-10-17',
  '2026-10-18', '2026-10-19', '2026-10-31', '2026-11-01', '2026-11-07',
  '2026-11-08', '2026-11-14', '2026-11-15',
]

const KNOCKOUT_DATES = ['2026-11-21', '2026-11-22', '2026-11-28', '2026-11-29']
const RESERVE_DATES = ['2026-12-05', '2026-12-06']

const HALVES: { half: Half; labelZh: string; time: string }[] = [
  { half: 'am', labelZh: '上午', time: '9:00am–1:30pm' },
  { half: 'pm', labelZh: '下午', time: '1:00pm–6:00pm' },
]

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dateLabel(iso: string): { label: string; weekdayZh: string; weekdayEn: string } {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const weekdayZh = WEEKDAY_ZH[dow]
  const weekdayEn = WEEKDAY_EN[dow]
  return { label: `${m}/${d} (${weekdayZh}) ${weekdayEn}`, weekdayZh, weekdayEn }
}

function buildDate(prefix: string, iso: string, reserve: boolean): DateDef {
  const { label, weekdayZh, weekdayEn } = dateLabel(iso)
  return {
    date: iso,
    label,
    weekdayZh,
    weekdayEn,
    reserve,
    slots: HALVES.map((h) => ({
      key: `${prefix}-${iso}-${h.half}`,
      half: h.half,
      label: h.labelZh,
      timeLabel: h.time,
    })),
  }
}

// The canonical calendar. Rebuilt fresh on every call rather than cached —
// it's cheap, and it guarantees the config the browser renders and the
// config a submission is validated against can never drift apart.
function buildCalendar(): StageDef[] {
  return [
    {
      key: 'group',
      nameZh: '分組賽',
      nameEn: 'Group Stage',
      maxAvoid: 4,
      dates: GROUP_DATES.map((d) => buildDate('grp', d, false)),
    },
    {
      key: 'knockout',
      nameZh: '淘汰賽',
      nameEn: 'Knockout Stage',
      maxAvoid: 1,
      note:
        '淘汰賽賽程緊湊，最多只可以避開1個半日，未必能夠滿足所有隊伍嘅要求。12/5、12/6為後備日子。\n' +
        'The knockout schedule is tight — you may avoid at most one half-day, and we may not be able to accommodate every request. 12/5 and 12/6 are reserve dates.',
      dates: [
        ...KNOCKOUT_DATES.map((d) => buildDate('ko', d, false)),
        ...RESERVE_DATES.map((d) => buildDate('ko', d, true)),
      ],
    },
  ]
}

// Every valid key mapped to which stage it belongs to, for O(1) validation.
function slotIndex(stages: StageDef[]): Map<string, StageDef['key']> {
  const idx = new Map<string, StageDef['key']>()
  for (const stage of stages) {
    for (const date of stage.dates) {
      for (const slot of date.slots) {
        idx.set(slot.key, stage.key)
      }
    }
  }
  return idx
}

// Human-readable label for a slot key, used only for the Google Sheet
// mirror (Netlify Database stores the raw keys).
function slotLabel(stages: StageDef[], key: string): string {
  for (const stage of stages) {
    for (const date of stage.dates) {
      for (const slot of date.slots) {
        if (slot.key === key) return `${date.label} ${slot.label}`
      }
    }
  }
  return key
}

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

function sheetUrl(): string | undefined {
  return Netlify.env.get('AVAILABILITY_GAS_API_URL') || undefined
}

// Fire-and-forget-with-a-timeout: awaited so it gets a real chance to run
// before the function returns, but never allowed to fail or slow down the
// caller's own outcome. Every call site swallows the result.
async function mirrorToSheet(payload: Record<string, unknown>): Promise<void> {
  const url = sheetUrl()
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Best-effort only — a dead or misconfigured sheet must never fail the
    // captain's submission or the organizer's reset.
  }
}

function mirrorPayloadFor(stages: StageDef[], team: string, picks: string[], submittedAt: string) {
  const groupKeys = picks.filter((k) => k.startsWith('grp-'))
  const knockoutKeys = picks.filter((k) => k.startsWith('ko-'))
  return {
    action: 'record',
    team,
    submittedAt,
    groupLabels: groupKeys.map((k) => slotLabel(stages, k)),
    groupCount: groupKeys.length,
    knockoutLabels: knockoutKeys.map((k) => slotLabel(stages, k)),
    knockoutCount: knockoutKeys.length,
  }
}

type Row = { team: string; picks: string[]; submitted_at: string; updated_at: string }

export default async (req: Request) => {
  const url = new URL(req.url)
  const db = getDatabase()

  if (req.method === 'GET') {
    if (url.searchParams.get('config') === '1') {
      return Response.json({ ok: true, stages: buildCalendar() })
    }

    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected

      const rows = (await db.sql<Row>`SELECT team, picks, submitted_at, updated_at FROM availability_responses`) as unknown as Row[]

      const slotCounts: Record<string, number> = {}
      const respondedTeams = rows.map((r) => {
        const picks = Array.isArray(r.picks) ? (r.picks as unknown as string[]) : []
        for (const key of picks) {
          slotCounts[key] = (slotCounts[key] || 0) + 1
        }
        return { team: r.team, submittedAt: r.submitted_at, picks }
      })

      return Response.json({
        ok: true,
        slotCounts,
        respondedTeams,
        sheetSyncAvailable: Boolean(sheetUrl()),
      })
    }

    const team = url.searchParams.get('team') || ''
    if (!team) {
      return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
    }

    const rows = (await db.sql<Row>`SELECT picks, submitted_at FROM availability_responses WHERE team = ${team}`) as unknown as Row[]
    if (rows.length === 0) {
      return Response.json({ ok: true, submitted: false, picks: [] })
    }
    const picks = Array.isArray(rows[0].picks) ? (rows[0].picks as unknown as string[]) : []
    return Response.json({ ok: true, submitted: true, picks, submittedAt: rows[0].submitted_at })
  }

  if (req.method === 'POST') {
    let payload: Record<string, unknown>
    try {
      payload = await req.json()
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
    }

    const stages = buildCalendar()

    if (payload.action === 'submit') {
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      const picks = Array.isArray(payload.picks) ? (payload.picks as unknown[]).filter((p) => typeof p === 'string') as string[] : []

      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }

      const idx = slotIndex(stages)
      const uniquePicks = [...new Set(picks)]
      for (const key of uniquePicks) {
        if (!idx.has(key)) {
          return Response.json({ ok: false, error: 'unknown_slot', slot: key }, { status: 400 })
        }
      }
      for (const stage of stages) {
        const count = uniquePicks.filter((k) => idx.get(k) === stage.key).length
        if (count > stage.maxAvoid) {
          return Response.json(
            { ok: false, error: 'cap_exceeded', stage: stage.key, max: stage.maxAvoid },
            { status: 400 },
          )
        }
      }

      const rows = (await db.sql<Row>`
        INSERT INTO availability_responses (team, picks)
        VALUES (${team}, ${JSON.stringify(uniquePicks)}::jsonb)
        ON CONFLICT (team) DO UPDATE SET picks = EXCLUDED.picks, updated_at = now()
        RETURNING team, picks, submitted_at, updated_at
      `) as unknown as Row[]
      const saved = rows[0]

      await mirrorToSheet(mirrorPayloadFor(stages, team, uniquePicks, saved.submitted_at))

      return Response.json({ ok: true, submittedAt: saved.submitted_at, picks: uniquePicks })
    }

    if (payload.action === 'reset') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }
      await db.sql`DELETE FROM availability_responses WHERE team = ${team}`
      await mirrorToSheet({ action: 'clear', team })
      return Response.json({ ok: true })
    }

    if (payload.action === 'resync') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      if (!sheetUrl()) {
        return Response.json({ ok: false, error: 'sheet_not_configured' }, { status: 503 })
      }

      const rows = (await db.sql<Row>`SELECT team, picks, submitted_at FROM availability_responses`) as unknown as Row[]
      const failed: string[] = []
      for (const row of rows) {
        const picks = Array.isArray(row.picks) ? (row.picks as unknown as string[]) : []
        try {
          const res = await fetch(sheetUrl()!, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(mirrorPayloadFor(stages, row.team, picks, row.submitted_at)),
            signal: AbortSignal.timeout(5000),
          })
          if (!res.ok) failed.push(row.team)
        } catch {
          failed.push(row.team)
        }
      }

      return Response.json({ ok: true, synced: rows.length - failed.length, failed })
    }

    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/availability',
}
