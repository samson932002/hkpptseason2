// Team logo submissions. Same shape as payment.mts: the uploaded photo
// itself only exists in Google Drive (Netlify Database holds metadata —
// team, division, drive file id/link, timestamp — never the file bytes),
// so a failed Drive write is a failed submission and is reported as such.
//
// One current logo per team: uploading again replaces the DB row and asks
// the Drive-side script to trash the previous file for that team.
//
// A team without a logo can instead submit with noLogo:true — status
// becomes 'requested' (no Drive file at all, so no Drive dependency and
// nothing that can fail) and the organizer designs one for them from the
// admin table. Uploading a real file afterwards overwrites the request.
//
// Deadline (Sep 27) is shown to captains client-side but not enforced here
// — a late logo is still a logo the organizer wants, not one worth losing.

import { getDatabase } from '@netlify/database'

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

// Base64 length ceiling — roughly a 5 MB original file (base64 inflates by
// ~4/3). Comfortably under Netlify Functions' request body ceiling while
// leaving headroom for typical phone-camera exports.
const MAX_BASE64_LENGTH = 7_000_000

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

function gasUrl(): string | undefined {
  return Netlify.env.get('LOGO_GAS_API_URL') || undefined
}

type Row = {
  team: string
  division_zh: string
  drive_file_id: string | null
  drive_view_url: string | null
  status: 'uploaded' | 'requested'
  uploaded_at: string
  updated_at: string
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const db = getDatabase()

  if (req.method === 'GET') {
    if (url.searchParams.get('admin') === '1') {
      const rejected = rejectPasscode(url.searchParams.get('passcode') ?? undefined)
      if (rejected) return rejected

      const rows = (await db.sql<Row>`
        SELECT team, division_zh, drive_view_url, status, uploaded_at FROM team_logos
      `) as unknown as Row[]

      return Response.json({
        ok: true,
        logos: rows.map((r) => ({
          team: r.team,
          divisionZh: r.division_zh,
          driveViewUrl: r.drive_view_url,
          status: r.status,
          uploadedAt: r.uploaded_at,
        })),
      })
    }

    const team = url.searchParams.get('team') || ''
    if (!team) {
      return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
    }

    const rows = (await db.sql<Row>`
      SELECT drive_view_url, status, uploaded_at FROM team_logos WHERE team = ${team}
    `) as unknown as Row[]

    return Response.json({
      ok: true,
      status: rows[0]?.status || null,
      uploadedAt: rows[0]?.uploaded_at || null,
      driveViewUrl: rows[0]?.drive_view_url || null,
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
      const divisionZh = typeof payload.divisionZh === 'string' ? payload.divisionZh.trim() : ''
      const noLogo = payload.noLogo === true
      const filename = typeof payload.filename === 'string' ? payload.filename : 'logo'
      const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : ''
      const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : ''

      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }
      if (!divisionZh) {
        return Response.json({ ok: false, error: 'missing_division' }, { status: 400 })
      }

      // "We don't have a logo — please design one for us": no file, no
      // Drive dependency, nothing that can fail. The organizer picks these
      // up from the admin table.
      if (noLogo) {
        const rows = (await db.sql<Row>`
          INSERT INTO team_logos (team, division_zh, drive_file_id, drive_view_url, status)
          VALUES (${team}, ${divisionZh}, NULL, NULL, 'requested')
          ON CONFLICT (team) DO UPDATE SET
            division_zh = EXCLUDED.division_zh,
            drive_file_id = NULL,
            drive_view_url = NULL,
            status = 'requested',
            uploaded_at = now(),
            updated_at = now()
          RETURNING uploaded_at
        `) as unknown as Row[]

        return Response.json({ ok: true, uploadedAt: rows[0].uploaded_at, status: 'requested' })
      }

      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return Response.json({ ok: false, error: 'invalid_type' }, { status: 400 })
      }
      if (!dataBase64) {
        return Response.json({ ok: false, error: 'missing_file' }, { status: 400 })
      }
      if (dataBase64.length > MAX_BASE64_LENGTH) {
        return Response.json({ ok: false, error: 'file_too_large' }, { status: 413 })
      }

      const url = gasUrl()
      if (!url) {
        return Response.json({ ok: false, error: 'not_configured' }, { status: 503 })
      }

      let driveResult: { ok: boolean; fileId?: string; viewUrl?: string; error?: string }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'upload', team, divisionZh, filename, mimeType, dataBase64 }),
          signal: AbortSignal.timeout(25000),
        })
        driveResult = await res.json()
      } catch {
        return Response.json({ ok: false, error: 'upload_failed' }, { status: 502 })
      }

      if (!driveResult.ok || !driveResult.fileId) {
        return Response.json({ ok: false, error: 'upload_failed' }, { status: 502 })
      }

      const rows = (await db.sql<Row>`
        INSERT INTO team_logos (team, division_zh, drive_file_id, drive_view_url, status)
        VALUES (${team}, ${divisionZh}, ${driveResult.fileId}, ${driveResult.viewUrl}, 'uploaded')
        ON CONFLICT (team) DO UPDATE SET
          division_zh = EXCLUDED.division_zh,
          drive_file_id = EXCLUDED.drive_file_id,
          drive_view_url = EXCLUDED.drive_view_url,
          status = 'uploaded',
          uploaded_at = now(),
          updated_at = now()
        RETURNING uploaded_at
      `) as unknown as Row[]

      return Response.json({ ok: true, uploadedAt: rows[0].uploaded_at, status: 'uploaded' })
    }

    if (payload.action === 'reset') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }

      await db.sql`DELETE FROM team_logos WHERE team = ${team}`

      const url = gasUrl()
      if (url) {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'clear', team }),
            signal: AbortSignal.timeout(5000),
          })
        } catch {
          // Best-effort on the way out: the DB record (the thing that gates
          // re-upload) is already cleared regardless of whether Drive
          // cleanup succeeded.
        }
      }

      return Response.json({ ok: true })
    }

    return Response.json({ ok: false, error: 'unknown_action' }, { status: 400 })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export const config = {
  path: '/api/logo',
}
