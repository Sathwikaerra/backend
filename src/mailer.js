import nodemailer from 'nodemailer'
import { fileURLToPath } from 'node:url'
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

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const signingLogoPath = fileURLToPath(new URL('./assets/jayam.png', import.meta.url))
const signingLogoCid = 'esign-doc-builder-jayam-logo'

function signingEmailHeader() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="text-align:center">
        <img src="cid:${signingLogoCid}" alt="Jayam Solutions Private Limited logo" width="140" style="display:block;width:140px;max-width:100%;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none">
      </td>
    </tr>
    <tr>
      <td align="center" style="padding-top:12px;font-family:Arial,Helvetica,sans-serif;text-align:center">
        <div style="font-size:19px;line-height:1.3;font-weight:700;color:#1e3a5f">eSign <span style="color:#2563eb">Doc Builder</span></div>
        <div style="margin-top:4px;font-size:12px;line-height:1.4;color:#64748b">Secure electronic signing</div>
      </td>
    </tr>
  </table>`
}

function signingLogoAttachment() {
  return { filename: 'jayam.png', path: signingLogoPath, cid: signingLogoCid, contentType: 'image/png' }
}

export function buildOtpEmail({ name, code, purpose, expiryMinutes = otp.expiryMinutes, contractName }) {
  const recipientName = String(name ?? '').trim() || 'there'
  const signing = purpose === 'signing'
  const action = purpose === 'signup' ? 'finish creating your account' : signing ? 'confirm your identity and sign' : 'sign in'
  const subject = purpose === 'signup'
    ? `${code} is your verification code`
    : signing
      ? `${code} is your signing code`
      : `${code} is your sign-in code`
  const codeInstruction = signing && contractName
    ? `Use this code to sign "${contractName}" on eSign Doc Builder:`
    : `Use this code to ${action} on eSign Doc Builder:`
  const text = `Hi ${recipientName},

${codeInstruction}

    ${code}

