import crypto from 'node:crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { config } from './config.js'
import { binary, query, t, transaction } from './db.js'
import { sendAuditTrailEmail, sendSigningCompleted, sendSigningInvite } from './mailer.js'
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

async function loadForPdf(contractId, includeSignedHash = false) {
  const [c] = await query(
    `SELECT c.Id, c.Name, c.WorkflowName, c.SigningMethod, c.Status, c.Estamping, c.CreatedAt, c.CompletedAt, c.BoxesJson, c.ParticipantsJson,
            o.Name AS OrgName, u.Name AS SenderName, u.Email AS SenderEmail
     FROM ${t.Contracts} c
     JOIN ${t.Organisations} o ON o.Id = c.OrganisationId
     LEFT JOIN ${t.Users} u ON u.Id = c.CreatedBy
     WHERE c.Id = @contractId`,
    { contractId },
  )
  const signers = await query(
    `SELECT SignerOrder, RoleId, Kind, Name, Email, Method, SignedMethod, Verification, LocationJson, LocationAddress, PhotoImage, Signed, SignedAt, DeclinedAt, DeclineReason, InvitedAt, ViewedAt, SignatureImage, SignatureType, SignedIp, SignedUserAgent, ReviewComment
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
  const [signed] = includeSignedHash
    ? await query(`SELECT Sha256 FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = N'signed'`, { contractId })
    : []
  return { c, signers, events, original, signed }
}

// Draws each signature into its boxes and adds the existing footer to every document page.
export async function buildSignedPdf(contractId) {
  const { c, signers, original } = await loadForPdf(contractId)
  if (!c || !original) throw new Error('The contract document is missing')

  const pdf = await PDFDocument.load(original.Data, { ignoreEncryption: true })
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const grey = rgb(0.42, 0.4, 0.5)
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

  return Buffer.from(await pdf.save())
}

// Renders the existing completion certificate and audit history into its own PDF.
const fullTimestamp = (date) => (date ? `${new Date(date).toISOString().slice(0, 19).replace('T', ' ')} UTC` : null)

function auditWrap(value, font, size, width) {
  const lines = []
  let line = ''
  for (const word of safe(value).split(/\s+/).filter(Boolean)) {
    let remaining = word
    while (font.widthOfTextAtSize(remaining, size) > width) {
      let end = 1
      while (end < remaining.length && font.widthOfTextAtSize(remaining.slice(0, end + 1), size) <= width) end += 1
      const piece = remaining.slice(0, end)
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(piece)
      remaining = remaining.slice(end)
    }
    if (line && font.widthOfTextAtSize(`${line} ${remaining}`, size) > width) {
      lines.push(line)
      line = remaining
    } else {
      line = line ? `${line} ${remaining}` : remaining
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

async function loadAuditLogo(pdf) {
  if (!config.auditTrail.logoUrl) return null
  try {
    const response = await fetch(config.auditTrail.logoUrl, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Logo server returned HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() || ''
    const size = Number(response.headers.get('content-length')) || 0
    if (size > 2 * 1024 * 1024) throw new Error('Logo exceeds the 2 MB limit')
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > 2 * 1024 * 1024) {
        await reader.cancel()
        throw new Error('Logo exceeds the 2 MB limit')
      }
      chunks.push(Buffer.from(value))
    }
    const bytes = Buffer.concat(chunks, total)
    if (contentType.includes('image/png') || bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return await pdf.embedPng(bytes)
    if (contentType.includes('image/jpeg') || contentType.includes('image/jpg') || (bytes[0] === 0xff && bytes[1] === 0xd8)) return await pdf.embedJpg(bytes)
    throw new Error('Logo must be a PNG or JPEG image')
  } catch (err) {
    console.warn(`[signing] audit trail logo could not be loaded: ${err.message}`)
    return null
  }
}

function auditBrowser(userAgent) {
  if (!userAgent) return null
  const browserVersion = [/Edg\/([\d.]+)/, /OPR\/([\d.]+)/, /Firefox\/([\d.]+)/, /Chrome\/([\d.]+)/, /Version\/([\d.]+).*Safari/]
    .map((pattern) => pattern.exec(userAgent)?.[1])
  const browser = browserVersion[0] ? `Edge ${browserVersion[0]}` : browserVersion[1] ? `Opera ${browserVersion[1]}` :
    browserVersion[2] ? `Firefox ${browserVersion[2]}` : browserVersion[3] ? `Chrome ${browserVersion[3]}` :
      browserVersion[4] ? `Safari ${browserVersion[4]}` : null
  const os = /Windows NT/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' :
    /iPhone|iPad|iPod/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : null
  return [browser, os].filter(Boolean).join(' / ') || null
}

// Branded, paginated rendering of the stored completion and audit evidence.
export async function buildAuditTrailPdf(contractId) {
  const { c, signers, events, original, signed } = await loadForPdf(contractId, true)
  if (!c || !original) throw new Error('The contract document is missing')

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const logo = await loadAuditLogo(pdf)
  const ink = rgb(0.12, 0.15, 0.2)
  const muted = rgb(0.38, 0.42, 0.49)
  const brand = rgb(0.16, 0.31, 0.53)
  const pale = rgb(0.95, 0.97, 0.99)
  const border = rgb(0.84, 0.87, 0.91)
  const images = new Map()
  for (const signer of signers) {
    const bytes = dataUrlToBytes(signer.SignatureImage)
    if (!bytes) continue
    try {
      images.set(signer.SignerOrder, await pdf.embedPng(bytes))
    } catch {
      console.warn(`[signing] signature image could not be embedded for contract ${contractId}, signer order ${signer.SignerOrder}`)
    }
  }
  const W = 595
  const H = 842
  const left = 44
  const right = W - 44
  const bottom = 58
  const pages = []
  let page
  let y

  const newPage = () => {
    page = pdf.addPage([W, H])
    pages.push(page)
    if (logo) {
      const scale = Math.min(128 / logo.width, 36 / logo.height)
      const width = logo.width * scale
      const height = logo.height * scale
      page.drawImage(logo, { x: left, y: 812 - height, width, height })
      if (config.auditTrail.subtitle) page.drawText(safe(config.auditTrail.subtitle), { x: left, y: 797 - height, size: 8, font, color: muted })
    } else if (config.auditTrail.subtitle) {
      page.drawText(safe(config.auditTrail.subtitle), { x: left, y: 792, size: 9, font: bold, color: brand })
    }
    page.drawText('AUDIT TRAIL', { x: 360, y: 794, size: 16, font: bold, color: brand })
    page.drawLine({ start: { x: left, y: 740 }, end: { x: right, y: 740 }, thickness: 0.8, color: border })
    y = 720
  }
  const space = (height) => {
    if (y - height < bottom) newPage()
  }
  const section = (title) => {
    space(28)
    page.drawText(safe(title), { x: left, y, size: 12, font: bold, color: brand })
    y -= 13
    page.drawLine({ start: { x: left, y: y - 2 }, end: { x: right, y: y - 2 }, thickness: 0.55, color: border })
    y -= 12
  }
  newPage()
  section('Document Information')
  for (const line of auditWrap('This document was signed electronically through eSign Doc Builder.', font, 8.5, right - left)) {
    page.drawText(line, { x: left, y, size: 8.5, font, color: muted })
    y -= 11
  }
  y -= 3
  const sender = [c.SenderName, c.SenderEmail ? `(${c.SenderEmail})` : null, c.OrgName].filter(Boolean).join(' - ')
  const metadata = [
    ['Document Name', c.Name],
    ['Document ID / Contract ID', c.Id],
    ['Workflow Name', c.WorkflowName],
    ['Document Hash (SHA-256)', signed?.Sha256],
    ['Status', c.Status],
    ['Sent by', sender],
    ['Signing order', c.SigningMethod === 'parallel' ? 'Parallel' : c.SigningMethod === 'sequential' ? 'Sequential' : null],
    ['Created Date and Time', fullTimestamp(c.CreatedAt)],
    ['Completed Date and Time', fullTimestamp(c.CompletedAt)],
    ['Original Document Name', original.FileName],
    ['Original Document SHA-256', original.Sha256],
    ['Stamping Details', c.Estamping],
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
  for (const [label, value] of metadata) {
    const lines = auditWrap(value, font, 8.5, right - 190)
    const height = Math.max(17, lines.length * 10 + 5)
    space(height)
    page.drawText(safe(label), { x: left, y, size: 8.2, font: bold, color: muted })
    lines.forEach((line, i) => page.drawText(line, { x: 190, y: y - i * 10, size: 8.5, font, color: ink }))
    y -= height
    page.drawLine({ start: { x: left, y: y + 3 }, end: { x: right, y: y + 3 }, thickness: 0.35, color: border })
    y -= 2
  }

  const about = 'This audit trail provides a chronological record of activities performed during the electronic signing process. It captures document events, participant actions, timestamps, verification details, and completion information to support transparency and traceability.'
  const aboutLines = auditWrap(about, font, 8.5, right - left - 24)
  const aboutHeight = 32 + aboutLines.length * 11
  space(aboutHeight)
  page.drawRectangle({ x: left, y: y - aboutHeight + 4, width: right - left, height: aboutHeight, color: pale })
  page.drawText('About the Audit Trail', { x: left + 12, y: y - 12, size: 9.5, font: bold, color: brand })
  aboutLines.forEach((line, i) => page.drawText(line, { x: left + 12, y: y - 28 - i * 11, size: 8.5, font, color: ink }))
  y -= aboutHeight + 12

  section('Participants')
  const participants = signers.map((s, i) => ({ ...s, serial: i + 1, role: s.Kind === 'reviewer' ? 'Reviewer' : 'Signer' }))
  if (c.SenderName || c.SenderEmail) {
    const senderParticipant = participants.find((s) => s.Email?.toLowerCase() === c.SenderEmail?.toLowerCase())
    if (senderParticipant) senderParticipant.role += ' / Invitation Sender'
    else participants.push({ serial: participants.length + 1, Name: c.SenderName, Email: c.SenderEmail, Kind: 'sender', role: 'Invitation Sender' })
  }
  const participantHeading = (participant, continuation = false, card = false) => {
    const text = `${participant.serial}. ${participant.Name || 'Participant'} - ${participant.role}${continuation ? ' (continued)' : ''}`
    const lines = auditWrap(text, bold, 9, right - left - 16)
    const height = lines.length * 11 + 8
    space(height)
    if (card) page.drawRectangle({ x: left, y: y - height + 6, width: right - left, height, color: pale })
    for (const line of lines) {
      page.drawText(line, { x: left + (card ? 8 : 0), y, size: 9, font: bold, color: brand })
      y -= 11
    }
    y -= 2
  }
  for (const s of participants) {
    participantHeading(s, false, true)
    const method = s.SignedMethod ?? s.Method
    const signatureType = s.SignatureType === 'stamp' ? 'Generated' : s.SignatureType === 'type' ? 'Typed' : s.SignatureType === 'draw' ? 'Drawn' : null
    const loc = s.LocationJson ? JSON.parse(s.LocationJson) : null
    const details = [
      ['Email', s.Email],
      ['Role', s.role],
      ['Signing method', method ? (METHOD_LABELS[method] ?? method) : null],
      ['Signature type', signatureType],
      ['Verification method / status', s.Verification],
      ['Participant status', s.Kind === 'sender' ? null : s.DeclinedAt ? (s.Kind === 'reviewer' ? 'Rejected' : 'Declined') : s.Signed ? (s.Kind === 'reviewer' ? 'Approved' : 'Signed') : 'Pending'],
      ['Invitation timestamp', fullTimestamp(s.InvitedAt)],
      ['Viewed timestamp', fullTimestamp(s.ViewedAt)],
      [s.Kind === 'reviewer' ? 'Approved timestamp' : 'Signed timestamp', fullTimestamp(s.SignedAt)],
      ['IP address', s.SignedIp],
      ['Device information', s.SignedUserAgent],
      ['Browser / operating system', auditBrowser(s.SignedUserAgent)],
      ['Review comment', s.ReviewComment],
      ['Decline reason', s.DeclineReason],
      ['Location', loc ? `${loc.lat}, ${loc.lng}${loc.accuracy != null ? ` (accuracy ${loc.accuracy} m)` : ''}` : null],
      ['Map URL', loc ? `https://maps.google.com/?q=${loc.lat},${loc.lng}` : null],
      ['Location address', s.LocationAddress],
    ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    for (const [label, value] of details) {
      const lines = auditWrap(value, font, 8, right - 178)
      for (let i = 0; i < lines.length; i += 1) {
        if (y - 10 < bottom) {
          newPage()
          participantHeading(s, true)
        }
        if (i === 0) page.drawText(safe(label), { x: left + 8, y, size: 7.7, font: bold, color: muted })
        page.drawText(lines[i], { x: 178, y, size: 8, font, color: ink })
        y -= 10
      }
    }

    const signature = images.get(s.SignerOrder)
    if (signature) {
      if (y - 62 < bottom) {
        newPage()
        participantHeading(s, true)
      }
      const scale = Math.min(145 / signature.width, 48 / signature.height)
      const width = signature.width * scale
      const height = signature.height * scale
      page.drawText('Signature', { x: left + 8, y, size: 7.7, font: bold, color: muted })
      page.drawImage(signature, { x: 178, y: y - height + 5, width, height })
      y -= Math.max(55, height) + 4
    }
    if (s.PhotoImage) {
      try {
        const photo = await pdf.embedJpg(Buffer.from(s.PhotoImage.split(',')[1] ?? '', 'base64'))
        if (y - 76 < bottom) {
          newPage()
          participantHeading(s, true)
        }
        const scale = Math.min(100 / photo.width, 58 / photo.height)
        const width = photo.width * scale
        const height = photo.height * scale
        page.drawText('Live photo evidence', { x: left + 8, y, size: 7.7, font: bold, color: muted })
        page.drawImage(photo, { x: 178, y: y - height + 5, width, height })
        y -= Math.max(65, height) + 4
      } catch {
        console.warn(`[signing] a live photo could not be embedded for contract ${contractId}`)
      }
    }
    y -= 5
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.45, color: border })
    y -= 10
  }

  section('Audit Event History')
  const columns = [
    { title: 'Sr. No.', x: left, width: 36 },
    { title: 'Date & Time', x: left + 36, width: 96 },
    { title: 'Participant', x: left + 132, width: 90 },
    { title: 'Activity', x: left + 222, width: 90 },
    { title: 'Details', x: left + 312, width: right - left - 312 },
  ]
  const eventHeader = () => {
    space(25)
    page.drawRectangle({ x: left, y: y - 5, width: right - left, height: 19, color: pale })
    for (const column of columns) page.drawText(column.title, { x: column.x + 3, y, size: 7.2, font: bold, color: brand })
    y -= 20
  }
  eventHeader()
  for (const [index, event] of events.entries()) {
    if (y < bottom + 20) eventHeader()
    const participant = event.SignerOrder ? signers.find((s) => s.SignerOrder === event.SignerOrder)?.Name : null
    const detail = [event.Detail, event.IpAddress ? `IP: ${event.IpAddress}` : null].filter(Boolean).join(' | ')
    const values = [String(index + 1), fullTimestamp(event.CreatedAt) || '', participant || '', String(event.Event || '').replace(/[_-]+/g, ' '), detail]
    const lines = values.map((value, cell) => auditWrap(value, font, 7.1, columns[cell].width - 7))
    let offset = 0
    while (lines.some((cell) => offset < cell.length)) {
      const capacity = Math.max(1, Math.floor((y - bottom - 8) / 8.5))
      const remaining = lines.map((cell) => Math.max(0, cell.length - offset)).filter(Boolean)
      const count = Math.max(1, Math.min(capacity, Math.max(...remaining)))
      for (let line = 0; line < count; line += 1) {
        for (let cell = 0; cell < lines.length; cell += 1) {
          const value = lines[cell][offset + line]
          if (value) page.drawText(value, { x: columns[cell].x + 3, y: y - line * 8.5, size: 7.1, font, color: ink })
        }
      }
      y -= count * 8.5 + 6
      offset += count
      page.drawLine({ start: { x: left, y: y + 3 }, end: { x: right, y: y + 3 }, thickness: 0.35, color: border })
      if (lines.some((cell) => offset < cell.length)) eventHeader()
    }
  }

  pages.forEach((pdfPage, index) => {
    pdfPage.drawLine({ start: { x: left, y: 43 }, end: { x: right, y: 43 }, thickness: 0.55, color: border })
    const footer = `${config.auditTrail.subtitle || 'Jayam Solutions Ltd'} | Digitally generated Audit Trail | Document ${safe(c.Id)}`
    pdfPage.drawText(footer, { x: left, y: 29, size: 6.7, font, color: muted, maxWidth: 400 })
    const pageNumber = `Page ${index + 1} of ${pages.length}`
    pdfPage.drawText(pageNumber, { x: right - font.widthOfTextAtSize(pageNumber, 7), y: 29, size: 7, font, color: muted })
  })
  return Buffer.from(await pdf.save())
}

