import crypto from 'node:crypto'
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { query, text, transaction, t } from '../db.js'
import { sendOtpEmail } from '../mailer.js'
import { requireAuth } from '../middleware.js'
import { EMAIL_RE, HttpError, badRequest, handle, newId, parseJson, requireString } from '../utils.js'

/*
 * Two-step auth with an emailed one-time code:
 *   POST /signup or /login   -> checks the details, emails a code, returns { challengeId, ... }
 *   POST /verify-otp         -> checks the code; signup creates the account; both return { token, user }
 *   POST /resend-otp         -> sends a fresh code for the same challenge
 */
const router = Router()
const { otp } = config

const USER_SELECT = `
  SELECT u.Id, u.Name, u.Email, u.Role, u.PasswordHash, u.IsActive, o.Id AS OrgId, o.Name AS OrgName
  FROM ${t.Users} u JOIN ${t.Organisations} o ON o.Id = u.OrganisationId`

const toUser = (row) => ({
  id: row.Id,
  name: row.Name,
  email: row.Email,
  role: row.Role,
  organisation: { id: row.OrgId, name: row.OrgName },
})

function readEmail(value) {
  const email = requireString(value, 'Email', { max: 320 }).toLowerCase()
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address')
  return email
}

// s*******a@company.com
function maskEmail(email) {
  const [local, domain] = email.split('@')
  const shown = local.length <= 2 ? local[0] : `${local[0]}${'*'.repeat(Math.min(local.length - 2, 8))}${local.at(-1)}`
  return `${shown}@${domain}`
}

const generateCode = () => String(crypto.randomInt(0, 10 ** otp.length)).padStart(otp.length, '0')
// Only a keyed hash of the code is stored; tying it to the challenge id stops reuse across challenges.
const hashCode = (challengeId, code) => crypto.createHmac('sha256', config.jwt.secret).update(`${challengeId}:${code}`).digest('hex')

function sameHash(a, b) {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const challengeResponse = (id, email) => ({
  challengeId: id,
  email: maskEmail(email),
  expiresInSeconds: otp.expiryMinutes * 60,
  resendInSeconds: otp.resendCooldownSeconds,
})

async function assertNotFlooded(email) {
  const [{ n }] = await query(
    `SELECT COUNT(*) AS n FROM ${t.EmailOtps} WHERE Email = @email AND CreatedAt > DATEADD(MINUTE, -15, SYSUTCDATETIME())`,
    { email },
  )
  if (n >= otp.maxPerWindow) throw new HttpError(429, 'Too many codes requested for this email. Please wait 15 minutes and try again.')
}

// Stores a new challenge and emails its code. Removes the challenge again if the email can't be sent.
async function startChallenge({ email, purpose, userId = null, payload = null, name, ip }) {
  // Housekeeping: codes that expired over 15 minutes ago are useless and outside the rate-limit window
  await query(`DELETE FROM ${t.EmailOtps} WHERE ExpiresAt < DATEADD(MINUTE, -15, SYSUTCDATETIME())`)
  await assertNotFlooded(email)
  const id = newId()
  const code = generateCode()
  await query(
    `INSERT INTO ${t.EmailOtps} (Id, Email, Purpose, UserId, CodeHash, PayloadJson, ExpiresAt, IpAddress)
     VALUES (@id, @email, @purpose, @userId, @hash, @payload, DATEADD(MINUTE, @minutes, SYSUTCDATETIME()), @ip)`,
    {
      id,
      email,
      purpose,
      userId,
      hash: hashCode(id, code),
      payload: text(payload ? JSON.stringify(payload) : null),
      minutes: otp.expiryMinutes,
      ip: (ip || '').slice(0, 64),
    },
  )
  try {
    await sendOtpEmail({ to: email, name, code, purpose })
  } catch {
    // The mailer has already logged the details; drop the challenge whose code never arrived
    await query(`DELETE FROM ${t.EmailOtps} WHERE Id = @id`, { id })
    throw new HttpError(502, "We couldn't send the verification email. Please try again in a moment.")
  }
  return challengeResponse(id, email)
}

function issueSession(row) {
  const token = jwt.sign({ sub: row.Id, org: row.OrgId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn })
  return { token, user: toUser(row) }
}

// POST /api/auth/signup  { name, email, password, organisationName? }  ->  challenge
router.post(
  '/signup',
  handle(async (req, res) => {
    const name = requireString(req.body.name, 'Name')
    const email = readEmail(req.body.email)
    const password = req.body.password
    if (typeof password !== 'string' || password.length < 8) throw badRequest('Password must be at least 8 characters')
    if (password.length > 128) throw badRequest('Password must be at most 128 characters')
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw badRequest('Password must contain letters and numbers')
    const organisationName = (req.body.organisationName?.trim() || `${name}'s Organisation`).slice(0, 200)

    const [existing] = await query(`SELECT 1 AS found FROM ${t.Users} WHERE Email = @email`, { email })
    if (existing) throw new HttpError(409, 'An account with this email already exists. Please sign in instead.')

    // The account is only created after the email is verified
    const passwordHash = await bcrypt.hash(password, 10)
    res.json(await startChallenge({ email, purpose: 'signup', payload: { name, organisationName, passwordHash }, name, ip: req.ip }))
  }),
)

// POST /api/auth/login  { email, password }  ->  challenge
router.post(
  '/login',
  handle(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const password = typeof req.body.password === 'string' ? req.body.password : ''
    const [row] = email ? await query(`${USER_SELECT} WHERE u.Email = @email`, { email }) : []

    // Same message for unknown email and wrong password, so accounts can't be probed
    if (!row || !row.IsActive || !(await bcrypt.compare(password, row.PasswordHash))) {
      throw new HttpError(401, 'Invalid email or password')
    }
    res.json(await startChallenge({ email, purpose: 'login', userId: row.Id, name: row.Name, ip: req.ip }))
  }),
)