The code expires in ${expiryMinutes} minutes. Never share it with anyone.${signing ? '' : " If you didn't request it, you can ignore this email; your account is safe."}`
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;color:#1e293b;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f1f5f9">
      <tr>
        <td align="center" style="padding:24px 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px">
            <tr>
              <td style="padding:22px 24px;border-bottom:1px solid #e2e8f0">
                ${signingEmailHeader()}
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 8px">
                <h1 style="margin:0;color:#1e3a5f;font-size:24px;line-height:1.3;font-weight:700">${signing ? 'Confirm your identity' : 'Verify your email'}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 24px 0;color:#334155;font-size:15px;line-height:1.65">
                <p style="margin:0 0 10px">Hi ${escapeHtml(recipientName)},</p>
                <p style="margin:0">${escapeHtml(codeInstruction)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
                  <tr>
                    <td align="center" style="padding:20px 16px">
                      <div style="margin:0 0 8px;color:#1e3a5f;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:1px;text-transform:uppercase">Your verification code</div>
                      <div style="color:#1e3a5f;font-family:Consolas,'Courier New',monospace;font-size:32px;line-height:1.3;font-weight:700;letter-spacing:8px;word-break:break-all">${escapeHtml(code)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px 0;color:#475569;font-size:14px;line-height:1.6">
                This code expires in <strong style="color:#1e3a5f">${escapeHtml(expiryMinutes)} minutes</strong>. Never share it with anyone.
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px 24px;color:#64748b;font-size:12px;line-height:1.6">
                ${signing
                  ? 'If you did not request this signing code, you can ignore this email.'
                  : "If you didn't request this code, you can safely ignore this email."}
                <br>This is an automated message from eSign Doc Builder. Please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
  return { subject, text, html, attachments: [signingLogoAttachment()] }
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

function formatInvitationDeadline(value) {
  if (!value) return 'No deadline specified'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'No deadline specified' : formatDate(date)
}

export function buildSigningInviteEmail({
  name,
  contractId,
  contractName,
  orgName,
  senderName,
  link,
  expiresAt,
  subject,
  review = false,
  howToSign = '',
}) {
  const recipientName = String(name ?? '').trim() || 'there'
  const documentName = String(contractName ?? '').trim() || 'Untitled document'
  const sender = String(senderName ?? '').trim()
  const company = String(orgName ?? '').trim()
  const senderDisplay = sender ? `${sender}${company ? ` (${company})` : ''}` : company || 'Your organization'
  const signingUrl = String(link ?? '').trim()
  if (!signingUrl) throw new Error('A signing URL is required for an invitation')

  const deadline = formatInvitationDeadline(expiresAt)
  const method = String(howToSign ?? '').trim().replace(/^How you will sign:\s*/i, '')
  const methodDetails = review ? '' : method || 'Follow the on-screen instructions to complete signing.'
  const task = review ? 'review and approve before it is sent for signing' : 'review and sign electronically'
  const action = review ? 'Review document' : 'Review & Sign'
  const contractIdValue = String(contractId ?? '').trim()
  const subjectLine = (!review && subject) || `${review ? 'Please review' : 'Please sign'}: ${documentName}`
  const detailRow = (label, value, extra = '') => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;vertical-align:top;width:112px">${label}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:14px;line-height:1.5;vertical-align:top;word-break:break-word;${extra}">${value}</td>
    </tr>`
  const contractRow = contractIdValue
    ? detailRow('Contract ID', escapeHtml(contractIdValue), 'font-family:Consolas,monospace;font-size:12px')
    : ''
  const methodRow = methodDetails ? detailRow('Signing method', escapeHtml(methodDetails)) : ''
  const text = `Hi ${recipientName},

${senderDisplay} has sent you "${documentName}" to ${task}.

Document: ${documentName}
${contractIdValue ? `Contract ID: ${contractIdValue}\n` : ''}Signing deadline: ${deadline}
${methodDetails ? `Signing method: ${methodDetails}\n` : ''}
${review ? 'Review the document' : 'Review and sign'}: ${signingUrl}

This link is personal to you. Please do not forward it. If you were not expecting this document, contact the sender before opening the link.`
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subjectLine)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;color:#1e293b;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f1f5f9">
      <tr>
        <td align="center" style="padding:24px 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px">
            <tr>
              <td style="padding:22px 24px;border-bottom:1px solid #e2e8f0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr><td>${signingEmailHeader()}</td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 8px">
                <h1 style="margin:0;color:#1e3a5f;font-size:24px;line-height:1.3;font-weight:700">${review ? 'A document is ready for your review' : 'A document is ready for your signature'}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 24px 0;font-size:15px;line-height:1.65;color:#334155">
                <p style="margin:0 0 10px">Hi ${escapeHtml(recipientName)},</p>
                <p style="margin:0"><strong style="color:#1e293b">${escapeHtml(senderDisplay)}</strong> has sent you a document to ${task}.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
                  <tr>
                    <td colspan="2" style="padding:13px 12px 8px;color:#1e3a5f;font-size:14px;font-weight:700">Document details</td>
                  </tr>
                  ${detailRow('Document', `<strong>${escapeHtml(documentName)}</strong>`)}
                  ${detailRow('Sender', escapeHtml(senderDisplay))}
                  ${detailRow('Deadline', escapeHtml(deadline))}
                  ${methodRow}
                  ${contractRow}
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 24px 0">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#2563eb" style="background-color:#2563eb;border-radius:6px">
                      <a href="${escapeHtml(signingUrl)}" style="display:inline-block;padding:14px 28px;border:1px solid #2563eb;border-radius:6px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.2;font-weight:700;text-decoration:none">${action}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px 0;text-align:center;color:#64748b;font-size:12px;line-height:1.6">
                Button not working? Copy and paste this secure link into your browser:
                <br><a href="${escapeHtml(signingUrl)}" style="color:#2563eb;text-decoration:underline;word-break:break-all">${escapeHtml(signingUrl)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px 0">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#eff6ff;border-left:3px solid #2563eb">
                  <tr>
                    <td style="padding:12px 14px;color:#334155;font-size:13px;line-height:1.6">
                      <strong style="color:#1e3a5f">Security notice</strong><br>
                      This link is personal and confidential. Do not forward it. If you were not expecting this document, contact the sender before opening the link.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px 24px;color:#64748b;font-size:12px;line-height:1.6">
                This is an automated message from eSign Doc Builder${company ? ` on behalf of ${escapeHtml(company)}` : ''}. Please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
  return {
    subject: subjectLine,
    text,
    html,
    attachments: [signingLogoAttachment()],
  }
}

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

function logFailure(kind, err, ms) {
  console.error(`[mail] ${stamp()}  FAILED  ${kind} email via ${mail.host}:${mail.port} after ${ms} ms`)
  if (err.code || err.responseCode) console.error(`[mail]   code:     ${[err.code, err.responseCode].filter(Boolean).join(' / ')}`)
  const hint = hintFor(err)
  if (hint) console.error(`[mail]   hint:     ${hint}`)
}

// Sends one message and logs the outcome either way. Rethrows on failure so the caller can respond.
async function deliver(kind, to, message) {
  console.log("deliverdeliverdeliverdeliverdeliver")
  const started = Date.now()
  try {
    const info = await transport.sendMail({ from: mail.from, to, ...message })
    const ms = Date.now() - started
    if (info.rejected?.length) {
      const err = new Error('Recipient rejected by the mail server')
      err.response = info.response
      logFailure(kind, err, ms)
      throw err
    }
    console.log(`[mail] ${stamp()}  SENT    ${kind} email via ${mail.host} in ${ms} ms (id ${info.messageId})`)
    return info
  } catch (err) {
    if (err.message !== 'Recipient rejected by the mail server') logFailure(kind, err, Date.now() - started)
    throw err
  }
}

export async function sendOtpEmail({ to, name, code, purpose }) {
  console.log(`[mail] ${stamp()}  SENDING ${purpose} OTP email to ${to}`)
  const message = buildOtpEmail({ name, code, purpose })
  console.log("Message",message)
  if (!transport) {
    console.log(`\n[mail:dev] ${purpose.toUpperCase()} code for ${to}: ${code}  (expires in ${otp.expiryMinutes} min)`)
    console.log(`[mail:dev] ${stamp()}  NOT SENT  no SMTP configured; the code above was not emailed to ${to}\n`)
    return
  }
  await deliver(`${purpose} code`, to, message)
}