const cleanFileName = (name) => String(name).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 150) || 'contract'
const signedFileName = (name) => `${cleanFileName(name)} - signed.pdf`
const auditFileName = (name) => `${cleanFileName(name)} - audit trail.pdf`
const PDF_STATUS_FIELDS = {
  signed: { status: 'SignedPdfStatus', startedAt: 'SignedPdfStartedAt', generatedAt: 'SignedPdfGeneratedAt', error: 'SignedPdfError' },
  audit: { status: 'AuditPdfStatus', startedAt: 'AuditPdfStartedAt', generatedAt: 'AuditPdfGeneratedAt', error: 'AuditPdfError' },
}

async function setPdfStatus(contractId, kind, status, error = null, generated = false) {
  const fields = PDF_STATUS_FIELDS[kind]
  await query(
    `UPDATE ${t.Contracts}
     SET ${fields.status} = @status,
         ${fields.startedAt} = CASE WHEN @status = N'generating' THEN SYSUTCDATETIME() ELSE NULL END,
         ${fields.generatedAt} = CASE WHEN @status = N'ready' AND (@generated = 1 OR ${fields.generatedAt} IS NULL) THEN SYSUTCDATETIME() ELSE ${fields.generatedAt} END,
         ${fields.error} = @error
     WHERE Id = @contractId`,
    { contractId, status, error: error ? String(error).slice(0, 1000) : null, generated },
  )
}

