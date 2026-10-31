import crypto from 'node:crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { config } from './config.js'
import { binary, query, t } from './db.js'
import { sendSigningCompleted, sendSigningInvite } from './mailer.js'
import { emitContractEvent } from './webhooks.js'

/*
 * Contract signing: private links, invitations in signing order, and the final signed PDF.
 * Signers never log in. Each one gets a random link token; only its SHA-256 hash is stored.
 */

// "expired" is derived, so it is always correct without a background job.
export const STATUS_SQL = `CASE WHEN c.Status = N'incomplete' AND c.ExpiresAt < SYSUTCDATETIME() THEN N'expired' ELSE c.Status END`

export const METHOD_LABELS = {
  AADHAAR_OTP: 'Aadhaar eSign - OTP',
  AADHAAR_FINGERPRINT: 'Aadhaar eSign - Fingerprint',
  AADHAAR_FACE: 'Aadhaar eSign - Face Auth',
  CLICKWRAP: 'Clickwrap',
  SMART_ESIGN: 'Smart eSign',
  DSC_TOKEN: 'DSC Token',
}

// Told to signers in the invitation so they have what the method needs at hand
const METHOD_HINTS = {
  AADHAAR_OTP: 'Aadhaar eSign (OTP): keep your Aadhaar number and the mobile linked to it ready.',
  AADHAAR_FINGERPRINT: 'Aadhaar eSign (fingerprint): keep your Aadhaar number and a fingerprint scanner ready.',
  AADHAAR_FACE: 'Aadhaar eSign (face authentication): keep your Aadhaar number ready and use a device with a camera.',
  CLICKWRAP: 'Clickwrap: you will accept the document by typing your name and clicking "I agree".',
  SMART_ESIGN: 'Smart eSign: we will email you a one-time code to confirm it is you.',
  DSC_TOKEN: 'DSC token: plug in your USB signing token and keep its PIN ready.',
}
export function howToSign(methods) {
  const list = String(methods || '').split(',').filter((m) => METHOD_HINTS[m])
  if (!list.length) return ''
  if (list.length === 1) return `How you will sign: ${METHOD_HINTS[list[0]]}`
  return `You can sign with: ${list.map((m) => METHOD_LABELS[m]).join(', ')}.`
}

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// Where signing links point: APP_URL, else the frontend that made the request (if it is an allowed origin)
export function appUrl(req) {
  if (config.appUrl) return config.appUrl
  const origin = req?.get?.('origin')
  if (origin && config.corsOrigins.includes(origin)) return origin
  return config.corsOrigins[0] || 'http://localhost:5173'
}

const clientIp = (req) => (req?.ip || '').replace(/^::ffff:/, '').slice(0, 64) || null

// Records an audit-trail event and sends it to the organisation's webhook (after commit when inside a transaction).
// `link` is a fresh signing link to include in the webhook; it is never stored.
export async function logEvent(run, { contractId, signerOrder = null, event, detail = null, req, link = null }) {
  await run(
    `INSERT INTO ${t.ContractEvents} (ContractId, SignerOrder, Event, Detail, IpAddress) VALUES (@contractId, @signerOrder, @event, @detail, @ip)`,
    { contractId, signerOrder, event, detail: detail ? String(detail).slice(0, 500) : null, ip: clientIp(req) },
  )
  const emit = () => emitContractEvent({ contractId, event, signerOrder, detail, link })
  if (run.afterCommit) run.afterCommit(emit)
  else emit()
}

async function contractForMail(contractId) {
  const [c] = await query(
    `SELECT c.Id, c.Name, c.ExpiresAt, c.EmailSubject, c.SigningMethod, c.Notify, o.Name AS OrgName, u.Name AS SenderName, u.Email AS SenderEmail
     FROM ${t.Contracts} c
     JOIN ${t.Organisations} o ON o.Id = c.OrganisationId
     LEFT JOIN ${t.Users} u ON u.Id = c.CreatedBy
     WHERE c.Id = @contractId`,
    { contractId },
  )
  return c
}

