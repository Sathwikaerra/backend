import { Router } from 'express'
import { config } from '../config.js'
import { HttpError, badRequest, handle } from '../utils.js'

/*
 * POST /api/translate  { texts: string[], target: 'hi', source?: 'en' }  ->  { translations: string[], provider }
 * The template editor sends the document's text pieces (formatting stays in the browser).
 * Uses the Google Cloud Translation API when GOOGLE_TRANSLATE_API_KEY is set, otherwise
 * Google's free public endpoint, which is rate-limited and meant for development.
 */
const router = Router()

export const LANGUAGES = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi',
  bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', or: 'Odia', ur: 'Urdu', as: 'Assamese',
  fr: 'French', es: 'Spanish', de: 'German', ar: 'Arabic', 'zh-CN': 'Chinese (Simplified)', ja: 'Japanese',
}
const MAX_TEXTS = 2000
const MAX_CHARS = 100_000
// The free endpoint is sensitive to bursts: few large requests, two at a time
const FREE_CHUNK_CHARS = 4500
const FREE_CONCURRENCY = 2

// Official API: up to 128 strings per request
async function googleCloud(texts, target, source) {
  const out = []
  for (let i = 0; i < texts.length; i += 100) {
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(config.translate.googleApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts.slice(i, i + 100), target, format: 'text', ...(source ? { source } : {}) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error?.message || `Google Translation API returned ${res.status}`)
    out.push(...data.data.translations.map((t) => t.translatedText))
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FREE_BLOCKED =
  "Google's free translation service is refusing requests for a few minutes (too many requests). Try again shortly, or set GOOGLE_TRANSLATE_API_KEY in backend/.env for reliable translation."

// The free endpoint answers 429 when it sees too many requests. One gentle retry, then give up:
// retrying harder only keeps the block in place longer.
async function freeOne(text, target, source) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${source || 'auto'}&tl=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: text }),
    })
    if (res.status === 429 && attempt === 0) {
      await sleep(2000)
      continue
    }
    if (res.status === 429) throw new HttpError(503, FREE_BLOCKED)
    if (!res.ok) throw new Error(`Translation service returned ${res.status}`)
    const data = await res.json()
    return (data?.[0] ?? []).map((part) => part?.[0] ?? '').join('')
  }
}

// Free endpoint: several pieces per request, one per line; a chunk whose line count
// comes back different is translated piece by piece instead.
async function googleFree(texts, target, source) {
  const chunks = []
  let current = []
  let size = 0
  texts.forEach((text, index) => {
    if (current.length && size + text.length > FREE_CHUNK_CHARS) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(index)
    size += text.length + 1
  })
  if (current.length) chunks.push(current)

  const out = new Array(texts.length)
  const work = async (chunk) => {
    const lines = (await freeOne(chunk.map((i) => texts[i]).join('\n'), target, source)).split('\n')
    if (lines.length === chunk.length) chunk.forEach((i, k) => (out[i] = lines[k]))
    else for (const i of chunk) out[i] = await freeOne(texts[i], target, source)
  }
  for (let i = 0; i < chunks.length; i += FREE_CONCURRENCY) await Promise.all(chunks.slice(i, i + FREE_CONCURRENCY).map(work))
  return out
}

router.post(
  '/',
  handle(async (req, res) => {
    const { texts, target, source } = req.body ?? {}
    if (!Array.isArray(texts) || !texts.length || texts.some((t) => typeof t !== 'string')) throw badRequest('texts must be a non-empty list of strings')
    if (!LANGUAGES[target]) throw badRequest(`Unsupported language. Choose one of: ${Object.keys(LANGUAGES).join(', ')}`)
    if (source && !LANGUAGES[source]) throw badRequest('Unsupported source language')
    if (texts.length > MAX_TEXTS) throw badRequest(`Too many pieces of text (max ${MAX_TEXTS}). Translate part of the document at a time.`)
    const chars = texts.reduce((n, t) => n + t.length, 0)
    if (chars > MAX_CHARS) throw badRequest(`The text is too long to translate at once (max ${MAX_CHARS.toLocaleString()} characters). Select part of the document.`)

    // Newlines would break the line-per-piece batching, and pieces never need them
    const clean = texts.map((t) => t.replace(/\s*\n\s*/g, ' '))
    const provider = config.translate.googleApiKey ? 'google-cloud' : 'google-free'
    const started = Date.now()
    try {
      const translations = provider === 'google-cloud' ? await googleCloud(clean, target, source) : await googleFree(clean, target, source)
      console.log(`[translate] ${texts.length} pieces (${chars.toLocaleString()} chars) to ${target} via ${provider} in ${Date.now() - started} ms`)
      res.json({ translations, provider })
    } catch (err) {
      console.error(`[translate] FAILED ${texts.length} pieces to ${target} via ${provider}: ${err.message}`)
      if (err instanceof HttpError) throw err
      throw new HttpError(502, `Translation failed: ${err.message}`)
    }
  }),
)

export default router
