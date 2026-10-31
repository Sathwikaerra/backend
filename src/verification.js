import crypto from 'node:crypto'
import { config } from './config.js'
import { query, t, text } from './db.js'
import { sendSigningOtp } from './mailer.js'
import { HttpError, badRequest, newId } from './utils.js'

/*
 * Identity checks a signer passes before signing, one flow per signing method:
 *
 *   CLICKWRAP            no check: the signer types their name and accepts
 *   SMART_ESIGN          one-time code emailed to the signer (and "texted" when a phone is known)
 *   AADHAAR_OTP          Aadhaar number + one-time code sent to the Aadhaar-linked mobile
 *   AADHAAR_FINGERPRINT  Aadhaar number + fingerprint from a biometric scanner
 *   AADHAAR_FACE         Aadhaar number + a live photo from the camera
 *   DSC_TOKEN            certificate on a USB token + its PIN
 *
 * The Aadhaar and DSC checks go through `provider`. In sandbox mode (ESIGN_MODE is not "live")
 * it imitates a licensed eSign Service Provider and a token driver: OTPs are printed in the console
 * (and shown on the signing page), any fingerprint or face capture is accepted, and the token holds
 * one test certificate. Nothing is checked against UIDAI. A live provider (an ESP's API and a local
 * token utility) replaces these functions without changing the signing flow.
 */

export const SIGNING_METHODS = ['CLICKWRAP', 'SMART_ESIGN', 'AADHAAR_OTP', 'AADHAAR_FINGERPRINT', 'AADHAAR_FACE', 'DSC_TOKEN']
const AADHAAR_METHODS = ['AADHAAR_OTP', 'AADHAAR_FINGERPRINT', 'AADHAAR_FACE']
export const sandbox = config.esign.mode !== 'live'

const CODE_LENGTH = 6
const CHALLENGE_MINUTES = 10
const VERIFIED_VALID_MINUTES = 30
const MAX_ATTEMPTS = 5
const MAX_PER_WINDOW = 6
const MAX_PHOTO_CHARS = 400_000

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const newCode = () => String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')

// The methods a signer may use; contracts without any fall back to a plain electronic signature
export function allowedMethods(row) {
  const list = String(row.Methods || row.Method || '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => SIGNING_METHODS.includes(m))
  return list.length ? [...new Set(list)] : ['CLICKWRAP']
}

/* ---------- Aadhaar number ---------- */

// Verhoeff checksum, which every Aadhaar number carries in its last digit
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 7, 8, 6, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]
const verhoeffOk = (num) => [...num].reverse().reduce((c, d, i) => D[c][P[i % 8][Number(d)]], 0) === 0

export function cleanAadhaar(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '')
  if (!/^[2-9]\d{11}$/.test(digits) || !verhoeffOk(digits)) throw badRequest('Enter a valid 12-digit Aadhaar number')
  return digits
}
export const maskAadhaar = (a) => `XXXX XXXX ${a.slice(-4)}`
const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => `${a}${'*'.repeat(Math.min(b.length, 6))}${c}`)
const maskPhone = (p) => `${'*'.repeat(Math.max(p.length - 4, 0))}${p.slice(-4)}`

/* ---------- provider (sandbox) ---------- */

const provider = {
  // Asks the ESP to send an OTP to the mobile linked with this Aadhaar. Returns where it went.
  async sendAadhaarOtp(aadhaar, code) {
    if (!sandbox) throw new HttpError(501, 'Aadhaar eSign is not connected to an eSign Service Provider yet')
    console.log(`\n[esign:sandbox] Aadhaar OTP for ${maskAadhaar(aadhaar)}: ${code}  (would be sent by UIDAI to the linked mobile)\n`)
    return { sentTo: `mobile linked to Aadhaar ${maskAadhaar(aadhaar)}` }
  },
  async verifyBiometric(aadhaar, kind, capture) {
    if (!sandbox) throw new HttpError(501, 'Aadhaar biometric eSign is not connected to an eSign Service Provider yet')
    if (kind === 'fingerprint' && !(Number(capture?.quality) >= 40)) throw badRequest('The fingerprint was not clear. Place your finger flat on the scanner and try again')
    return { reference: `SANDBOX-${kind.toUpperCase()}-${crypto.randomBytes(4).toString('hex')}` }
  },
  // Certificates on the connected USB token
  async tokenCertificates(signerName) {
    if (!sandbox) throw new HttpError(501, 'DSC signing needs the token utility, which is not connected yet')
    const validTo = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10)
    return [{ id: 'sandbox-1', subject: signerName, issuer: 'eSign Sandbox CA (Class 3)', serial: crypto.createHash('md5').update(signerName).digest('hex').slice(0, 16), validTo }]
  },
  async signWithToken(certificateId, pin) {
    if (!sandbox) throw new HttpError(501, 'DSC signing needs the token utility, which is not connected yet')
    if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw badRequest('Enter the token PIN (4 to 8 digits)')
    if (certificateId !== 'sandbox-1') throw badRequest('Choose a certificate on the token')
  },
}