// Gives one participant a fresh signing link and returns it; their older link stops working
export async function issueLink(contractId, order, req) {
  const token = crypto.randomBytes(32).toString('base64url')
  await query(`UPDATE ${t.ContractSigners} SET TokenHash = @hash WHERE ContractId = @contractId AND SignerOrder = @order`, {
    hash: hashToken(token),
    contractId,
    order,
  })
  return `${appUrl(req)}/sign/${token}`
}

/*
 * Gives one signer a fresh link (older links stop working) and emails it.
 * Returns { order, email, link, emailed, error }.
 */
export async function inviteSigner(contractId, order, req, { reminder = false } = {}) {
  const c = await contractForMail(contractId)
  const [s] = await query(`SELECT SignerOrder, Name, Email, Kind, COALESCE(Methods, Method) AS Methods FROM ${t.ContractSigners} WHERE ContractId = @contractId AND SignerOrder = @order`, {
    contractId,
    order,
  })
  if (!c || !s) throw new Error('Signer not found')

  const link = await issueLink(contractId, order, req)
  await query(`UPDATE ${t.ContractSigners} SET InvitedAt = COALESCE(InvitedAt, SYSUTCDATETIME()) WHERE ContractId = @contractId AND SignerOrder = @order`, {
    contractId,
    order,
  })
  const result = { order, email: s.Email, link, emailed: false, error: null }
  try {
    result.emailed = await sendSigningInvite({
      to: s.Email,
      name: s.Name,
      contractName: c.Name,
      orgName: c.OrgName,
      senderName: c.SenderName,
      link,
      expiresAt: c.ExpiresAt,
      subject: c.EmailSubject,
      review: s.Kind === 'reviewer',
      howToSign: s.Kind === 'reviewer' ? '' : howToSign(s.Methods),
    })
    if (!result.emailed) result.error = 'Email is not set up on the server (SMTP_HOST is empty), so the link was only printed in the backend console.'
  } catch (err) {
    // The mailer has logged the details; the sender can still copy the link from the contract page
    result.error = err.message
  }
  await logEvent(query, {
    contractId,
    signerOrder: order,
    event: reminder ? 'reminded' : 'invited',
    detail: result.emailed ? `Invitation emailed to ${s.Email}` : `Invitation to ${s.Email} not emailed: ${result.error}`,
    req,
    link,
  })
  return result
}

// Contracts created with notify 'none': the API caller already holds every link, so only mark the turn
async function markReady(contractId, order, req) {
  const rows = await query(
    `UPDATE ${t.ContractSigners} SET InvitedAt = SYSUTCDATETIME() OUTPUT inserted.Email
     WHERE ContractId = @contractId AND SignerOrder = @order AND InvitedAt IS NULL`,
    { contractId, order },
  )
  if (rows.length) {
    await logEvent(query, { contractId, signerOrder: order, event: 'invited', detail: `Ready for ${rows[0].Email}; the link is delivered by the API caller`, req })
  }
  return { order, email: rows[0]?.Email ?? null, link: null, emailed: false, error: null }
}

/*
 * Invites whoever may act now and has not been invited yet. Reviewers come first: signers are
 * only invited once every reviewer has approved.
 * sequential -> the first one who has not finished; parallel -> everyone in the current stage.
 */
export async function inviteNext(contractId, req) {
  const [c] = await query(`SELECT SigningMethod, Notify, ${STATUS_SQL} AS Status FROM ${t.Contracts} c WHERE c.Id = @contractId`, { contractId })
  if (!c || c.Status !== 'incomplete') return []
  const pending = await query(
    `SELECT SignerOrder, InvitedAt, Kind FROM ${t.ContractSigners} WHERE ContractId = @contractId AND Signed = 0 ORDER BY SignerOrder`,
    { contractId },
  )
  const reviewing = pending.filter((s) => s.Kind === 'reviewer')
  const stage = reviewing.length ? reviewing : pending
  const due = c.SigningMethod === 'parallel' ? stage : stage.slice(0, 1)
  const results = []
  for (const s of due.filter((x) => !x.InvitedAt)) {
    results.push(c.Notify === 'none' ? await markReady(contractId, s.SignerOrder, req) : await inviteSigner(contractId, s.SignerOrder, req))
  }
  return results
}

/* ---------------- Signed PDF ---------------- */