async function ensurePdfDocument(contractId, kind) {
  const [existing] = await query(
    `SELECT FileName, Data, SizeBytes, Sha256 FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = @kind`,
    { contractId, kind },
  )
  if (existing) {
    const data = Buffer.from(existing.Data)
    if (!data.length || existing.SizeBytes !== data.length || existing.Sha256 !== sha256(data)) {
      const error = `Stored ${kind} PDF failed its integrity check`
      await setPdfStatus(contractId, kind, 'failed', error)
      if (kind === 'signed') throw new Error(error)
    } else {
      await setPdfStatus(contractId, kind, 'ready')
      return { fileName: existing.FileName, data }
    }
  }

  const fields = PDF_STATUS_FIELDS[kind]
  const claimGeneration = async () => {
    const claimed = await query(
      `UPDATE ${t.Contracts}
       SET ${fields.status} = N'generating', ${fields.startedAt} = SYSUTCDATETIME(), ${fields.error} = NULL
       OUTPUT inserted.Id
       WHERE Id = @contractId AND (
         ${fields.status} IN (N'pending', N'failed', N'ready')
         OR (${fields.status} = N'generating' AND (${fields.startedAt} IS NULL OR ${fields.startedAt} < DATEADD(minute, -15, SYSUTCDATETIME())))
       )`,
      { contractId },
    )
    return claimed.length > 0
  }
  let claimed = await claimGeneration()
  for (let attempt = 0; !claimed && attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const [saved] = await query(
      `SELECT FileName, Data, SizeBytes, Sha256 FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = @kind`,
      { contractId, kind },
    )
    if (saved) {
      const data = Buffer.from(saved.Data)
      if (data.length && saved.SizeBytes === data.length && saved.Sha256 === sha256(data)) {
        await setPdfStatus(contractId, kind, 'ready')
        return { fileName: saved.FileName, data }
      }
    }
    claimed = await claimGeneration()
  }
  if (!claimed) throw new Error(`${kind} PDF generation is already in progress`)

  try {
    const [c] = await query(`SELECT Name FROM ${t.Contracts} WHERE Id = @contractId`, { contractId })
    if (!c) throw new Error('Contract not found')
    const data = kind === 'signed' ? await buildSignedPdf(contractId) : await buildAuditTrailPdf(contractId)
    const fileName = kind === 'signed' ? signedFileName(c.Name) : auditFileName(c.Name)
    if (kind === 'audit') {
      await query(
        `MERGE ${t.ContractDocuments} WITH (HOLDLOCK) AS target
         USING (SELECT @contractId AS ContractId, @kind AS Kind) AS source
         ON target.ContractId = source.ContractId AND target.Kind = source.Kind
         WHEN MATCHED THEN UPDATE SET FileName = @fileName, SizeBytes = @size, Sha256 = @hash, Data = @data, CreatedAt = SYSUTCDATETIME()
         WHEN NOT MATCHED THEN INSERT (ContractId, Kind, FileName, SizeBytes, Sha256, Data)
           VALUES (@contractId, @kind, @fileName, @size, @hash, @data);`,
        { contractId, kind, fileName, size: data.length, hash: sha256(data), data: binary(data) },
      )
    } else {
      await query(
        `IF NOT EXISTS (SELECT 1 FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = @kind)
           INSERT INTO ${t.ContractDocuments} (ContractId, Kind, FileName, SizeBytes, Sha256, Data)
           VALUES (@contractId, @kind, @fileName, @size, @hash, @data)`,
        { contractId, kind, fileName, size: data.length, hash: sha256(data), data: binary(data) },
      )
    }
    const [saved] = await query(
      `SELECT FileName, Data FROM ${t.ContractDocuments} WHERE ContractId = @contractId AND Kind = @kind`,
      { contractId, kind },
    )
    if (!saved) throw new Error(`Could not save ${kind} PDF`)
    await setPdfStatus(contractId, kind, 'ready', null, true)
    return { fileName: saved.FileName, data: Buffer.from(saved.Data) }
  } catch (err) {
    await setPdfStatus(contractId, kind, 'failed', err.message)
    throw err
  }
}