/* ---------- challenges ---------- */

async function guardRate(me) {
  const [{ n }] = await query(
    `SELECT COUNT(*) AS n FROM ${t.SigningChallenges}
     WHERE ContractId = @id AND SignerOrder = @order AND CreatedAt > DATEADD(MINUTE, -15, SYSUTCDATETIME())`,
    { id: me.ContractId, order: me.SignerOrder },
  )
  if (n >= MAX_PER_WINDOW) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again.')
}

async function createChallenge(me, method, { code = null, target = null, detail = {} }) {
  const id = newId()
  await query(
    `INSERT INTO ${t.SigningChallenges} (Id, ContractId, SignerOrder, Method, CodeHash, Target, DetailJson, ExpiresAt)
     VALUES (@id, @contractId, @order, @method, @codeHash, @target, @detail, DATEADD(MINUTE, ${CHALLENGE_MINUTES}, SYSUTCDATETIME()))`,
    { id, contractId: me.ContractId, order: me.SignerOrder, method, codeHash: code ? hash(`${id}:${code}`) : null, target, detail: text(JSON.stringify(detail)) },
  )
  return id
}

/*
 * Step 1 of a method's window: { method, aadhaar?, consent? } -> what the page shows next.
 * Returns { challengeId, method, sentTo?, expiresInSeconds, certificates?, testCode? (sandbox only) }.
 */
export async function startVerification(me, body) {
  const method = String(body?.method ?? '')
  if (!allowedMethods(me).includes(method)) throw badRequest('This signing method is not allowed for you')
  if (method === 'CLICKWRAP') throw badRequest('Clickwrap needs no verification')
  await guardRate(me)

  const out = { method, expiresInSeconds: CHALLENGE_MINUTES * 60, sandbox }
  if (method === 'SMART_ESIGN') {
    const code = newCode()
    const targets = [maskEmail(me.Email), ...(me.Phone ? [maskPhone(me.Phone)] : [])]
    out.challengeId = await createChallenge(me, method, { code, target: targets.join(' and '), detail: { email: me.Email } })
    await sendSigningOtp({ to: me.Email, name: me.Name, code, contractName: me.ContractName, minutes: CHALLENGE_MINUTES })
    // SMS is not connected yet: the code is printed for the phone too
    if (me.Phone) console.log(`[sms:dev] Signing code for ${me.Phone}: ${code}  (SMS is not connected; not sent)`)
    out.sentTo = targets.join(' and ')
    return out
  }

  if (AADHAAR_METHODS.includes(method)) {
    if (body?.consent !== true) throw badRequest('Please give consent to use your Aadhaar for eSign')
    const aadhaar = cleanAadhaar(body?.aadhaar)
    const detail = { aadhaar: maskAadhaar(aadhaar), aadhaarHash: hash(aadhaar) }
    if (method === 'AADHAAR_OTP') {
      const code = newCode()
      const { sentTo } = await provider.sendAadhaarOtp(aadhaar, code)
      out.challengeId = await createChallenge(me, method, { code, target: sentTo, detail })
      out.sentTo = sentTo
      if (sandbox) out.testCode = code
    } else {
      out.challengeId = await createChallenge(me, method, { target: maskAadhaar(aadhaar), detail })
    }
    out.aadhaar = detail.aadhaar
    return out
  }

  // DSC_TOKEN
  out.certificates = await provider.tokenCertificates(me.Name)
  out.challengeId = await createChallenge(me, method, { target: 'USB token', detail: {} })
  return out
}

/*
 * Step 2: { challengeId, code? | capture? | certificateId + pin } -> { verified, method, summary }.
 * A verified challenge is then spent by POST /sign within VERIFIED_VALID_MINUTES.
 */
