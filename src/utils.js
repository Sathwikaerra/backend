import crypto from 'node:crypto'

// 24-char hex ids, the same format the frontend already displays.
export const newId = () => crypto.randomBytes(12).toString('hex')

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const badRequest = (message) => new HttpError(400, message)
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`)

// Wraps an async route handler so thrown errors reach the error middleware.
export const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function parseJson(value, fallback) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function requireString(value, field, { max = 200, min = 1 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min) throw badRequest(`${field} is required`)
  if (value.trim().length > max) throw badRequest(`${field} must be at most ${max} characters`)
  return value.trim()
}

export function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw badRequest(`${field} is required`)
  }
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`)
  return value
}

// Same rules as the frontend's computeExpiry, so expiry dates match what the UI showed.
export function computeExpiry(value, unit, from = new Date()) {
  const n = Number(value) || 0
  const d = new Date(from)
  if (unit === 'hours') d.setHours(d.getHours() + n)
  else if (unit === 'eod') {
    d.setDate(d.getDate() + n)
    d.setHours(23, 59, 0, 0)
  } else if (unit === 'weeks') d.setDate(d.getDate() + n * 7)
  else if (unit === 'months') d.setMonth(d.getMonth() + n)
  else d.setDate(d.getDate() + n)
  return d
}