// POST /api/auth/verify-otp  { challengeId, code }  ->  { token, user }
router.post(
  '/verify-otp',
  handle(async (req, res) => {
    const challengeId = requireString(req.body.challengeId, 'challengeId', { max: 32 })
    const code = String(req.body.code ?? '').trim()
    if (!new RegExp(`^\\d{${otp.length}}$`).test(code)) throw badRequest(`Enter the ${otp.length}-digit code`)

    const [ch] = await query(
      `SELECT Id, Email, Purpose, UserId, CodeHash, PayloadJson, Attempts,
              CASE WHEN ExpiresAt < SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired
       FROM ${t.EmailOtps} WHERE Id = @challengeId`,
      { challengeId },
    )
    // Verified codes are deleted, so a missing row also means "already used"
    if (!ch) throw new HttpError(400, 'This code is no longer valid. Please start again.')
    if (ch.Expired) throw new HttpError(410, 'This code has expired. Request a new one.')
    if (ch.Attempts >= otp.maxAttempts) throw new HttpError(429, 'Too many incorrect attempts. Request a new code.')

    if (!sameHash(ch.CodeHash, hashCode(ch.Id, code))) {
      await query(`UPDATE ${t.EmailOtps} SET Attempts = Attempts + 1 WHERE Id = @id`, { id: ch.Id })
      const left = otp.maxAttempts - ch.Attempts - 1
      throw new HttpError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.')
    }

    // Verified: delete the code. Only one request can delete the row, so it works exactly once
    // even if two verifications race. This also removes the pending sign-up's password hash.
    const deleted = await query(`DELETE FROM ${t.EmailOtps} OUTPUT deleted.Id WHERE Id = @id`, { id: ch.Id })
    if (!deleted.length) throw new HttpError(400, 'This code has already been used.')

    let userId = ch.UserId
    if (ch.Purpose === 'signup') {
      const pending = parseJson(ch.PayloadJson, null)
      if (!pending) throw new HttpError(400, 'This sign-up request is no longer valid. Please start again.')
      const [taken] = await query(`SELECT 1 AS found FROM ${t.Users} WHERE Email = @email`, { email: ch.Email })
      if (taken) throw new HttpError(409, 'An account with this email already exists. Please sign in instead.')
      userId = newId()
      const orgId = newId()
      await transaction(async (run) => {
        await run(`INSERT INTO ${t.Organisations} (Id, Name) VALUES (@orgId, @orgName)`, { orgId, orgName: pending.organisationName })
        await run(
          `INSERT INTO ${t.Users} (Id, OrganisationId, Name, Email, PasswordHash, Role)
           VALUES (@userId, @orgId, @name, @email, @passwordHash, N'admin')`,
          { userId, orgId, name: pending.name, email: ch.Email, passwordHash: pending.passwordHash },
        )
      })
    }

    const [row] = await query(`${USER_SELECT} WHERE u.Id = @id`, { id: userId })
    if (!row || !row.IsActive) throw new HttpError(401, 'This account is not active.')
    await query(`UPDATE ${t.Users} SET LastLoginAt = SYSUTCDATETIME() WHERE Id = @id`, { id: row.Id })
    res.json(issueSession(row))
  }),
)

// POST /api/auth/resend-otp  { challengeId }  ->  challenge (same id, new code)
router.post(
  '/resend-otp',
  handle(async (req, res) => {
    const challengeId = requireString(req.body.challengeId, 'challengeId', { max: 32 })
    const [ch] = await query(
      `SELECT c.Id, c.Email, c.Purpose, c.ResendCount, c.PayloadJson, u.Name AS UserName,
              DATEDIFF(SECOND, c.LastSentAt, SYSUTCDATETIME()) AS SinceLastSent
       FROM ${t.EmailOtps} c LEFT JOIN ${t.Users} u ON u.Id = c.UserId
       WHERE c.Id = @challengeId`,
      { challengeId },
    )
    if (!ch) throw new HttpError(400, 'This request is no longer valid. Please start again.')
    if (ch.ResendCount >= otp.maxResends) throw new HttpError(429, 'Too many resend requests. Please start again.')
    const wait = otp.resendCooldownSeconds - ch.SinceLastSent
    if (wait > 0) throw new HttpError(429, `Please wait ${wait} seconds before requesting a new code.`)

    const code = generateCode()
    await query(
      `UPDATE ${t.EmailOtps}
       SET CodeHash = @hash, Attempts = 0, ResendCount = ResendCount + 1, LastSentAt = SYSUTCDATETIME(),
           ExpiresAt = DATEADD(MINUTE, @minutes, SYSUTCDATETIME())
       WHERE Id = @id`,
      { hash: hashCode(ch.Id, code), minutes: otp.expiryMinutes, id: ch.Id },
    )
    const name = ch.UserName || parseJson(ch.PayloadJson, {})?.name
    try {
      await sendOtpEmail({ to: ch.Email, name, code, purpose: ch.Purpose })
    } catch {
      throw new HttpError(502, "We couldn't send the verification email. Please try again in a moment.")
    }
    res.json(challengeResponse(ch.Id, ch.Email))
  }),
)

// GET /api/auth/me  ->  { user }
router.get(
  '/me',
  requireAuth,
  handle(async (req, res) => {
    const [row] = await query(`${USER_SELECT} WHERE u.Id = @id`, { id: req.user.id })
    if (!row || !row.IsActive) throw new HttpError(401, 'Account not found')
    res.json({ user: toUser(row) })
  }),
)

export default router