export async function completeVerification(me, body) {
  const [ch] = await query(
    `SELECT Id, Method, CodeHash, Target, DetailJson, Attempts, VerifiedAt,
            CASE WHEN ExpiresAt < SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired
     FROM ${t.SigningChallenges} WHERE Id = @id AND ContractId = @contractId AND SignerOrder = @order`,
    { id: String(body?.challengeId ?? ''), contractId: me.ContractId, order: me.SignerOrder },
  )
  if (!ch) throw badRequest('Start the verification again')
  if (ch.VerifiedAt) throw new HttpError(409, 'Already verified')
  if (ch.Expired) throw new HttpError(410, 'This verification has expired. Start again.')
  if (ch.Attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many incorrect attempts. Start again.')
  const detail = JSON.parse(ch.DetailJson || '{}')
  let summary

  if (ch.CodeHash) {
    const code = String(body?.code ?? '').trim()
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) throw badRequest(`Enter the ${CODE_LENGTH}-digit code`)
    if (hash(`${ch.Id}:${code}`) !== ch.CodeHash) {
      await query(`UPDATE ${t.SigningChallenges} SET Attempts = Attempts + 1 WHERE Id = @id`, { id: ch.Id })
      const left = MAX_ATTEMPTS - ch.Attempts - 1
      throw badRequest(left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'That code is not correct. Start again.')
    }
    summary = ch.Method === 'SMART_ESIGN' ? `One-time code sent to ${ch.Target} verified` : `Aadhaar ${detail.aadhaar} verified with OTP`
  } else if (ch.Method === 'AADHAAR_FINGERPRINT') {
    const { reference } = await provider.verifyBiometric(null, 'fingerprint', body?.capture)
    Object.assign(detail, { reference, quality: Number(body.capture.quality) })
    summary = `Aadhaar ${detail.aadhaar} verified with fingerprint`
  } else if (ch.Method === 'AADHAAR_FACE') {
    const photo = body?.capture?.photo
    if (typeof photo !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) throw badRequest('Take a photo with your camera first')
    if (photo.length > MAX_PHOTO_CHARS) throw badRequest('The photo is too large')
    const { reference } = await provider.verifyBiometric(null, 'face', { photo })
    Object.assign(detail, { reference, photo })
    summary = `Aadhaar ${detail.aadhaar} verified with face authentication`
  } else if (ch.Method === 'DSC_TOKEN') {
    await provider.signWithToken(body?.certificateId, body?.pin)
    const [cert] = await provider.tokenCertificates(me.Name)
    Object.assign(detail, { certificate: { subject: cert.subject, issuer: cert.issuer, serial: cert.serial, validTo: cert.validTo } })
    summary = `Signed with DSC "${cert.subject}" issued by ${cert.issuer} (serial ${cert.serial})`
  } else {
    throw badRequest('Start the verification again')
  }

  if (sandbox && ch.Method !== 'SMART_ESIGN') summary += ' [sandbox]'
  await query(`UPDATE ${t.SigningChallenges} SET VerifiedAt = SYSUTCDATETIME(), DetailJson = @detail WHERE Id = @id`, {
    id: ch.Id,
    detail: text(JSON.stringify({ ...detail, summary })),
  })
  return { verified: true, method: ch.Method, summary, aadhaar: detail.aadhaar ?? null, certificate: detail.certificate ?? null }
}

/*
 * Signers see the document only after their identity check (Clickwrap signers read it first and
 * accept at the end). True when this signer may open the PDF with this verified, unspent check.
 */
export async function mayViewDocument(me, challengeId) {
  if (me.Kind === 'reviewer' || me.Signed || me.DeclinedAt || me.Status !== 'incomplete') return true
  if (allowedMethods(me).includes('CLICKWRAP')) return true
  if (!challengeId) return false
  const [ch] = await query(
    `SELECT Id FROM ${t.SigningChallenges}
     WHERE Id = @id AND ContractId = @contractId AND SignerOrder = @order
       AND VerifiedAt IS NOT NULL AND UsedAt IS NULL AND VerifiedAt > DATEADD(MINUTE, -${VERIFIED_VALID_MINUTES}, SYSUTCDATETIME())`,
    { id: String(challengeId), contractId: me.ContractId, order: me.SignerOrder },
  )
  return !!ch
}

/*
 * Called inside the signing transaction: checks the method and spends its verification.
 * Returns { method, summary, evidence } for the signer row and the audit trail.
 */
export async function useVerification(run, me, { method, challengeId, acceptedName }) {
  const allowed = allowedMethods(me)
  const chosen = method || (allowed.length === 1 ? allowed[0] : null)
  if (!chosen || !allowed.includes(chosen)) throw badRequest('Choose one of your signing methods')

  if (chosen === 'CLICKWRAP') {
    const name = typeof acceptedName === 'string' ? acceptedName.trim().slice(0, 200) : ''
    if (!name) throw badRequest('Type your full name to accept')
    return { method: chosen, summary: `Accepted by clicking "I agree" (typed name: ${name})`, evidence: { acceptedName: name } }
  }

  const [ch] = await run(
    `UPDATE ${t.SigningChallenges} SET UsedAt = SYSUTCDATETIME()
     OUTPUT inserted.DetailJson
     WHERE Id = @id AND ContractId = @contractId AND SignerOrder = @order AND Method = @method
       AND VerifiedAt IS NOT NULL AND UsedAt IS NULL AND VerifiedAt > DATEADD(MINUTE, -${VERIFIED_VALID_MINUTES}, SYSUTCDATETIME())`,
    { id: String(challengeId ?? ''), contractId: me.ContractId, order: me.SignerOrder, method: chosen },
  )
  if (!ch) throw badRequest('Verify your identity before signing (or verify again if it has been more than 30 minutes)')
  const { summary, ...evidence } = JSON.parse(ch.DetailJson || '{}')
  delete evidence.aadhaarHash
  return { method: chosen, summary, evidence }
}
