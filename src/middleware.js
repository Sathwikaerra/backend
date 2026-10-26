import jwt from 'jsonwebtoken'
import { config } from './config.js'
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

export function notFoundRoute(req, _res, next) {
  next(new HttpError(404, `No route for ${req.method} ${req.originalUrl}`))
}

// Turns any error into a JSON { error } response with a sensible status code.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
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
