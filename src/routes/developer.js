import crypto from 'node:crypto'
import { Router } from 'express'
import { query, t } from '../db.js'
import { HttpError, badRequest, handle, newId, notFound, requireString } from '../utils.js'
import { newWebhookSecret, sendTestWebhook, validateWebhookUrl } from '../webhooks.js'
import pdfTools from './pdfTools.js'

/*
 * Developers page (signed-in users): API keys and the organisation's webhook.
 *   GET    /api/developer/api-keys              list (never the keys themselves)
 *   POST   /api/developer/api-keys  { name }    create -> { ..., key } shown once
 *   DELETE /api/developer/api-keys/:id          revoke
 *   GET    /api/developer/webhook               { url, enabled, secret } or null
 *   PUT    /api/developer/webhook   { url, enabled }
 *   DELETE /api/developer/webhook
 *   POST   /api/developer/webhook/secret        new signing secret
 *   POST   /api/developer/webhook/test          sends a "ping" and returns the receiver's answer
 *   GET    /api/developer/webhook/deliveries    the latest 50 deliveries
 *   POST   /api/developer/pdf-to-base64         a PDF -> its base64 (see routes/pdfTools.js)
 */
const router = Router()
router.use(pdfTools)
const MAX_ACTIVE_KEYS = 20

const keyRow = (r) => ({
  id: r.Id,
  name: r.Name,
  prefix: r.Prefix,
  createdAt: r.CreatedAt,
  createdBy: r.CreatedByName ?? null,
  lastUsedAt: r.LastUsedAt,
  revokedAt: r.RevokedAt,
})

router.get(
  '/api-keys',
  handle(async (req, res) => {
    const rows = await query(
      `SELECT k.Id, k.Name, k.Prefix, k.CreatedAt, k.LastUsedAt, k.RevokedAt, u.Name AS CreatedByName
       FROM ${t.ApiKeys} k LEFT JOIN ${t.Users} u ON u.Id = k.CreatedBy
       WHERE k.OrganisationId = @orgId ORDER BY CASE WHEN k.RevokedAt IS NULL THEN 0 ELSE 1 END, k.CreatedAt DESC`,
      { orgId: req.user.organisationId },
    )
    res.json(rows.map(keyRow))
  }),
)

router.post(
  '/api-keys',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const name = requireString(req.body?.name, 'Key name', { max: 100 })
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM ${t.ApiKeys} WHERE OrganisationId = @orgId AND RevokedAt IS NULL`, { orgId })
    if (n >= MAX_ACTIVE_KEYS) throw new HttpError(409, `An organisation can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`)

    const key = `esk_${crypto.randomBytes(30).toString('base64url')}`
    const id = newId()
    await query(
      `INSERT INTO ${t.ApiKeys} (Id, OrganisationId, Name, Prefix, KeyHash, CreatedBy) VALUES (@id, @orgId, @name, @prefix, @hash, @userId)`,
      { id, orgId, name, prefix: key.slice(0, 12), hash: crypto.createHash('sha256').update(key).digest('hex'), userId: req.user.id },
    )
    const [row] = await query(`SELECT Id, Name, Prefix, CreatedAt, LastUsedAt, RevokedAt FROM ${t.ApiKeys} WHERE Id = @id`, { id })
    res.status(201).json({ ...keyRow(row), key })
  }),
)

router.delete(
  '/api-keys/:id',
  handle(async (req, res) => {
    const rows = await query(
      `UPDATE ${t.ApiKeys} SET RevokedAt = COALESCE(RevokedAt, SYSUTCDATETIME()) OUTPUT inserted.Id WHERE Id = @id AND OrganisationId = @orgId`,
      { id: req.params.id, orgId: req.user.organisationId },
    )
    if (!rows.length) throw notFound('API key')
    res.status(204).end()
  }),
)

async function loadWebhook(orgId) {
  const [w] = await query(`SELECT Url, Secret, Enabled, UpdatedAt FROM ${t.Webhooks} WHERE OrganisationId = @orgId`, { orgId })
  return w ? { url: w.Url, secret: w.Secret, enabled: !!w.Enabled, updatedAt: w.UpdatedAt } : null
}

router.get(
  '/webhook',
  handle(async (req, res) => {
    res.json(await loadWebhook(req.user.organisationId))
  }),
)

router.put(
  '/webhook',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const url = validateWebhookUrl(req.body?.url)
    const enabled = req.body?.enabled === undefined ? true : req.body.enabled
    if (typeof enabled !== 'boolean') throw badRequest('enabled must be true or false')
    await query(
      `MERGE ${t.Webhooks} AS w
       USING (SELECT @orgId AS OrganisationId) AS src ON w.OrganisationId = src.OrganisationId
       WHEN MATCHED THEN UPDATE SET Url = @url, Enabled = @enabled, UpdatedAt = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (OrganisationId, Url, Secret, Enabled) VALUES (@orgId, @url, @secret, @enabled);`,
      { orgId, url, enabled: enabled ? 1 : 0, secret: newWebhookSecret() },
    )
    res.json(await loadWebhook(orgId))
  }),
)

router.delete(
  '/webhook',
  handle(async (req, res) => {
    await query(`DELETE FROM ${t.Webhooks} WHERE OrganisationId = @orgId`, { orgId: req.user.organisationId })
    res.status(204).end()
  }),
)

router.post(
  '/webhook/secret',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const rows = await query(`UPDATE ${t.Webhooks} SET Secret = @secret, UpdatedAt = SYSUTCDATETIME() OUTPUT inserted.OrganisationId WHERE OrganisationId = @orgId`, {
      orgId,
      secret: newWebhookSecret(),
    })
    if (!rows.length) throw badRequest('Save a webhook URL first')
    res.json(await loadWebhook(orgId))
  }),
)

router.post(
  '/webhook/test',
  handle(async (req, res) => {
    res.json(await sendTestWebhook(req.user.organisationId))
  }),
)

router.get(
  '/webhook/deliveries',
  handle(async (req, res) => {
    const rows = await query(
      `SELECT TOP 50 d.Id AS id, d.Event AS event, d.ContractId AS contractId, c.Name AS contractName, d.Url AS url,
              d.Attempts AS attempts, d.StatusCode AS statusCode, d.Error AS error, d.CreatedAt AS createdAt, d.DeliveredAt AS deliveredAt
       FROM ${t.WebhookDeliveries} d LEFT JOIN ${t.Contracts} c ON c.Id = d.ContractId
       WHERE d.OrganisationId = @orgId ORDER BY d.CreatedAt DESC`,
      { orgId: req.user.organisationId },
    )
    res.json(rows)
  }),
)

export default router
