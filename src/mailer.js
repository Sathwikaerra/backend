import nodemailer from 'nodemailer'
import { config } from './config.js'

const { mail, otp } = config

// Without SMTP settings (local development) codes are printed to the console instead of emailed.
const transport = mail.host
  ? nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    })
  : null

if (!transport) {
  console.warn('[mail] SMTP_HOST is not set: OTP codes will be printed in this console instead of emailed.')
}

// Checks the SMTP login so a wrong host/password shows up at startup, not on the first sign-in.
export async function verifyMailer() {
  if (!transport) return { ok: false, reason: 'SMTP_HOST is not set' }
  try {
    await transport.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

export async function sendTestEmail(to) {
  if (!transport) throw new Error('SMTP_HOST is not set in backend/.env')
  await deliver('test', to, {
    subject: 'eSign Doc Builder: test email',
    text: 'Your SMTP settings work. Verification codes will now be emailed to users.',
  })
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function otpEmail({ name, code, purpose }) {
  const action = purpose === 'signup' ? 'finish creating your account' : 'sign in'
  const subject = purpose === 'signup' ? `${code} is your verification code` : `${code} is your sign-in code`
  const text = `Hi ${name || 'there'},

Use this code to ${action} on eSign Doc Builder:

    ${code}

The code expires in ${otp.expiryMinutes} minutes. If you didn't request it, you can ignore this email; your account is safe.`

  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
          <p style="margin:0 0 20px">Use this code to ${action}:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:10px;text-align:center;background:#f4f3fb;border-radius:10px;padding:16px 0;color:#1a1630">${code}</div>
          <p style="margin:20px 0 0;color:#6d6887;font-size:13px">This code expires in ${otp.expiryMinutes} minutes. Never share it with anyone.
          If you didn't request it, you can safely ignore this email.</p>`,
  })
  return { subject, text, html }
}

// Shared email frame: brand line, body HTML, optional button, footer
function layout({ body, button, footer = 'This is an automated message, please do not reply.' }) {
  const cta = button
    ? `<tr><td style="padding:22px 32px 0" align="center">
         <a href="${escapeHtml(button.href)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:10px">${escapeHtml(button.label)}</a>
         <p style="margin:14px 0 0;color:#9a96ad;font-size:12px;word-break:break-all">Or open this link: ${escapeHtml(button.href)}</p>
       </td></tr>`
    : ''
  return `<!doctype html>
<html><body style="margin:0;background:#f4f5fb;font-family:Segoe UI,Arial,sans-serif;color:#1a1630">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;border:1px solid #e7e4f0">
        <tr><td style="padding:28px 32px 8px;font-weight:700;color:#4f46e5;font-size:16px">eSign Doc Builder</td></tr>
        <tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6">${body}</td></tr>
        ${cta}
        <tr><td style="padding:24px 32px 28px;color:#9a96ad;font-size:12px">${escapeHtml(footer)}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

const formatDate = (d) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

const stamp = () => new Date().toLocaleString('en-GB', { hour12: false })

// Plain-language hints for the SMTP failures people usually hit
function hintFor(err) {
  if (err.responseCode === 534) return 'Gmail refused the sign-in: SMTP_USER must be the exact Gmail address the app password was created for, and SMTP_PASSWORD must be that app password.'
  if (err.code === 'EAUTH' || err.responseCode === 535) return 'Login rejected: check SMTP_USER / SMTP_PASSWORD (Gmail and Yahoo need an app password).'
  if (['ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND'].includes(err.code)) return 'Cannot reach the mail server: check SMTP_HOST / SMTP_PORT and SMTP_SECURE (465 = true, 587 = false).'
  if (err.code === 'ETIMEDOUT') return 'The mail server did not answer in time: a firewall may be blocking the SMTP port.'
  if (err.code === 'EENVELOPE') return 'The recipient or sender address was refused by the mail server.'
  if (err.responseCode === 550 || err.responseCode === 553) return 'The mail server refused this address: MAIL_FROM may need to match SMTP_USER.'
  return null
}

function logFailure(kind, to, err, ms) {
  console.error(`[mail] ${stamp()}  FAILED  ${kind} email to ${to} via ${mail.host}:${mail.port} after ${ms} ms`)
  console.error(`[mail]   error:    ${err.message}`)
  if (err.code || err.responseCode) console.error(`[mail]   code:     ${[err.code, err.responseCode].filter(Boolean).join(' / ')}`)
  if (err.response) console.error(`[mail]   server:   ${String(err.response).trim()}`)
  const hint = hintFor(err)
  if (hint) console.error(`[mail]   hint:     ${hint}`)
}

// Sends one message and logs the outcome either way. Rethrows on failure so the caller can respond.
async function deliver(kind, to, message) {
  const started = Date.now()
  try {
    const info = await transport.sendMail({ from: mail.from, to, ...message })
    const ms = Date.now() - started
    if (info.rejected?.length) {
      const err = new Error(`Recipient rejected: ${info.rejected.join(', ')}`)
      err.response = info.response
      logFailure(kind, to, err, ms)
      throw err
    }
    console.log(`[mail] ${stamp()}  SENT    ${kind} email to ${to} via ${mail.host} in ${ms} ms (id ${info.messageId})`)
    return info
  } catch (err) {
    if (!err.message.startsWith('Recipient rejected')) logFailure(kind, to, err, Date.now() - started)
    throw err
  }
}

export async function sendOtpEmail({ to, name, code, purpose }) {
  const message = otpEmail({ name, code, purpose })
  if (!transport) {
    console.log(`\n[mail:dev] ${purpose.toUpperCase()} code for ${to}: ${code}  (expires in ${otp.expiryMinutes} min)`)
    console.log(`[mail:dev] ${stamp()}  NOT SENT  no SMTP configured; the code above was not emailed to ${to}\n`)
    return
  }
  await deliver(`${purpose} code`, to, message)
}

// Sends through SMTP, or prints a summary in the console when no SMTP server is configured.
// Resolves true when the email was handed to the mail server, false when it was only printed.
async function send(kind, to, message, devLines) {
  if (!transport) {
    console.log(`\n[mail:dev] ${kind.toUpperCase()} for ${to}`)
    for (const line of devLines) console.log(`[mail:dev]   ${line}`)
    console.log(`[mail:dev] ${stamp()}  NOT SENT  no SMTP configured; this email was not delivered to ${to}\n`)
    return false
  }
  await deliver(kind, to, message)
  return true
}

// Invitation with the signer's private link
export async function sendSigningInvite({ to, name, contractName, orgName, senderName, link, expiresAt, subject }) {
  const from = senderName ? `${senderName} (${orgName})` : orgName
  const text = `Hi ${name},

${from} has sent you "${contractName}" to review and sign electronically.

Open the document: ${link}

This link is personal to you; please don't forward it. Please sign before ${formatDate(expiresAt)}.`
  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
          <p style="margin:0 0 16px"><b>${escapeHtml(from)}</b> has sent you a document to review and sign electronically.</p>
          <div style="background:#f4f3fb;border-radius:10px;padding:14px 16px">
            <div style="font-size:12px;color:#6d6887;text-transform:uppercase;letter-spacing:.05em">Document</div>
            <div style="font-weight:700;font-size:16px">${escapeHtml(contractName)}</div>
            <div style="font-size:13px;color:#6d6887;margin-top:4px">Please sign before ${escapeHtml(formatDate(expiresAt))}</div>
          </div>`,
    button: { label: 'Review & sign', href: link },
    footer: 'This link is personal to you. Please do not forward this email.',
  })
  return send('signing invite', to, { subject: subject || `Please sign: ${contractName}`, text, html }, [`document: ${contractName}`, `signing link: ${link}`])
}

// Everyone signed: the signed PDF goes out as an attachment
export async function sendSigningCompleted({ to, name, contractName, fileName, pdf, link }) {
  const text = `Hi ${name || 'there'},

"${contractName}" has been signed by all parties. The signed copy is attached.${link ? `\n\nYou can also download it here: ${link}` : ''}`
  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
          <p style="margin:0 0 12px"><b>${escapeHtml(contractName)}</b> has been signed by all parties.</p>
          <p style="margin:0;color:#6d6887;font-size:13px">The signed PDF, with its certificate of completion, is attached to this email.</p>`,
    button: link ? { label: 'View signed document', href: link } : null,
  })
  const attachments = [{ filename: fileName, content: pdf, contentType: 'application/pdf' }]
  await send('signed copy', to, { subject: `Completed: ${contractName}`, text, html, attachments }, [
    `document: ${contractName} (signed PDF attached, ${Math.round(pdf.length / 1024)} KB)`,
    ...(link ? [`link: ${link}`] : []),
  ])
}

// Tells the sender that a signer declined
export async function sendSigningDeclined({ to, name, contractName, signerName, reason }) {
  const text = `Hi ${name || 'there'},

${signerName} declined to sign "${contractName}".${reason ? `\n\nReason: ${reason}` : ''}

The contract has been stopped; no one else will be asked to sign it.`
  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
          <p style="margin:0 0 12px"><b>${escapeHtml(signerName)}</b> declined to sign <b>${escapeHtml(contractName)}</b>.</p>
          ${reason ? `<div style="background:#fff4f2;border-radius:10px;padding:12px 16px;color:#7a2e1f;font-size:14px">“${escapeHtml(reason)}”</div>` : ''}
          <p style="margin:12px 0 0;color:#6d6887;font-size:13px">The contract has been stopped; no one else will be asked to sign it.</p>`,
  })
  await send('declined notice', to, { subject: `Declined: ${contractName}`, text, html }, [`${signerName} declined "${contractName}"${reason ? `: ${reason}` : ''}`])
}
