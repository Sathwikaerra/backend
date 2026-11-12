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
    `SELECT SignerOrder, RoleId, Kind, Name, Email, Phone, Method, SignedMethod, Verification, VerificationJson, LocationJson, LocationAddress, PhotoImage, Signed, SignedAt, DeclinedAt, DeclineReason, InvitedAt, ViewedAt, SignatureImage, SignatureType, SignedIp, SignedUserAgent, ReviewComment
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
// export async function buildAuditTrailPdf(contractId) {
//   const { c, signers, original, signed } = await loadForPdf(contractId, true)
//   if (!c || !original) throw new Error('The contract document is missing')

//   const pdf = await PDFDocument.create()
//   const font = await pdf.embedFont(StandardFonts.Helvetica)
//   const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
//   const logo = await loadAuditLogo(pdf)
//   const ink = rgb(0.12, 0.15, 0.2)
//   const muted = rgb(0.38, 0.42, 0.49)
//   const brand = rgb(0.16, 0.31, 0.53)
//   const pale = rgb(0.94, 0.97, 0.99)
//   const border = rgb(0.84, 0.87, 0.91)
//   const images = new Map()
//   for (const signer of signers) {
//     const bytes = dataUrlToBytes(signer.SignatureImage)
//     if (!bytes) continue
//     try {
//       images.set(signer.SignerOrder, await pdf.embedPng(bytes))
//     } catch {
//       console.warn(`[signing] signature image could not be embedded for contract ${contractId}, signer order ${signer.SignerOrder}`)
//     }
//   }

//   const W = 595
//   const H = 842
//   const left = 46
//   const right = W - 46
//   const bottom = 58
//   const labelX = left + 10
//   const valueX = left + 152
//   const valueWidth = right - valueX - 10
//   const rowLeading = 11.5
//   const pages = []
//   let page
//   let y

//   const newPage = () => {
//     page = pdf.addPage([W, H])
//     pages.push(page)
//     if (logo) {
//       const scale = Math.min(132 / logo.width, 36 / logo.height)
//       const width = logo.width * scale
//       const height = logo.height * scale
//       page.drawImage(logo, { x: left, y: 790, width, height })
//       if (config.auditTrail.subtitle) page.drawText(safe(config.auditTrail.subtitle), { x: left, y: 776, size: 8.5, font, color: muted })
//     } else if (config.auditTrail.subtitle) {
//       page.drawText(safe(config.auditTrail.subtitle), { x: left, y: 794, size: 9, font: bold, color: brand })
//     }
//     const title = 'AUDIT TRAIL'
//     page.drawText(title, { x: right - bold.widthOfTextAtSize(title, 17), y: 801, size: 17, font: bold, color: brand })
//     page.drawLine({ start: { x: left, y: 760 }, end: { x: right, y: 760 }, thickness: 0.75, color: border })
//     y = 742
//   }
//   const space = (height) => {
//     if (y - height < bottom) newPage()
//   }
//   const section = (title) => {
//     space(32)
//     page.drawText(safe(title), { x: left, y, size: 12, font: bold, color: brand })
//     y -= 6
//     page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: border })
//     y -= 14
//   }
//   const available = (value) => value !== null && value !== undefined && String(value).trim() !== ''
//   const parseJson = (value) => {
//     try {
//       return value ? JSON.parse(value) : null
//     } catch {
//       return null
//     }
//   }

//   newPage()
//   section('Document Information')
//   const sender = [c.SenderName, c.SenderEmail ? `(${c.SenderEmail})` : null, c.OrgName].filter(Boolean).join(' - ')
//   const metadata = [
//     ['Document Name', c.Name],
//     ['Document ID / Contract ID', c.Id],
//     ['Workflow Name', c.WorkflowName],
//     ['Document Hash (SHA-256)', signed?.Sha256],
//     ['Status', c.Status],
//     ['Sent By', sender],
//     ['Signing Order', c.SigningMethod === 'parallel' ? 'Parallel' : c.SigningMethod === 'sequential' ? 'Sequential' : null],
//     ['Created Date and Time', fullTimestamp(c.CreatedAt)],
//     ['Completed Date and Time', fullTimestamp(c.CompletedAt)],
//     ['Original Document Name', original.FileName],
//     ['Original Document SHA-256', original.Sha256],
//     ['Stamp Details', c.Estamping],
//   ].filter(([, value]) => available(value))

//   for (const [label, value] of metadata) {
//     const lines = auditWrap(value, font, 9, valueWidth)
//     const height = Math.max(19, lines.length * rowLeading + 7)
//     space(height)
//     lines.forEach((line, index) => {
//       const baseline = y - 10 - index * rowLeading
//       if (index === 0) page.drawText(safe(label), { x: labelX, y: baseline, size: 8.2, font: bold, color: muted })
//       page.drawText(line, { x: valueX, y: baseline, size: 9, font, color: ink })
//     })
//     y -= height
//     page.drawLine({ start: { x: left, y: y + 3 }, end: { x: right, y: y + 3 }, thickness: 0.35, color: border })
//     y -= 3
//   }

//   const about = 'This audit trail provides a record of the electronic signing process, including document information, participant identities, verification details and signing timestamps.'
//   const aboutLines = auditWrap(about, font, 9, right - left - 28)
//   const aboutHeight = 32 + aboutLines.length * 11
//   space(aboutHeight + 12)
//   page.drawRectangle({ x: left, y: y - aboutHeight + 4, width: right - left, height: aboutHeight, color: pale })
//   page.drawText('About the Audit Trail', { x: left + 12, y: y - 13, size: 10, font: bold, color: brand })
//   aboutLines.forEach((line, index) => page.drawText(line, { x: left + 12, y: y - 29 - index * 11, size: 9, font, color: ink }))
//   y -= aboutHeight + 12

//   section('Participants')
//   const participants = signers.map((s, index) => ({ ...s, serial: index + 1, role: s.Kind === 'reviewer' ? 'Reviewer' : 'Signer' }))
//   if (c.SenderName || c.SenderEmail) {
//     const senderParticipant = participants.find((s) => s.Email?.toLowerCase() === c.SenderEmail?.toLowerCase())
//     if (senderParticipant) senderParticipant.role += ' / Invitation Sender'
//     else participants.push({ serial: participants.length + 1, Name: c.SenderName, Email: c.SenderEmail, Kind: 'sender', role: 'Invitation Sender' })
//   }

//   for (const participant of participants) {
//     const method = participant.SignedMethod ?? participant.Method
//     const signatureType = participant.SignatureType === 'stamp' ? 'Generated' : participant.SignatureType === 'type' ? 'Typed' : participant.SignatureType === 'draw' ? 'Drawn' : null
//     const location = parseJson(participant.LocationJson)
//     const evidence = parseJson(participant.VerificationJson)
//     const certificate = evidence?.certificate
//     const locationText = location && available(location.lat) && available(location.lng)
//       ? `${location.lat}, ${location.lng}${location.accuracy != null ? ` (accuracy ${location.accuracy} m)` : ''}`
//       : null
//     const details = [
//       ['Email', participant.Email],
//       ['Phone', participant.Phone],
//       ['Role', participant.role],
//       ['Signing Method', method ? (METHOD_LABELS[method] ?? method) : null],
//       ['Signature Type', signatureType],
//       ['Verification Method / Status', participant.Verification],
//       ['Participant Status', participant.Kind === 'sender' ? null : participant.DeclinedAt ? (participant.Kind === 'reviewer' ? 'Rejected' : 'Declined') : participant.Signed ? (participant.Kind === 'reviewer' ? 'Approved' : 'Signed') : 'Pending'],
//       ['Invitation Date', fullTimestamp(participant.InvitedAt)],
//       ['Viewed Date', fullTimestamp(participant.ViewedAt)],
//       [participant.Kind === 'reviewer' ? 'Approved Date' : 'Signed Date', fullTimestamp(participant.SignedAt)],
//       ['IP Address', participant.SignedIp],
//       ['Browser / Operating System', auditBrowser(participant.SignedUserAgent)],
//       ['Device Details', participant.SignedUserAgent],
//       ['Review Comment', participant.ReviewComment],
//       ['Decline Reason', participant.DeclineReason],
//       ['Location', locationText],
//       ['Location Address', participant.LocationAddress],
//       ['Certificate Subject', certificate?.subject],
//       ['Certificate Issuer', certificate?.issuer],
//       ['Certificate Serial', certificate?.serial],
//       ['Certificate Valid Until', certificate?.validTo],
//     ].filter(([, value]) => available(value))
//     const rows = details.map(([label, value]) => ({ label, lines: auditWrap(value, font, 8.6, valueWidth) }))
//     const signature = images.get(participant.SignerOrder)
//     let photo = null
//     if (participant.PhotoImage) {
//       try {
//         photo = await pdf.embedJpg(Buffer.from(participant.PhotoImage.split(',')[1] ?? '', 'base64'))
//       } catch {
//         console.warn(`[signing] a live photo could not be embedded for contract ${contractId}`)
//       }
//     }
//     const imageSize = (image, maxWidth, maxHeight) => {
//       if (!image) return null
//       const scale = Math.min(maxWidth / image.width, maxHeight / image.height)
//       return { width: image.width * scale, height: image.height * scale }
//     }
//     const signatureSize = imageSize(signature, 145, 44)
//     const photoSize = imageSize(photo, 100, 54)
//     const headingText = `Participant ${participant.serial}${available(participant.Name) ? ` - ${participant.Name}` : ''}`
//     const headingLines = auditWrap(headingText, bold, 9.5, right - left - 24)
//     const headingHeight = headingLines.length * 12 + 11
//     const estimatedHeight = headingHeight + rows.reduce((height, row) => height + Math.max(rowLeading, row.lines.length * rowLeading) + 8, 0) +
//       (signatureSize ? Math.max(16, signatureSize.height) + 11 : 0) + (photoSize ? Math.max(16, photoSize.height) + 11 : 0) + 12
//     if (estimatedHeight <= 742 - bottom && y - estimatedHeight < bottom) newPage()

//     const participantHeading = (continued = false) => {
//       const text = continued ? `${headingText} (continued)` : headingText
//       const lines = auditWrap(text, bold, 9.5, right - left - 24)
//       const height = lines.length * 12 + 11
//       if (y - height < bottom) newPage()
//       page.drawRectangle({ x: left, y: y - height + 4, width: right - left, height, color: pale })
//       lines.forEach((line, index) => page.drawText(line, { x: left + 10, y: y - 10 - index * 12, size: 9.5, font: bold, color: brand }))
//       y -= height + 2
//     }
//     participantHeading()

//     for (const row of rows) {
//       const rowHeight = Math.max(rowLeading, row.lines.length * rowLeading) + 8
//       if (rowHeight <= 742 - bottom && y - rowHeight < bottom) {
//         newPage()
//         participantHeading(true)
//       }
//       y -= 3
//       for (let index = 0; index < row.lines.length; index += 1) {
//         if (y - rowLeading < bottom) {
//           newPage()
//           participantHeading(true)
//           page.drawText(`${safe(row.label)} (continued)`, { x: labelX, y: y - 9, size: 8.2, font: bold, color: muted })
//         } else if (index === 0) {
//           page.drawText(safe(row.label), { x: labelX, y: y - 9, size: 8.2, font: bold, color: muted })
//         }
//         page.drawText(row.lines[index], { x: valueX, y: y - 9, size: 8.6, font, color: ink })
//         y -= rowLeading
//       }
//       y -= 5
//       page.drawLine({ start: { x: left + 8, y }, end: { x: right - 8, y }, thickness: 0.25, color: border })
//     }

//     for (const [label, image, size] of [
//       ['Signature Image', signature, signatureSize],
//       ['Live Photo Evidence', photo, photoSize],
//     ]) {
//       if (!image || !size) continue
//       const height = Math.max(16, size.height) + 11
//       if (y - height < bottom) {
//         newPage()
//         participantHeading(true)
//       }
//       page.drawText(label, { x: labelX, y: y - 9, size: 8.2, font: bold, color: muted })
//       page.drawImage(image, { x: valueX, y: y - size.height + 2, width: size.width, height: size.height })
//       y -= height
//     }

//     if (y - 10 >= bottom) {
//       y -= 5
//       page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: border })
//       y -= 12
//     } else {
//       y = bottom
//     }
//   }

//   pages.forEach((pdfPage, index) => {
//     pdfPage.drawLine({ start: { x: left, y: 43 }, end: { x: right, y: 43 }, thickness: 0.55, color: border })
//     const footer = `${config.auditTrail.subtitle || 'Jayam Solutions Ltd'} | Digitally generated Audit Trail | Document ${safe(c.Id)}`
//     pdfPage.drawText(footer, { x: left, y: 28, size: 6.8, font, color: muted, maxWidth: 400 })
//     const pageNumber = `Page ${index + 1} of ${pages.length}`
//     pdfPage.drawText(pageNumber, { x: right - font.widthOfTextAtSize(pageNumber, 7), y: 28, size: 7, font, color: muted })
//   })
//   return Buffer.from(await pdf.save())
// }

// Converts a stored PNG/JPEG to greyscale (alpha kept) so the whole report is strictly black and white.
// Falls back to the original bytes if `sharp` is unavailable, so PDF generation never fails because of it.
export async function toGrayscaleBytes(bytes) {
  try {
    const { default: sharp } = await import('sharp')
    return new Uint8Array(await sharp(Buffer.from(bytes)).grayscale().png().toBuffer())
  } catch {
    return new Uint8Array(bytes)
  }
}
const embedImage = async (doc, bytes) => (bytes[0] === 0x89 && bytes[1] === 0x50 ? doc.embedPng(bytes) : doc.embedJpg(bytes))

export async function buildAuditTrailPdf(contractId) {
  const { c, signers, original, signed } = await loadForPdf(contractId, true)
  if (!c || !original) throw new Error('The contract document is missing')

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const sans = await pdf.embedFont(StandardFonts.Helvetica)
  const logo = await loadAuditLogo(pdf)
  const ink = rgb(0.1, 0.1, 0.1)
  const muted = rgb(0.4, 0.4, 0.4)
  const rule = rgb(0.78, 0.78, 0.8)
  const strongRule = rgb(0.55, 0.55, 0.58)
  const band = rgb(0.95, 0.95, 0.96)
  const brand = rgb(0.07, 0.07, 0.07) // headings: near-black
  const headingBlue = rgb(0.91, 0.91, 0.92) // header / tag fill: light grey
  const gridColor = rgb(0.68, 0.68, 0.7)
  const images = new Map()
  for (const signer of signers) {
    const bytes = dataUrlToBytes(signer.SignatureImage)
    if (!bytes) continue
    try {
      images.set(signer.SignerOrder, await embedImage(pdf, await toGrayscaleBytes(bytes)))
    } catch {
      console.warn(`[signing] signature image could not be embedded for contract ${contractId}, signer order ${signer.SignerOrder}`)
    }
  }

  const W = 595
  const H = 842
  const left = 46
  const right = W - 46
  const tableWidth = right - left
  const bottom = 58
  const pages = []
  let page
  let y

  const available = (value) => value !== null && value !== undefined && String(value).trim() !== ''
  const parseJson = (value) => {
    try {
      return value ? JSON.parse(value) : null
    } catch {
      return null
    }
  }

  // Word-wraps text (and '\n' breaks); tokens wider than the cell (emails, hashes) are hard-broken.
  const wrapCell = (value, fnt, size, maxWidth) => {
    const out = []
    for (const paragraph of safe(String(value)).replace(/\r/g, '').split('\n')) {
      let line = ''
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word
        if (fnt.widthOfTextAtSize(candidate, size) <= maxWidth) {
          line = candidate
          continue
        }
        if (line) out.push(line)
        let rest = word
        while (fnt.widthOfTextAtSize(rest, size) > maxWidth) {
          let n = rest.length - 1
          while (n > 1 && fnt.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n -= 1
          out.push(rest.slice(0, n))
          rest = rest.slice(n)
        }
        line = rest
      }
      out.push(line)
    }
    return out.length ? out : ['']
  }
  // Same, for a value that follows an inline bold label: the first line is shorter by the label width.
  const wrapInline = (value, fnt, size, firstWidth, restWidth) => {
    const out = []
    let line = ''
    const limit = () => (out.length === 0 ? firstWidth : restWidth)
    for (const word of safe(String(value)).replace(/\s+/g, ' ').split(' ').filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (fnt.widthOfTextAtSize(candidate, size) <= limit()) {
        line = candidate
        continue
      }
      if (line) {
        out.push(line)
        line = ''
      }
      let rest = word
      while (fnt.widthOfTextAtSize(rest, size) > limit()) {
        let n = rest.length - 1
        while (n > 1 && fnt.widthOfTextAtSize(rest.slice(0, n), size) > limit()) n -= 1
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
    return out
  }
  const fitImage = (image, maxWidth, maxHeight) => {
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1)
    return { width: image.width * scale, height: image.height * scale }
  }

  const newPage = () => {
    page = pdf.addPage([W, H])
    pages.push(page)
    if (logo) {
      const scale = Math.min(132 / logo.width, 40 / logo.height)
      const width = logo.width * scale
      const height = logo.height * scale
      page.drawImage(logo, { x: left, y: 786, width, height })
      if (config.auditTrail.subtitle) page.drawText(safe(config.auditTrail.subtitle), { x: left, y: 772, size: 8.5, font: sans, color: muted })
    } else if (config.auditTrail.subtitle) {
      page.drawText(safe(config.auditTrail.subtitle), { x: left, y: 800, size: 10, font: bold, color: ink })
    }
    const title = 'AUDIT TRAIL'
    page.drawText(title, { x: (W - bold.widthOfTextAtSize(title, 20)) / 2, y: 800, size: 20, font: bold, color: ink })
    y = 740
  }

  // ---------- Document information: bold label | value, ruled rows ----------
  newPage()
  const labelSize = 10
  const valueSize = 10
  const infoLead = 12.5
  const infoValueX = left + 150
  const infoValueWidth = right - infoValueX
  const sender = [c.SenderName, c.SenderEmail ? `(${c.SenderEmail})` : null, c.OrgName].filter(Boolean).join(' - ')
  const metadata = [
    ['Document Name', c.Name],
    ['Document ID / Contract ID', c.Id],
    ['Workflow Name', c.WorkflowName],
    ['Document Hash (SHA-256)', signed?.Sha256],
    ['Status', c.Status],
    ['Sent By', sender],
    ['Signing Order', c.SigningMethod === 'parallel' ? 'Parallel' : c.SigningMethod === 'sequential' ? 'Sequential' : null],
    ['Created Date and Time', fullTimestamp(c.CreatedAt)],
    ['Completed Date and Time', fullTimestamp(c.CompletedAt)],
    ['Original Document Name', original.FileName],
    ['Original Document SHA-256', original.Sha256],
    ['Stamp Details', c.Estamping],
  ].filter(([, value]) => available(value))

  for (const [label, value] of metadata) {
    const labelLines = wrapCell(label, bold, labelSize, 140)
    const lines = wrapCell(value, font, valueSize, infoValueWidth)
    const height = Math.max(labelLines.length, lines.length) * infoLead + 14
    if (y - height < bottom) newPage()
    labelLines.forEach((line, i) => page.drawText(line, { x: left, y: y - 17 - i * infoLead, size: labelSize, font: bold, color: ink }))
    lines.forEach((line, i) => page.drawText(line, { x: infoValueX, y: y - 17 - i * infoLead, size: valueSize, font, color: ink }))
    y -= height
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.6, color: rule })
  }

  // ---------- About the Audit Trail: grey band ----------
  const about = 'This audit trail provides a record of the electronic signing process, including document information, participant identities, verification details and signing timestamps.'
  const aboutLines = wrapCell(about, font, 8.8, infoValueWidth - 10)
  const aboutHeight = Math.max(38, aboutLines.length * 11 + 20)
  if (y - aboutHeight - 60 < bottom) newPage()
  page.drawRectangle({ x: left, y: y - aboutHeight, width: tableWidth, height: aboutHeight, color: band })
  page.drawText('About the Audit Trail', { x: left + 10, y: y - aboutHeight / 2 - 3.5, size: labelSize, font: bold, color: ink })
  aboutLines.forEach((line, i) => page.drawText(line, { x: infoValueX, y: y - 15 - i * 11, size: 8.8, font, color: ink }))
  y -= aboutHeight + 22

  // ---------- Participants: Sr. No. | Name & Contact | Date | Details ----------
  const participants = signers.map((s, index) => ({ ...s, serial: index + 1, role: s.Kind === 'reviewer' ? 'Reviewer' : 'Signer' }))
  if (c.SenderName || c.SenderEmail) {
    const senderParticipant = participants.find((s) => s.Email?.toLowerCase() === c.SenderEmail?.toLowerCase())
    if (senderParticipant) senderParticipant.role += ' / Invitation Sender'
    else participants.push({ serial: participants.length + 1, Name: c.SenderName, Email: c.SenderEmail, Kind: 'sender', role: 'Invitation Sender' })
  }

  const photos = new Map()
  for (const participant of participants) {
    if (!participant.PhotoImage) continue
    try {
      photos.set(participant.serial, await embedImage(pdf, await toGrayscaleBytes(Buffer.from(participant.PhotoImage.split(',')[1] ?? '', 'base64'))))
    } catch {
      console.warn(`[signing] a live photo could not be embedded for contract ${contractId}`)
    }
  }

  // ---- layout constants ----
  const padX = 8
  const padY = 11
  const minRow = 58
  const headerHeight = 28
  const soft = rgb(0.34, 0.34, 0.37) // muted grey-blue for secondary text
  const zebra = rgb(0.965, 0.965, 0.97)
  const col = { sr: { x: left, w: 36 }, name: { x: 0, w: 142 }, date: { x: 0, w: 98 }, details: { x: 0, w: 0 } }
  col.name.x = col.sr.x + col.sr.w
  col.date.x = col.name.x + col.name.w
  col.details.x = col.date.x + col.date.w
  col.details.w = right - col.details.x
  const dividers = [col.name.x, col.date.x, col.details.x]

  const method = (p) => {
    const m = p.SignedMethod ?? p.Method
    return m ? (METHOD_LABELS[m] ?? m) : null
  }
  const sigType = (p) => (p.SignatureType === 'stamp' ? 'Generated' : p.SignatureType === 'type' ? 'Typed' : p.SignatureType === 'draw' ? 'Drawn' : null)
  const status = (p) => (p.Kind === 'sender' ? null : p.DeclinedAt ? (p.Kind === 'reviewer' ? 'Rejected' : 'Declined') : p.Signed ? (p.Kind === 'reviewer' ? 'Approved' : 'Signed') : 'Pending')
  // Monochrome status badges: solid black = completed, outlined = pending, dark grey = declined / rejected.
  const solid = [rgb(0.07, 0.07, 0.07), rgb(1, 1, 1)]
  const statusColors = {
    Signed: solid,
    Approved: solid,
    Pending: [rgb(1, 1, 1), rgb(0.07, 0.07, 0.07)],
    Declined: [rgb(0.38, 0.38, 0.4), rgb(1, 1, 1)],
    Rejected: [rgb(0.38, 0.38, 0.4), rgb(1, 1, 1)],
  }

  // ---- cell items: each has a height and a draw(x, top) ----
  const textItem = (value, fnt, size, color, width, leading, gap = 2) => {
    const lines = wrapCell(value, fnt, size, width)
    return {
      height: lines.length * leading + gap,
      draw: (x, top) => lines.forEach((line, i) => page.drawText(line, { x, y: top - size * 0.92 - i * leading, size, font: fnt, color })),
    }
  }
  const chipItem = (text, bg, fg, maxWidth) => {
    const label = safe(text).toUpperCase()
    const width = bold.widthOfTextAtSize(label, 7) + 12
    if (width > maxWidth) return textItem(text, bold, 7.6, fg, maxWidth, 9.6, 5)
    return {
      height: 14 + 6,
      draw: (x, top) => {
        page.drawRectangle({ x, y: top - 14, width, height: 14, color: bg, borderColor: rgb(0.07, 0.07, 0.07), borderWidth: 0.7 })
        page.drawText(label, { x: x + 6, y: top - 10, size: 7, font: bold, color: fg })
      },
    }
  }
  // Small highlighted tag used for the bold headings inside the table (Invited, Viewed, Signed, Signature...).
  const drawTag = (label, x, top, bg, fg) => {
    const text = safe(label).toUpperCase()
    const width = bold.widthOfTextAtSize(text, 7.2) + 10
    page.drawRectangle({ x, y: top - 12.5, width, height: 12.5, color: bg })
    page.drawText(text, { x: x + 5, y: top - 9, size: 7.2, font: bold, color: fg })
    return width
  }
  const stampColors = {}
  const stampItem = (label, value, width) => {
    const lines = wrapCell(value, font, 8.6, width)
    const [bg, fg] = stampColors[label] ?? [headingBlue, brand]
    return {
      height: 12.5 + 4 + lines.length * 10.8 + 8,
      draw: (x, top) => {
        drawTag(label, x, top, bg, fg)
        lines.forEach((line, i) => page.drawText(line, { x, y: top - 12.5 - 4 - 7.6 - i * 10.8, size: 8.6, font, color: ink }))
      },
    }
  }
  const kvLabelW = 70
  const kvItem = (label, value, width) => {
    const lines = wrapCell(value, font, 8.4, width - kvLabelW)
    const labelLines = wrapCell(label, bold, 7.9, kvLabelW - 6)
    return {
      height: Math.max(lines.length * 10.6, labelLines.length * 9.6) + 4.5,
      draw: (x, top) => {
        labelLines.forEach((line, i) => page.drawText(line, { x, y: top - 7.6 - i * 9.6, size: 7.9, font: bold, color: brand }))
        lines.forEach((line, i) => page.drawText(line, { x: x + kvLabelW, y: top - 7.8 - i * 10.6, size: 8.4, font, color: ink }))
      },
    }
  }
  const imageItem = (label, image, size) => ({
    height: 12.5 + 5 + size.height + 8 + 6,
    draw: (x, top) => {
      drawTag(label, x, top, headingBlue, brand)
      const boxTop = top - 12.5 - 5
      page.drawRectangle({ x, y: boxTop - size.height - 8, width: size.width + 12, height: size.height + 8, color: rgb(1, 1, 1), borderColor: gridColor, borderWidth: 0.6 })
      page.drawImage(image, { x: x + 6, y: boxTop - size.height - 4, width: size.width, height: size.height })
    },
  })
  const stackHeight = (items) => items.reduce((sum, item) => sum + item.height, 0)
  const drawStack = (items, x, top) => {
    let cursor = top
    for (const item of items) {
      item.draw(x, cursor)
      cursor -= item.height
    }
  }

  const records = participants.map((p) => {
    const location = parseJson(p.LocationJson)
    const certificate = parseJson(p.VerificationJson)?.certificate
    const coords = location && available(location.lat) && available(location.lng)
      ? `${location.lat}, ${location.lng}${location.accuracy != null ? ` (accuracy ${location.accuracy} m)` : ''}`
      : null
    const nameW = col.name.w - padX * 2
    const dateW = col.date.w - padX * 2
    const detailsW = col.details.w - padX * 2

    // Name & Contact: name (primary), email / phone (secondary), role chip.
    const nameItems = []
    if (available(p.Name)) nameItems.push(textItem(p.Name, bold, 10, ink, nameW, 12.5, 3))
    if (available(p.Email)) nameItems.push(textItem(p.Email, font, 8.2, soft, nameW, 10.4, 2))
    if (available(p.Phone)) nameItems.push(textItem(p.Phone, font, 8.2, soft, nameW, 10.4, 2))
    if (available(p.role)) nameItems.push({ height: 5, spacer: true, draw: () => {} }, chipItem(p.role, headingBlue, brand, nameW))

    // Date: small caps label over the value.
    const dateItems = [
      ['Invited', fullTimestamp(p.InvitedAt)],
      ['Viewed', fullTimestamp(p.ViewedAt)],
      [p.Kind === 'reviewer' ? 'Approved' : 'Signed', fullTimestamp(p.SignedAt)],
    ].filter(([, v]) => available(v)).map(([l, v]) => stampItem(l, v, dateW))

    // Details: status badge, then a hanging label / value list, then photo and signature in framed boxes.
    const detailItems = []
    const st = status(p)
    if (st) detailItems.push(chipItem(st, ...(statusColors[st] ?? [band, ink]), detailsW))
    ;[
      ['IP Address', p.SignedIp],
      ['Verification', p.Verification],
      ['Method', method(p)],
      ['Sig. Type', sigType(p)],
      ['Browser / OS', auditBrowser(p.SignedUserAgent)],
      ['Device', p.SignedUserAgent],
      ['Comment', p.ReviewComment],
      ['Decline Reason', p.DeclineReason],
      ['Location', coords],
      ['Address', p.LocationAddress],
      ['Cert. Subject', certificate?.subject],
      ['Cert. Issuer', certificate?.issuer],
      ['Cert. Serial', certificate?.serial],
      ['Cert. Valid Until', certificate?.validTo],
    ].filter(([, v]) => available(v)).forEach(([l, v]) => detailItems.push(kvItem(l, v, detailsW)))
    const photo = photos.get(p.serial)
    if (photo) detailItems.push({ height: 4, spacer: true, draw: () => {} }, imageItem('Live Photo', photo, fitImage(photo, 90, 50)))
    const signature = images.get(p.SignerOrder)
    if (signature) detailItems.push({ height: 4, spacer: true, draw: () => {} }, imageItem('Signature', signature, fitImage(signature, Math.min(detailsW - 16, 170), 46)))

    return { p, nameItems, dateItems, detailItems, index: 0 }
  })
  records.forEach((record, i) => { record.index = i })

  const drawHeader = () => {
    page.drawRectangle({ x: left, y: y - headerHeight, width: tableWidth, height: headerHeight, color: headingBlue, borderColor: gridColor, borderWidth: 0.6 })
    dividers.forEach((x) => page.drawLine({ start: { x, y }, end: { x, y: y - headerHeight }, thickness: 0.5, color: gridColor }))
    const baseline = y - 17.5
    const srLabel = 'Sr. No.'
    page.drawText(srLabel, { x: col.sr.x + (col.sr.w - bold.widthOfTextAtSize(srLabel, 8)) / 2, y: baseline, size: 8, font: bold, color: brand })
    page.drawText('Name & Contact', { x: col.name.x + padX, y: baseline, size: 9.5, font: bold, color: brand })
    page.drawText('Date', { x: col.date.x + padX, y: baseline, size: 9.5, font: bold, color: brand })
    page.drawText('Details', { x: col.details.x + padX, y: baseline, size: 9.5, font: bold, color: brand })
    y -= headerHeight
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1.2, color: rgb(0.07, 0.07, 0.07) })
  }
  // Draws one slice of a participant row. A participant that does not fit in the space left on a page
  // continues on the next page (with the header repeated), so pages are filled and no blank gaps are left.
  const drawPart = (record, parts, continued) => {
    const top = y
    const contentHeight = Math.max(stackHeight(parts.name), stackHeight(parts.date), stackHeight(parts.details))
    const height = Math.max(continued ? 40 : minRow, contentHeight + padY * 2)
    const rowBottom = top - height
    if (record.index % 2 === 1) page.drawRectangle({ x: left, y: rowBottom, width: tableWidth, height, color: zebra })
    // Outer border, column dividers and a rule under every row.
    page.drawLine({ start: { x: left, y: rowBottom }, end: { x: right, y: rowBottom }, thickness: 0.5, color: gridColor })
    page.drawLine({ start: { x: left, y: top }, end: { x: left, y: rowBottom }, thickness: 0.6, color: gridColor })
    page.drawLine({ start: { x: right, y: top }, end: { x: right, y: rowBottom }, thickness: 0.6, color: gridColor })
    dividers.forEach((x) => page.drawLine({ start: { x, y: top }, end: { x, y: rowBottom }, thickness: 0.5, color: gridColor }))
    // Serial number badge.
    const cx = col.sr.x + col.sr.w / 2
    page.drawCircle({ x: cx, y: top - padY - 9, size: 9.5, color: headingBlue, borderColor: gridColor, borderWidth: 0.6 })
    const num = String(record.p.serial)
    page.drawText(num, { x: cx - bold.widthOfTextAtSize(num, 8.5) / 2, y: top - padY - 12, size: 8.5, font: bold, color: brand })
    // All columns are top-aligned so every row reads straight across.
    drawStack(parts.name, col.name.x + padX, top - padY)
    drawStack(parts.date, col.date.x + padX, top - padY)
    drawStack(parts.details, col.details.x + padX, top - padY)
    y = rowBottom
  }

  let freshPage = false
  const startNewTablePage = () => {
    newPage()
    drawHeader()
    freshPage = true
  }
  // The table starts straight after the About band whenever a useful part of the first row fits.
  if (y - headerHeight - 130 < bottom) newPage()
  drawHeader()

  for (const record of records) {
    const rest = { name: record.nameItems, date: record.dateItems, details: record.detailItems }
    let continued = false
    const remaining = () => rest.name.length + rest.date.length + rest.details.length
    while (remaining() > 0) {
      const avail = y - bottom - padY * 2
      const fits = (items) => {
        let used = 0
        let n = 0
        while (n < items.length && used + items[n].height <= avail) {
          used += items[n].height
          n += 1
        }
        return n
      }
      let counts = [fits(rest.name), fits(rest.date), fits(rest.details)]
      const all = [rest.name, rest.date, rest.details]
      const everythingFits = counts.every((n, i) => n === all[i].length)
      const nothingFits = counts.every((n, i) => n === 0 || all[i][0]?.spacer)
      // Not worth starting a row in a sliver of space: move to the next page (a small gap at most).
      const sliver = !continued && !everythingFits && avail < 70
      if ((nothingFits || sliver || y - Math.max(continued ? 40 : minRow, padY * 2 + 20) < bottom) && !freshPage) {
        startNewTablePage()
        continue
      }
      if (nothingFits) counts = all.map((items) => Math.min(1, items.length)) // item taller than a page: force it
      const parts = {
        name: rest.name.slice(0, counts[0]),
        date: rest.date.slice(0, counts[1]),
        details: rest.details.slice(0, counts[2]),
      }
      rest.name = rest.name.slice(counts[0])
      rest.date = rest.date.slice(counts[1])
      rest.details = rest.details.slice(counts[2])
      for (const key of ['name', 'date', 'details']) while (rest[key][0]?.spacer) rest[key].shift()
      if (continued && available(record.p.Name)) parts.name.unshift(textItem(`${record.p.Name} (continued)`, bold, 8.6, ink, col.name.w - padX * 2, 10.8, 3))
      drawPart(record, parts, continued)
      freshPage = false
      if (remaining() > 0) continued = true
    }
  }

  pages.forEach((pdfPage, index) => {
    pdfPage.drawLine({ start: { x: left, y: 43 }, end: { x: right, y: 43 }, thickness: 0.55, color: rule })
    const footer = `${config.auditTrail.subtitle || 'Jayam Solutions Ltd'} | Digitally generated Audit Trail | Document ${safe(c.Id)}`
    pdfPage.drawText(footer, { x: left, y: 28, size: 7, font: sans, color: muted, maxWidth: 400 })
    const pageNumber = `Page ${index + 1} of ${pages.length}`
    pdfPage.drawText(pageNumber, { x: right - sans.widthOfTextAtSize(pageNumber, 7), y: 28, size: 7, font: sans, color: muted })
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
