import crypto from 'node:crypto'
import { query, t } from './db.js'
import { STATUS_SQL } from './signing.js'
import { badRequest, newId } from './utils.js'

/*
 * Outgoing webhooks: every contract event (created, invited, viewed, signed, approved, declined,
 * rejected, completed, cancelled, reminded) is POSTed as JSON to the organisation's webhook URL.
 *
 * Each request carries
 *   X-Esign-Event       the event name
 *   X-Esign-Delivery    unique id of this delivery (the same on retries)
 *   X-Esign-Timestamp   unix seconds
 *   X-Esign-Signature   sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret>
 * A 2xx answer counts as delivered; anything else is retried after 5 s and 30 s.
 */
const RETRY_DELAYS = [0, 5_000, 30_000]
const TIMEOUT_MS = 10_000
const KEEP_DAYS = 30

export const newWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`

export const signPayload = (secret, timestamp, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

// https only, except for local receivers while developing
export function validateWebhookUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw badRequest('Enter a full webhook URL, e.g. https://example.com/esign/webhook')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw badRequest('The webhook URL must start with https://')
  if (url.username || url.password) throw badRequest('Do not put a username or password in the webhook URL')
  if (url.href.length > 500) throw badRequest('The webhook URL is too long')
  return url.href
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(hook, deliveryId, event, body) {
  const timestamp = Math.floor(Date.now() / 1000)
  try {
    const res = await fetch(hook.Url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'eSign-Doc-Builder-Webhooks/1.0',
        'X-Esign-Event': event,
        'X-Esign-Delivery': deliveryId,
        'X-Esign-Timestamp': String(timestamp),
        'X-Esign-Signature': signPayload(hook.Secret, timestamp, body),
      },
      body,
    })
    return { ok: res.ok, status: res.status, error: res.ok ? null : `Receiver answered ${res.status}` }
  } catch (err) {
    const error = err?.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s` : err?.cause?.code || err?.message || 'Request failed'
    return { ok: false, status: null, error: String(error).slice(0, 400) }
  }
}

// Sends one payload with retries and records the outcome. Resolves once delivered or out of attempts.
async function deliver(hook, { contractId = null, event, payload }) {
  const id = newId()
  const body = JSON.stringify({ id, ...payload })
  await query(
    `INSERT INTO ${t.WebhookDeliveries} (Id, OrganisationId, ContractId, Event, Url) VALUES (@id, @orgId, @contractId, @event, @url)`,
    { id, orgId: hook.OrganisationId, contractId, event, url: hook.Url },
  )
  let result
  for (const [i, delay] of RETRY_DELAYS.entries()) {
    if (delay) await sleep(delay)
    result = await post(hook, id, event, body)
    await query(
      `UPDATE ${t.WebhookDeliveries} SET Attempts = @attempts, StatusCode = @status, Error = @error,
         DeliveredAt = CASE WHEN @ok = 1 THEN SYSUTCDATETIME() ELSE NULL END
       WHERE Id = @id`,
      { id, attempts: i + 1, status: result.status, error: result.error, ok: result.ok ? 1 : 0 },
    )
    if (result.ok) break
  }
  return { id, ...result }
}

async function hookFor(orgId) {
  const [hook] = await query(`SELECT OrganisationId, Url, Secret, Enabled FROM ${t.Webhooks} WHERE OrganisationId = @orgId`, { orgId })
  return hook?.Enabled ? hook : null
}

/*
 * Called for every audit-trail event. Fire-and-forget: a slow or broken receiver never
 * delays signing. `link` is the raw signing link, only known right after an invitation.
 */
export function emitContractEvent({ contractId, event, signerOrder = null, detail = null, link = null }) {
  buildAndSend({ contractId, event, signerOrder, detail, link }).catch((err) => console.error('[webhooks]', event, contractId, err.message))
}

async function buildAndSend({ contractId, event, signerOrder, detail, link }) {
  const [c] = await query(
    `SELECT c.Id, c.OrganisationId, c.WorkflowId, c.Name, c.ExternalRef, c.Source, ${STATUS_SQL} AS Status, c.ExpiresAt, c.CompletedAt
     FROM ${t.Contracts} c WHERE c.Id = @contractId`,
    { contractId },
  )
  if (!c) return
  const hook = await hookFor(c.OrganisationId)
  if (!hook) return

  let signer = null
  if (signerOrder != null) {
    const [s] = await query(
      `SELECT SignerOrder, Kind, Name, Email, Phone, Signed, SignedAt, DeclinedAt, ViewedAt, InvitedAt
       FROM ${t.ContractSigners} WHERE ContractId = @contractId AND SignerOrder = @signerOrder`,
      { contractId, signerOrder },
    )
    if (s) signer = { ...publicSigner(s), ...(link ? { signingLink: link } : {}) }
  }

  await deliver(hook, {
    contractId,
    event,
    payload: {
      event,
      occurredAt: new Date().toISOString(),
      contract: {
        id: c.Id,
        externalRef: c.ExternalRef,
        name: c.Name,
        workflowId: c.WorkflowId,
        source: c.Source,
        status: c.Status,
        expiresAt: c.ExpiresAt,
        completedAt: c.CompletedAt,
      },
      signer,
      detail,
    },
  })
}

export const signerStatus = (s) => (s.Signed ? (s.Kind === 'reviewer' ? 'approved' : 'signed') : s.DeclinedAt ? (s.Kind === 'reviewer' ? 'rejected' : 'declined') : s.ViewedAt ? 'viewed' : s.InvitedAt ? 'invited' : 'waiting')

export const publicSigner = (s) => ({
  order: s.SignerOrder,
  kind: s.Kind,
  name: s.Name,
  email: s.Email,
  phone: s.Phone ?? null,
  status: signerStatus(s),
  signedAt: s.SignedAt ?? null,
})

// "Send test" on the Developers page: one attempt, answered straight away
export async function sendTestWebhook(orgId) {
  const [hook] = await query(`SELECT OrganisationId, Url, Secret, Enabled FROM ${t.Webhooks} WHERE OrganisationId = @orgId`, { orgId })
  if (!hook) throw badRequest('Save a webhook URL first')
  const id = newId()
  const event = 'ping'
  const body = JSON.stringify({ id, event, occurredAt: new Date().toISOString(), message: 'Test delivery from eSign Doc Builder' })
  await query(`INSERT INTO ${t.WebhookDeliveries} (Id, OrganisationId, Event, Url) VALUES (@id, @orgId, @event, @url)`, { id, orgId, event, url: hook.Url })
  const result = await post(hook, id, event, body)
  await query(
    `UPDATE ${t.WebhookDeliveries} SET Attempts = 1, StatusCode = @status, Error = @error,
       DeliveredAt = CASE WHEN @ok = 1 THEN SYSUTCDATETIME() ELSE NULL END WHERE Id = @id`,
    { id, status: result.status, error: result.error, ok: result.ok ? 1 : 0 },
  )
  // Keep the log small
  await query(`DELETE FROM ${t.WebhookDeliveries} WHERE OrganisationId = @orgId AND CreatedAt < DATEADD(DAY, -${KEEP_DAYS}, SYSUTCDATETIME())`, { orgId })
  return { id, ...result }
}