// Returns the stored signed PDF, building and saving it first if needed.
export async function ensureSignedDocument(contractId) {
  return ensurePdfDocument(contractId, 'signed')
}

export async function ensureAuditTrailDocument(contractId) {
  return ensurePdfDocument(contractId, 'audit')
}

async function recordCompletionEvent(contractId, req) {
  await transaction(async (run) => {
    await run(`SELECT Id FROM ${t.Contracts} WITH (UPDLOCK, HOLDLOCK) WHERE Id = @contractId`, { contractId })
    const [existing] = await run(
      `SELECT TOP 1 Id FROM ${t.ContractEvents} WHERE ContractId = @contractId AND Event = N'completed'`,
      { contractId },
    )
    if (!existing) await logEvent(run, { contractId, event: 'completed', detail: 'All required participants completed signing', req })
  })
}

async function deliverCompletionEmail(contractId, signer, kind, document, contractName) {
  const claimed = await query(
    `UPDATE ${t.ContractEmailDeliveries}
     SET Status = N'sending', AttemptCount = AttemptCount + 1, LastAttemptAt = SYSUTCDATETIME(), LastError = NULL
     OUTPUT inserted.Status
     WHERE ContractId = @contractId AND SignerOrder = @order AND Kind = @kind
       AND (Status IN (N'pending', N'failed')
         OR (Status = N'sending' AND LastAttemptAt < DATEADD(minute, -15, SYSUTCDATETIME())))`,
    { contractId, order: signer.SignerOrder, kind },
  )
  if (!claimed.length) return

  try {
    const sent = kind === 'signed'
      ? await sendSigningCompleted({ to: signer.Email, name: signer.Name, contractName, fileName: document.fileName, pdf: document.data })
      : await sendAuditTrailEmail({ to: signer.Email, name: signer.Name, contractName, fileName: document.fileName, pdf: document.data })
    if (!sent) throw new Error('SMTP is not configured; email was not delivered')
    await query(
      `UPDATE ${t.ContractEmailDeliveries}
       SET Status = N'sent', SentAt = SYSUTCDATETIME(), LastError = NULL
       WHERE ContractId = @contractId AND SignerOrder = @order AND Kind = @kind AND Status = N'sending'`,
      { contractId, order: signer.SignerOrder, kind },
    )
  } catch (err) {
    const error = [err.code, err.responseCode].filter(Boolean).join(' / ')
    const summary = error ? `Mail delivery failed (${error})` : 'Mail delivery failed'
    await query(
      `UPDATE ${t.ContractEmailDeliveries}
       SET Status = N'failed', LastError = @error
       WHERE ContractId = @contractId AND SignerOrder = @order AND Kind = @kind AND Status = N'sending'`,
      { contractId, order: signer.SignerOrder, kind, error: summary },
    )
    console.error(`[signing] ${kind} completion email failed for contract ${contractId}: ${summary}`)
  }
}

