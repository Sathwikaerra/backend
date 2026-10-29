import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import express, { Router } from 'express'
import { query, t } from '../db.js'
import { requireAuth } from '../middleware.js'
import { ensureSignedDocument } from '../signing.js'
import { handle } from '../utils.js'
import { signPayload } from '../webhooks.js'

/*
 * Sample webhook receiver: plays the part of "your loan system" so the webhook can be tried
 * without writing a separate app. Put http://localhost:4000/api/webhook-receiver as the webhook
 * URL on the Developers page.
 *
 *   POST /api/webhook-receiver        (called by the webhook) checks the signature, records the event
 *                                     and on "completed" saves the signed PDF to webhook-inbox/
 *   GET  /api/webhook-receiver        (signed in) the latest events received for your organisation
 *
 * Received events are kept in memory only (the latest 200), so a restart clears them.
 */
const router = Router()
const INBOX_DIR = path.resolve('webhook-inbox')
const MAX_EVENTS = 200
const MAX_AGE_SECONDS = 300
const received = []

const remember = (entry) => {
  received.unshift(entry)
  received.length = Math.min(received.length, MAX_EVENTS)
}

function sameSignature(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// The raw body is needed for the signature check, so this route reads text instead of parsed JSON
router.post(
  '/',
  express.text({ type: '*/*', limit: '1mb' }),
  handle(async (req, res) => {
    const deliveryId = req.get('X-Esign-Delivery')
    const timestamp = req.get('X-Esign-Timestamp')
    const signature = req.get('X-Esign-Signature')
    const body = typeof req.body === 'string' ? req.body : ''
    if (!deliveryId || !timestamp || !signature) return res.status(400).json({ error: 'Missing X-Esign-* headers' })
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return res.status(401).json({ error: 'Timestamp too old' })

    // The delivery id tells us which organisation sent it, and so which secret signed it
    const [hook] = await query(
      `SELECT w.OrganisationId, w.Secret FROM ${t.WebhookDeliveries} d
       JOIN ${t.Webhooks} w ON w.OrganisationId = d.OrganisationId WHERE d.Id = @deliveryId`,
      { deliveryId },
    )
    if (!hook || !sameSignature(signature, signPayload(hook.Secret, timestamp, body))) {
      return res.status(401).json({ error: 'Bad signature' })
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: 'Body is not JSON' })
    }

    // Retries reuse the delivery id: answer OK again without recording it twice
    const duplicate = received.some((e) => e.deliveryId === deliveryId)
    res.json({ received: true, duplicate })
    if (duplicate) return

    const entry = {
      deliveryId,
      organisationId: hook.OrganisationId,
      event: payload.event,
      receivedAt: new Date().toISOString(),
      contractId: payload.contract?.id ?? null,
      externalRef: payload.contract?.externalRef ?? null,
      contractStatus: payload.contract?.status ?? null,
      signer: payload.signer ? { order: payload.signer.order, name: payload.signer.name, email: payload.signer.email } : null,
      detail: payload.detail ?? payload.message ?? null,
      action: null,
    }
    remember(entry)
    console.log(`[webhook-receiver] ${entry.event}  ref=${entry.externalRef ?? '-'}  ${entry.signer?.name ?? ''}`)

    // What a loan system would do with each event
    if (entry.event === 'completed') {
      try {
        const signed = await ensureSignedDocument(entry.contractId)
        const name = `${String(entry.externalRef || entry.contractId).replace(/[^\w.-]+/g, '_')}-signed.pdf`
        await fs.mkdir(INBOX_DIR, { recursive: true })
        await fs.writeFile(path.join(INBOX_DIR, name), signed.data)
        entry.action = `Signed PDF saved to webhook-inbox/${name}; ready for disbursal`
      } catch (err) {
        entry.action = `Could not save the signed PDF: ${err.message}`
      }
    } else if (entry.event === 'declined' || entry.event === 'rejected') {
      entry.action = `Alert the officer: ${entry.signer?.name ?? 'participant'} ${entry.event}${entry.detail ? ` (${entry.detail})` : ''}`
    } else if (entry.event === 'signed' || entry.event === 'approved') {
      entry.action = `Mark ${entry.signer?.name ?? 'participant'} as ${entry.event}`
    }
    if (entry.action) console.log(`[webhook-receiver]   -> ${entry.action}`)
  }),
)

router.get('/', requireAuth, (req, res) => {
  res.json(received.filter((e) => e.organisationId === req.user.organisationId).map(({ organisationId, ...e }) => e))
})

export default router