// One-time code a signer enters before signing (Smart eSign)
export async function sendSigningOtp({ to, name, code, contractName, minutes }) {
  console.log(`[mail] ${stamp()}  SENDING signing code to ${to}`)
  const message = buildOtpEmail({ name, code, purpose: 'signing', contractName, expiryMinutes: minutes })
  if (!transport) {
    console.log(`\n[mail:dev] SIGNING code for ${to}: ${code}  (expires in ${minutes} min)`)
    console.log(`[mail:dev] ${stamp()}  NOT SENT  no SMTP configured; the code above was not emailed to ${to}\n`)
    return
  }
  await deliver('signing code', to, message)
}

// Sends through SMTP, or prints a summary in the console when no SMTP server is configured.
// Resolves true when the email was handed to the mail server, false when it was only printed.
async function send(kind, to, message, devLines) {
  if (!transport) {
    console.log(`\n[mail:dev] ${kind.toUpperCase()}`)
    for (const line of devLines) console.log(`[mail:dev]   ${line}`)
    console.log(`[mail:dev] ${stamp()}  NOT SENT  no SMTP configured; this email was not delivered\n`)
    return false
  }
  await deliver(kind, to, message)
  return true
}

// Invitation with the signer's (or reviewer's) private link
export async function sendSigningInvite({ to, name, contractId, contractName, orgName, senderName, link, expiresAt, subject, review = false, howToSign = '' }) {
  const message = buildSigningInviteEmail({ name, contractId, contractName, orgName, senderName, link, expiresAt, subject, review, howToSign })
  return send(review ? 'review invite' : 'signing invite', to, message, [
    `document: ${String(contractName ?? '').trim() || 'Untitled document'}`,
    `${review ? 'review' : 'signing'} link: ${String(link ?? '').trim()}`,
  ])
}

// Everyone signed: this message carries only the signed document PDF.
export async function sendSigningCompleted({ to, name, contractName, fileName, pdf, link }) {
  const text = `Hi ${name || 'there'},

"${contractName}" signing is complete. The signed document is attached.${link ? `\n\nYou can also download it here: ${link}` : ''}`
  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
          <p style="margin:0 0 12px">Signing of <b>${escapeHtml(contractName)}</b> is complete.</p>
          <p style="margin:0;color:#6d6887;font-size:13px">The final signed document PDF is attached.</p>`,
    button: link ? { label: 'View signed document', href: link } : null,
  })
  const attachments = [{ filename: fileName, content: pdf, contentType: 'application/pdf' }]
  return send('signed document', to, { subject: `Signing completed: ${contractName}`, text, html, attachments }, [
    `document: ${contractName} (signed PDF attached, ${Math.round(pdf.length / 1024)} KB)`,
    ...(link ? [`link: ${link}`] : []),
  ])
}

// Sends only the standalone Audit Trail / Certificate of Completion PDF.
export async function sendAuditTrailEmail({ to, name, contractName, fileName, pdf }) {
  const text = `Hi ${name || 'there'},

Signing of "${contractName}" is complete. The attached file is the Audit Trail / Certificate of Completion for this document.`
  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
          <p style="margin:0 0 12px">The Audit Trail / Certificate of Completion for <b>${escapeHtml(contractName)}</b> is attached.</p>
          <p style="margin:0;color:#6d6887;font-size:13px">This is a separate PDF containing the completion certificate and available signing and audit information.</p>`,
  })
  const attachments = [{ filename: fileName, content: pdf, contentType: 'application/pdf' }]
  return send('audit trail', to, {
    subject: `Audit Trail / Certificate of Completion: ${contractName}`,
    text,
    html,
    attachments,
  }, [`document: ${contractName} (Audit Trail / Certificate of Completion PDF attached, ${Math.round(pdf.length / 1024)} KB)`])
}

// Tells the sender that a signer declined, or a reviewer rejected the document
export async function sendSigningDeclined({ to, name, contractName, signerName, reason, review = false }) {
  const what = review ? 'rejected' : 'declined to sign'
  const text = `Hi ${name || 'there'},

${signerName} ${what} "${contractName}".${reason ? `\n\nReason: ${reason}` : ''}

The contract has been stopped; no one else will be asked to sign it.`
  const html = layout({
    body: `<p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
          <p style="margin:0 0 12px"><b>${escapeHtml(signerName)}</b> ${what} <b>${escapeHtml(contractName)}</b>.</p>
          ${reason ? `<div style="background:#fff4f2;border-radius:10px;padding:12px 16px;color:#7a2e1f;font-size:14px">“${escapeHtml(reason)}”</div>` : ''}
          <p style="margin:12px 0 0;color:#6d6887;font-size:13px">The contract has been stopped; no one else will be asked to sign it.</p>`,
  })
  await send('declined notice', to, { subject: `${review ? 'Rejected' : 'Declined'}: ${contractName}`, text, html }, [
    `${signerName} ${what} "${contractName}"${reason ? `: ${reason}` : ''}`,
  ])
}