// Standard PDF fonts only cover Latin-1; anything else is replaced so drawing never fails
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
const fmt = (d) => (d ? `${new Date(d).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '-')

function dataUrlToBytes(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '')
  return m ? Buffer.from(m[1], 'base64') : null
}

async function loadForPdf(contractId) {
  const [c] = await query(
    `SELECT c.Id, c.Name, c.WorkflowName, c.SigningMethod, c.CreatedAt, c.CompletedAt, c.BoxesJson, c.ParticipantsJson,
            o.Name AS OrgName, u.Name AS SenderName, u.Email AS SenderEmail
     FROM ${t.Contracts} c
     JOIN ${t.Organisations} o ON o.Id = c.OrganisationId
     LEFT JOIN ${t.Users} u ON u.Id = c.CreatedBy
     WHERE c.Id = @contractId`,
    { contractId },
  )
  const signers = await query(
    `SELECT SignerOrder, RoleId, Kind, Name, Email, Method, SignedMethod, Verification, LocationJson, PhotoImage, SignedAt, InvitedAt, ViewedAt, SignatureImage, SignatureType, SignedIp, SignedUserAgent, ReviewComment
     FROM ${t.ContractSigners} WHERE ContractId = @contractId ORDER BY SignerOrder`,
    { contractId },
  )
  const events = await query(
    `SELECT SignerOrder, Event, Detail, IpAddress, CreatedAt FROM ${t.ContractEvents} WHERE ContractId = @contractId ORDER BY CreatedAt, Id`,
    { contractId },
  )
  const [original] = await query(`SELECT FileName, Sha256, Data FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = N'original'`, {
    contractId,
  })
  return { c, signers, events, original }
}

// Draws each signature into its boxes, footers every page and appends a certificate of completion
export async function buildSignedPdf(contractId) {
  const { c, signers, events, original } = await loadForPdf(contractId)
  if (!c || !original) throw new Error('The contract document is missing')

  const pdf = await PDFDocument.load(original.Data, { ignoreEncryption: true })
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const grey = rgb(0.42, 0.4, 0.5)
  const ink = rgb(0.1, 0.09, 0.19)
  const brand = rgb(0.31, 0.27, 0.9)

  const boxes = JSON.parse(c.BoxesJson || '[]')
  const participants = JSON.parse(c.ParticipantsJson || '[]')
  const byRole = new Map(signers.map((s) => [s.RoleId, s]))
  const images = new Map()
  for (const s of signers) {
    const bytes = dataUrlToBytes(s.SignatureImage)
    if (bytes) images.set(s.SignerOrder, await pdf.embedPng(bytes))
  }

  const pages = pdf.getPages()
  for (const box of boxes) {
    const page = pages[box.page - 1]
    if (!page) continue
    // Boxes are fractions of the page as displayed, measured from the top-left corner
    const crop = page.getCropBox()
    const w = box.w * crop.width
    const h = box.h * crop.height
    const x = crop.x + box.x * crop.width
    const y = crop.y + (1 - box.y - box.h) * crop.height
    const caption = Math.max(4.5, Math.min(7, h * 0.16))

    const signer = byRole.get(box.owner)
    const participant = participants.find((p) => p.id === box.owner)
    if (signer && images.has(signer.SignerOrder)) {
      const img = images.get(signer.SignerOrder)
      const areaH = h - caption * 1.6
      const scale = Math.min((w * 0.94) / img.width, (areaH * 0.94) / img.height)
      const iw = img.width * scale
      const ih = img.height * scale
      page.drawImage(img, { x: x + (w - iw) / 2, y: y + caption * 1.5 + (areaH - ih) / 2, width: iw, height: ih })
      page.drawText(safe(`${signer.Name} - ${fmt(signer.SignedAt)}`), { x: x + 2, y: y + caption * 0.4, size: caption, font, color: grey, maxWidth: w - 4 })
    } else if (participant?.kind === 'auto') {
      const size = Math.max(5, Math.min(9, h * 0.2))
      page.drawText(safe(`Digitally signed by ${c.OrgName}`), { x: x + 3, y: y + h / 2 + 1, size, font: bold, color: brand, maxWidth: w - 6 })
      page.drawText(safe(fmt(c.CompletedAt || new Date())), { x: x + 3, y: y + h / 2 - size - 1, size: size * 0.85, font, color: grey, maxWidth: w - 6 })
    }
  }

  for (const [i, page] of pages.entries()) {
    const crop = page.getCropBox()
    page.drawText(safe(`Contract ${c.Id} - signed electronically - page ${i + 1} of ${pages.length}`), {
      x: crop.x + 18,
      y: crop.y + 8,
      size: 6,
      font,
      color: grey,
    })
  }

  // Certificate of completion
  const W = 595
  const H = 842
  let page = pdf.addPage([W, H])
  let y = H - 56
  const line = (text, { size = 9.5, f = font, color = ink, x = 48, gap = 4 } = {}) => {
    if (y < 60) {
      page = pdf.addPage([W, H])
      y = H - 56
    }
    page.drawText(safe(text), { x, y, size, font: f, color, maxWidth: W - x - 48 })
    y -= size + gap
  }
  const rule = () => {
    page.drawLine({ start: { x: 48, y: y + 4 }, end: { x: W - 48, y: y + 4 }, thickness: 0.6, color: rgb(0.88, 0.87, 0.93) })
    y -= 12
  }

  line('Certificate of Completion', { size: 20, f: bold, color: brand, gap: 8 })
  line('This document was signed electronically through eSign Doc Builder.', { color: grey, gap: 14 })
  rule()
  const kv = (k, v) => {
    if (y < 60) {
      page = pdf.addPage([W, H])
      y = H - 56
    }
    page.drawText(safe(k), { x: 48, y, size: 8.5, font: bold, color: grey })
    page.drawText(safe(v), { x: 170, y, size: 9.5, font, color: ink, maxWidth: W - 218 })
    y -= 15
  }
  kv('Document', c.Name)
  kv('Contract ID', c.Id)
  kv('Workflow', c.WorkflowName)
  kv('Sent by', `${c.SenderName ?? '-'} (${c.SenderEmail ?? '-'}), ${c.OrgName}`)
  kv('Signing order', c.SigningMethod === 'parallel' ? 'Parallel' : 'Sequential')
  kv('Created', fmt(c.CreatedAt))
  kv('Completed', fmt(c.CompletedAt || new Date()))
  kv('Original file', original.FileName)
  kv('Original SHA-256', original.Sha256)
  y -= 8
  rule()

  const reviewers = signers.filter((s) => s.Kind === 'reviewer')
  if (reviewers.length) {
    line('Reviewers', { size: 13, f: bold, gap: 10 })
    for (const s of reviewers) {
      line(`${s.Name}`, { size: 11, f: bold, gap: 5 })
      line(`Email: ${s.Email}`)
      line(`Invited: ${fmt(s.InvitedAt)}    Viewed: ${fmt(s.ViewedAt)}`)
      line(`Approved: ${fmt(s.SignedAt)}    IP address: ${s.SignedIp ?? '-'}`)
      if (s.ReviewComment) line(`Comment: ${s.ReviewComment}`)
      line(`Device: ${(s.SignedUserAgent ?? '-').slice(0, 110)}`, { size: 7.5, color: grey, gap: 10 })
      rule()
    }
  }

  line('Signers', { size: 13, f: bold, gap: 10 })
  for (const [i, s] of signers.filter((x) => x.Kind !== 'reviewer').entries()) {
    if (y < (s.PhotoImage ? 250 : 150)) {
      page = pdf.addPage([W, H])
      y = H - 56
    }
    const top = y
    line(`${i + 1}. ${s.Name}`, { size: 11, f: bold, gap: 5 })
    line(`Email: ${s.Email}`)
    const look = s.SignatureType === 'stamp' ? 'generated' : s.SignatureType === 'type' ? 'typed' : 'drawn'
    line(`Method: ${METHOD_LABELS[s.SignedMethod ?? s.Method] ?? s.SignedMethod ?? s.Method ?? 'Electronic signature'} (${look} signature)`)
    if (s.Verification) line(`Verification: ${s.Verification.slice(0, 110)}`)
    line(`Invited: ${fmt(s.InvitedAt)}    Viewed: ${fmt(s.ViewedAt)}`)
    line(`Signed: ${fmt(s.SignedAt)}    IP address: ${s.SignedIp ?? '-'}`)
    const loc = s.LocationJson ? JSON.parse(s.LocationJson) : null
    if (loc) line(`Location: ${loc.lat}, ${loc.lng}${loc.accuracy != null ? ` (within ${loc.accuracy} m)` : ''}    https://maps.google.com/?q=${loc.lat},${loc.lng}`)
    line(`Device: ${(s.SignedUserAgent ?? '-').slice(0, 110)}`, { size: 7.5, color: grey, gap: 10 })
    if (s.PhotoImage) {
      // Live photo taken while signing
      const photo = await pdf.embedJpg(Buffer.from(s.PhotoImage.split(',')[1] ?? '', 'base64')).catch(() => null)
      if (photo) {
        const ph = 84
        const pw = (photo.width / photo.height) * ph
        line('Live photo:', { size: 8, color: grey, gap: 2 })
        page.drawImage(photo, { x: 48, y: y - ph, width: pw, height: ph })
        y -= ph + 10
      }
    }
    const img = images.get(s.SignerOrder)
    if (img) {
      const scale = Math.min(130 / img.width, 46 / img.height)
      page.drawRectangle({ x: W - 198, y: top - 56, width: 150, height: 60, borderColor: rgb(0.88, 0.87, 0.93), borderWidth: 0.8 })
      page.drawImage(img, { x: W - 123 - (img.width * scale) / 2, y: top - 26 - (img.height * scale) / 2, width: img.width * scale, height: img.height * scale })
    }
    rule()
  }

  line('Audit trail', { size: 13, f: bold, gap: 10 })
  const nameOf = (order) => signers.find((s) => s.SignerOrder === order)?.Name
  for (const e of events) {
    const who = e.SignerOrder ? ` - ${nameOf(e.SignerOrder) ?? `signer ${e.SignerOrder}`}` : ''
    line(`${fmt(e.CreatedAt)}   ${e.Event.toUpperCase()}${who}${e.Detail ? `: ${e.Detail}` : ''}${e.IpAddress ? `  [${e.IpAddress}]` : ''}`, { size: 8, gap: 5 })
  }

  return Buffer.from(await pdf.save())
}