// Completes document generation and both independent email deliveries; failed emails can be retried.
export async function finalizeContract(contractId, req) {
  const [contract] = await query(
    `SELECT Id, Name, Status FROM ${t.Contracts} WHERE Id = @contractId`,
    { contractId },
  )
  if (!contract || contract.Status !== 'completed') throw new Error('Contract is not eligible for finalization')
  const [eligibility] = await query(
    `SELECT
       SUM(CASE WHEN Signed = 0 THEN 1 ELSE 0 END) AS PendingCount,
       SUM(CASE WHEN Kind = N'signer' THEN 1 ELSE 0 END) AS SignerCount
     FROM ${t.ContractSigners} WHERE ContractId = @contractId`,
    { contractId },
  )
  if (!eligibility.SignerCount || eligibility.PendingCount) throw new Error('Contract has participants who have not completed signing')

  await recordCompletionEvent(contractId, req)
  let signed = null
  let audit = null
  try {
    signed = await ensureSignedDocument(contractId)
  } catch (err) {
    console.error(`[signing] signed PDF generation failed for contract ${contractId}: ${err.message}`)
  }
  try {
    audit = await ensureAuditTrailDocument(contractId)
  } catch (err) {
    console.error(`[signing] audit PDF generation failed for contract ${contractId}: ${err.message}`)
  }

  const signers = await query(
    `SELECT SignerOrder, Name, Email FROM ${t.ContractSigners}
     WHERE ContractId = @contractId AND Kind = N'signer' ORDER BY SignerOrder`,
    { contractId },
  )
  for (const kind of ['signed', 'audit']) {
    await query(
      `MERGE ${t.ContractEmailDeliveries} WITH (HOLDLOCK) AS target
       USING (
         SELECT s.ContractId, s.SignerOrder
         FROM ${t.ContractSigners} s
         WHERE s.ContractId = @contractId AND s.Kind = N'signer'
       ) AS source
       ON target.ContractId = source.ContractId AND target.SignerOrder = source.SignerOrder AND target.Kind = @kind
       WHEN NOT MATCHED THEN
         INSERT (ContractId, SignerOrder, Kind, Status)
         VALUES (source.ContractId, source.SignerOrder, @kind, N'pending');`,
      { contractId, kind },
    )
    const document = kind === 'signed' ? signed : audit
    if (!document) continue
    for (const signer of signers) await deliverCompletionEmail(contractId, signer, kind, document, contract.Name)
  }
  return query(
    `SELECT SignerOrder AS signerOrder, Kind AS kind, Status AS status, AttemptCount AS attempts, SentAt AS sentAt, LastError AS error
     FROM ${t.ContractEmailDeliveries} WHERE ContractId = @contractId ORDER BY SignerOrder, Kind`,
    { contractId },
  )
}
