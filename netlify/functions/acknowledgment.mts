// Team waiver acknowledgment — the captain types their full name + today's
// date on behalf of the whole team, confirming they've read the liability
// waiver and will share it with their teammates.
//
// Netlify Database is the real source of truth (one row per team, unique on
// team, so a re-submission updates in place). A best-effort copy of every
// acknowledgment is mirrored into Google Drive as a plain-text file per team
// (see docs/acknowledgment-apps-script.gs) purely so the organizer has a
// human-readable record outside Netlify — a dead or unconfigured script must
// never fail a captain's submission.

import { getDatabase } from '@netlify/database'

const WAIVER_TEXT_ZH = `凡報名、出席或參加此活動者，均確認已閱讀、理解並同意本責任免除聲明中所列條款。
1. 財物遺失或損壞 —— 賽事主辦單位、贊助商及場地管理方無法對任何個人財物的遺失、被盜或損壞承擔責任，包括但不限於運動器材、個人物品或停放在活動場地或鄰近區域的車輛。
2. 人身傷害 —— 參與賽事須由參賽者自行承擔風險。主辦單位對於參賽者、觀眾或其他參與者在活動期間或因活動引致的任何傷害、事故或健康問題概不負責。強烈建議參賽者採取必要的預防措施，並確保自身身體狀況適合比賽。
3. 隱私及個人資料 —— 參與本次賽事即視為同意主辦單位為活動管理及聯絡目的收集和使用個人資料（如隊伍名單、DUPR評分及聯絡方式）。主辦單位不會在活動範疇以外將此類信息分享給第三方，除非法律另有規定。
4. 照片及媒體使用 —— 參與者確認並接受，主辦單位可能會使用活動期間拍攝的照片、影片或其他媒體，用於宣傳或活動紀錄目的，無需額外獲得參與者的同意或支付補償。
5. 風險承擔 —— 所有參與者承認與匹克球相關的固有風險，包括體力消耗、跌倒、碰撞或其他無法預測的事件。報名參加此賽事即視為參賽者及與會者自願承擔此類風險。

（另：第三方責任保險由主辦單位承保。）`

const WAIVER_TEXT_EN = `By registering, attending, or participating in the event, all individuals confirm that they have read, understood, and agreed to the terms outlined in this exclusion list.
1. Loss or Damage to Property — The tournament organizers, sponsors, and venue management shall not be held liable for any loss, theft, or damage to personal property, including but not limited to sports equipment, personal effects, or vehicles at or near the event venue.
2. Personal Injury — Participation in the tournament is at the players' own risk. The organizers shall not be held liable for any injuries, accidents, or health-related issues sustained by participants, spectators, or other attendees during or as a result of the event. Participants are strongly encouraged to take necessary precautions and ensure they are physically fit for the competition.
3. Privacy and Personal Data — By participating in the tournament, individuals consent to the collection and use of personal data (e.g., team rosters, DUPR ratings, and contact information) for event management and communication purposes. The organizers will not share this information with third parties outside the scope of the event, except as required by law.
4. Photographs and Media — Participants acknowledge and accept that photographs, videos, or other media captured during the event may be used by the organizers for promotional or documentation purposes without additional consent or compensation.
5. Assumption of Risks — All participants acknowledge the inherent risks associated with pickleball, including physical exertion, falls, collisions, or other unforeseeable incidents. By registering for this tournament, players and attendees voluntarily assume these risks.

(Note: Third-party liability insurance is covered by the organizers.)`

function gasUrl(): string | undefined {
  return Netlify.env.get('ACKNOWLEDGMENT_GAS_API_URL') || undefined
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

// Fire-and-forget-with-a-timeout: awaited so it gets a real chance to run
// before the function returns, but never allowed to fail or slow down the
// caller's own outcome.
async function mirrorToDrive(payload: Record<string, unknown>): Promise<void> {
  const url = gasUrl()
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    // Best-effort only — a dead or misconfigured script must never fail the
    // captain's submission or the organizer's reset.
  }
}

type Row = {
  team: string
  captain_name: string
  ack_date: string
  shared_with_team: boolean
  acknowledged_at: string
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const db = getDatabase()

  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected

      const rows = (await db.sql<Row>`
        SELECT team, captain_name, ack_date, shared_with_team, acknowledged_at FROM team_acknowledgments
      `) as unknown as Row[]

      return Response.json({
        ok: true,
        acknowledgments: rows.map((r) => ({
          team: r.team,
          captainName: r.captain_name,
          ackDate: r.ack_date,
          sharedWithTeam: r.shared_with_team,
          acknowledgedAt: r.acknowledged_at,
        })),
        driveSyncAvailable: Boolean(gasUrl()),
      })
    }

    const team = url.searchParams.get('team') || ''
    if (!team) {
      return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
    }

    const rows = (await db.sql<Row>`
      SELECT captain_name, ack_date, acknowledged_at FROM team_acknowledgments WHERE team = ${team}
    `) as unknown as Row[]

    return Response.json({
      ok: true,
      acknowledged: rows.length > 0,
      captainName: rows[0]?.captain_name || null,
      ackDate: rows[0]?.ack_date || null,
      acknowledgedAt: rows[0]?.acknowledged_at || null,
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
      const captainName = typeof payload.captainName === 'string' ? payload.captainName.trim() : ''
      const ackDate = typeof payload.ackDate === 'string' ? payload.ackDate.trim() : ''
      const shared = payload.shared === true

      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }
      if (!captainName) {
        return Response.json({ ok: false, error: 'missing_name' }, { status: 400 })
      }
      if (!ackDate) {
        return Response.json({ ok: false, error: 'missing_date' }, { status: 400 })
      }
      if (!shared) {
        return Response.json({ ok: false, error: 'must_confirm_share' }, { status: 400 })
      }

      const rows = (await db.sql<Row>`
        INSERT INTO team_acknowledgments (team, captain_name, ack_date, shared_with_team)
        VALUES (${team}, ${captainName}, ${ackDate}, ${shared})
        ON CONFLICT (team) DO UPDATE SET
          captain_name = EXCLUDED.captain_name,
          ack_date = EXCLUDED.ack_date,
          shared_with_team = EXCLUDED.shared_with_team,
          acknowledged_at = now(),
          updated_at = now()
        RETURNING acknowledged_at
      `) as unknown as Row[]

      const acknowledgedAt = rows[0].acknowledged_at

      await mirrorToDrive({
        action: 'record',
        team,
        captainName,
        date: ackDate,
        submittedAt: acknowledgedAt,
        shared,
        waiverText: `${WAIVER_TEXT_ZH}\n\n---\n\n${WAIVER_TEXT_EN}`,
      })

      return Response.json({ ok: true, acknowledgedAt })
    }

    if (payload.action === 'reset') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }

      await db.sql`DELETE FROM team_acknowledgments WHERE team = ${team}`
      await mirrorToDrive({ action: 'clear', team })

      return Response.json({ ok: true })
    }

    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/acknowledgment',
}