const signedFileName = (name) => `${String(name).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || 'contract'} - signed.pdf`

// Returns the stored signed PDF, building and saving it first if needed
export async function ensureSignedDocument(contractId) {
  const [existing] = await query(`SELECT FileName, Data FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = N'signed'`, { contractId })
  if (existing) return { fileName: existing.FileName, data: existing.Data }
  const [c] = await query(`SELECT Name FROM ${t.Contracts} WHERE Id = @contractId`, { contractId })
  const data = await buildSignedPdf(contractId)
  const fileName = signedFileName(c.Name)
  await query(
    `IF NOT EXISTS (SELECT 1 FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = N'signed')
       INSERT INTO ${t.ContractDocuments} (ContractId, Kind, FileName, SizeBytes, Sha256, Data)
       VALUES (@contractId, N'signed', @fileName, @size, @hash, @data)`,
    { contractId, fileName, size: data.length, hash: sha256(data), data: binary(data) },
  )
  return { fileName, data }
}

// Runs once when the last signer signs: builds the signed PDF and emails it to every signer and the sender
export async function finalizeContract(contractId, req) {
  const { fileName, data } = await ensureSignedDocument(contractId)
  await logEvent(query, { contractId, event: 'completed', detail: `Signed PDF created (SHA-256 ${sha256(data).slice(0, 16)}...)`, req })
  const c = await contractForMail(contractId)
  const signers = await query(`SELECT Name, Email FROM ${t.ContractSigners} WHERE ContractId = @contractId ORDER BY SignerOrder`, { contractId })
  // When the API caller delivers the links, they deliver the signed copy too; the sender still gets it
  const recipients = c.Notify === 'none' ? [] : signers.map((s) => ({ name: s.Name, email: s.Email }))
  if (c.SenderEmail && !recipients.some((r) => r.email === c.SenderEmail)) recipients.push({ name: c.SenderName, email: c.SenderEmail })
  for (const r of recipients) {
    await sendSigningCompleted({ to: r.email, name: r.name, contractName: c.Name, fileName, pdf: data }).catch(() => {})
  }
}
