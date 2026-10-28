import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { query, t } from './db.js'
import { HttpError } from './utils.js'

// Requires "Authorization: Bearer <token>" and exposes req.user = { id, organisationId }.
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return next(new HttpError(401, 'Please sign in'))
  try {
    const payload = jwt.verify(token, config.jwt.secret)
    req.user = { id: payload.sub, organisationId: payload.org }
    next()
  } catch {
    next(new HttpError(401, 'Your session has expired. Please sign in again.'))
  }
}

/*
 * Public API (/api/v1): "X-API-Key: esk_..." (also accepted: "X-Auth-Token", or "Authorization: Bearer esk_...").
 * Exposes req.user = { id: the key's creator, organisationId, apiKeyId }.
 */
export async function requireApiKey(req, _res, next) {
  try {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
    const key = req.get('x-api-key') || req.get('x-auth-token') || (bearer.startsWith('esk_') ? bearer : '')
    if (!key) throw new HttpError(401, 'Send your API key in the X-API-Key header')
    const [row] = await query(`SELECT Id, OrganisationId, CreatedBy FROM ${t.ApiKeys} WHERE KeyHash = @hash AND RevokedAt IS NULL`, {
      hash: crypto.createHash('sha256').update(key).digest('hex'),
    })
    if (!row) throw new HttpError(401, 'This API key is not valid or has been revoked')
    // At most one write a minute per key
    await query(
      `UPDATE ${t.ApiKeys} SET LastUsedAt = SYSUTCDATETIME() WHERE Id = @id AND (LastUsedAt IS NULL OR LastUsedAt < DATEADD(MINUTE, -1, SYSUTCDATETIME()))`,
      { id: row.Id },
    )
    req.user = { id: row.CreatedBy, organisationId: row.OrganisationId, apiKeyId: row.Id }
    next()
  } catch (err) {
    next(err)
  }
}

export function notFoundRoute(req, _res, next) {
  next(new HttpError(404, `No route for ${req.method} ${req.originalUrl}`))
}

// Turns any error into a JSON { error } response with a sensible status code.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.contractId ? { contractId: err.contractId } : {}) })
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The upload is too large' })
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' })

  // Database unreachable / login failed
  if (['ESOCKET', 'ELOGIN', 'ETIMEOUT', 'EINSTLOOKUP'].includes(err?.code)) {
    console.error('[db]', err.message)
    return res.status(503).json({ error: 'Database is unavailable. Check the SQL Server settings in backend/.env.' })
  }

  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server' })
}
