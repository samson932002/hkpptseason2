// Payment receipt uploads. Unlike the availability survey's Google Sheet
// mirror, the Apps Script call here is NOT best-effort: the uploaded photo
// itself only exists in Google Drive (Netlify Database holds metadata —
// team, amount, drive file id/link, timestamp — never the file bytes), so
// a failed Drive write is a failed submission and is reported as such.
//
// One current receipt per team: uploading again replaces the DB row and
// asks the Drive-side script to trash the previous file for that team.

import { getDatabase } from '@netlify/database'

const DISCOUNTED_AMOUNT = 3700
const STANDARD_AMOUNT = 4000

// Exact team-name matches only — kept in sync by hand with the TEAMS array
// in index.html.
const DISCOUNTED_TEAMS = new Set([
  'The OWWWL Pickle Team',
  '激戰魂',
  'PickleCow',
  '二喱',
  '再 · 薩利亞',
  'Pickle 8',
  'WWW',
  'Picklefun',
  'ON CLOUD NINE',
  'Cyber Dinks',
  'THESE',
  'Lit',
  'Never Speed Up',
  '戰魂小隊',
  'Nova',
  'CSSA',
])

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])

// Base64 length ceiling — roughly a 5 MB original file (base64 inflates by
// ~4/3). Comfortably under Netlify Functions' request body ceiling while
// leaving headroom for typical phone-camera screenshots.
const MAX_BASE64_LENGTH = 7_000_000

function amountFor(team: string): number {
  return DISCOUNTED_TEAMS.has(team) ? DISCOUNTED_AMOUNT : STANDARD_AMOUNT
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

function gasUrl(): string | undefined {
  return Netlify.env.get('PAYMENT_GAS_API_URL') || undefined
}

type Row = {
  team: string
  amount_required: number
  drive_file_id: string
  drive_view_url: string
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
        SELECT team, amount_required, drive_view_url, uploaded_at FROM payment_receipts
      `) as unknown as Row[]

      return Response.json({
        ok: true,
        receipts: rows.map((r) => ({
          team: r.team,
          amountRequired: r.amount_required,
          driveViewUrl: r.drive_view_url,
          uploadedAt: r.uploaded_at,
        })),
      })
    }

    const team = url.searchParams.get('team') || ''
    if (!team) {
      return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
    }

    const rows = (await db.sql<Row>`
      SELECT uploaded_at FROM payment_receipts WHERE team = ${team}
    `) as unknown as Row[]

    return Response.json({
      ok: true,
      amountRequired: amountFor(team),
      uploaded: rows.length > 0,
      uploadedAt: rows[0]?.uploaded_at || null,
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
      const filename = typeof payload.filename === 'string' ? payload.filename : 'receipt'
      const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : ''
      const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : ''

      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
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
          body: JSON.stringify({ action: 'upload', team, filename, mimeType, dataBase64 }),
          signal: AbortSignal.timeout(25000),
        })
        driveResult = await res.json()
      } catch {
        return Response.json({ ok: false, error: 'upload_failed' }, { status: 502 })
      }

      if (!driveResult.ok || !driveResult.fileId) {
        return Response.json({ ok: false, error: 'upload_failed' }, { status: 502 })
      }

      const amountRequired = amountFor(team)
      const rows = (await db.sql<Row>`
        INSERT INTO payment_receipts (team, amount_required, drive_file_id, drive_view_url)
        VALUES (${team}, ${amountRequired}, ${driveResult.fileId}, ${driveResult.viewUrl})
        ON CONFLICT (team) DO UPDATE SET
          amount_required = EXCLUDED.amount_required,
          drive_file_id = EXCLUDED.drive_file_id,
          drive_view_url = EXCLUDED.drive_view_url,
          uploaded_at = now(),
          updated_at = now()
        RETURNING uploaded_at
      `) as unknown as Row[]

      return Response.json({ ok: true, uploadedAt: rows[0].uploaded_at, amountRequired })
    }

    if (payload.action === 'reset') {
      const rejected = rejectPasscode(payload.passcode)
      if (rejected) return rejected
      const team = typeof payload.team === 'string' ? payload.team.trim() : ''
      if (!team) {
        return Response.json({ ok: false, error: 'missing_team' }, { status: 400 })
      }

      await db.sql`DELETE FROM payment_receipts WHERE team = ${team}`

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
  path: '/api/payment',
}
