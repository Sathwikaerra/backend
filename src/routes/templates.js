import { Router } from 'express'
import { query, text, t } from '../db.js'
import { badRequest, handle, newId, notFound, oneOf, parseJson, requireString } from '../utils.js'

const router = Router()
const EXPIRY_UNITS = ['hours', 'eod', 'days', 'weeks', 'months']
const DEFAULT_PAGE_SETUP = { size: 'A4', orientation: 'portrait', margin: 'normal' }

const SELECT = `
  SELECT Id, Name, Description, SigningMethod, StampingMethod, ExpiryValue, ExpiryUnit,
         ParticipantsJson, ContentHtml, PageSetupJson, CreatedAt, UpdatedAt
  FROM ${t.Templates}`

const toTemplate = (row) => ({
  id: row.Id,
  name: row.Name,
  description: row.Description ?? '',
  signingMethod: row.SigningMethod,
  stampingMethod: row.StampingMethod ?? '',
  expiryValue: row.ExpiryValue,
  expiryUnit: row.ExpiryUnit,
  participants: parseJson(row.ParticipantsJson, []),
  content: row.ContentHtml,
  pageSetup: parseJson(row.PageSetupJson, DEFAULT_PAGE_SETUP),
  createdAt: row.CreatedAt,
  updatedAt: row.UpdatedAt,
})

function readTemplate(body) {
  const participants = Array.isArray(body.participants) ? body.participants : []
  if (!participants.some((p) => p?.kind === 'signer')) throw badRequest('Add at least one signer')
  if (participants.some((p) => p?.kind === 'signer' && !(Array.isArray(p.methods) && p.methods.length))) {
    throw badRequest('Pick a signature method for every signer')
  }
  const expiryValue = Number(body.expiryValue)
  if (!Number.isInteger(expiryValue) || expiryValue < 1 || expiryValue > 3650) throw badRequest('Expiry must be a whole number from 1 to 3650')
  const content = typeof body.content === 'string' ? body.content : '<p></p>'
  if (content.length > 15_000_000) throw badRequest('The document is too large. Use smaller images.')
  const page = body.pageSetup && typeof body.pageSetup === 'object' ? body.pageSetup : DEFAULT_PAGE_SETUP
  return {
    name: requireString(body.name, 'Template name'),
    description: typeof body.description === 'string' ? body.description.slice(0, 1000) : null,
    signingMethod: oneOf(body.signingMethod, ['sequential', 'parallel'], 'Signing method', 'sequential'),
    stampingMethod: typeof body.stampingMethod === 'string' && body.stampingMethod ? body.stampingMethod.slice(0, 40) : null,
    expiryValue,
    expiryUnit: oneOf(body.expiryUnit, EXPIRY_UNITS, 'Expiry unit', 'days'),
    participants: text(JSON.stringify(participants)),
    content: text(content),
    pageSetup: JSON.stringify({ size: page.size, orientation: page.orientation, margin: page.margin }),
  }
}

async function loadTemplate(id, orgId) {
  const [row] = await query(`${SELECT} WHERE Id = @id AND OrganisationId = @orgId`, { id, orgId })
  if (!row) throw notFound('Template')
  return toTemplate(row)
}

// GET /api/templates
router.get(
  '/',
  handle(async (req, res) => {
    const rows = await query(`${SELECT} WHERE OrganisationId = @orgId ORDER BY UpdatedAt DESC`, { orgId: req.user.organisationId })
    res.json(rows.map(toTemplate))
  }),
)

// GET /api/templates/:id
router.get(
  '/:id',
  handle(async (req, res) => res.json(await loadTemplate(req.params.id, req.user.organisationId))),
)

// POST /api/templates
router.post(
  '/',
  handle(async (req, res) => {
    const tpl = readTemplate(req.body)
    const id = newId()
    await query(
      `INSERT INTO ${t.Templates}
         (Id, OrganisationId, Name, Description, SigningMethod, StampingMethod, ExpiryValue, ExpiryUnit,
          ParticipantsJson, ContentHtml, PageSetupJson, CreatedBy)
       VALUES
         (@id, @orgId, @name, @description, @signingMethod, @stampingMethod, @expiryValue, @expiryUnit,
          @participants, @content, @pageSetup, @userId)`,
      { ...tpl, id, orgId: req.user.organisationId, userId: req.user.id },
    )
    res.status(201).json(await loadTemplate(id, req.user.organisationId))
  }),
)

// PUT /api/templates/:id
router.put(
  '/:id',
  handle(async (req, res) => {
    const tpl = readTemplate(req.body)
    const rows = await query(
      `UPDATE ${t.Templates} SET
         Name = @name, Description = @description, SigningMethod = @signingMethod, StampingMethod = @stampingMethod,
         ExpiryValue = @expiryValue, ExpiryUnit = @expiryUnit, ParticipantsJson = @participants,
         ContentHtml = @content, PageSetupJson = @pageSetup, UpdatedAt = SYSUTCDATETIME()
       OUTPUT inserted.Id
       WHERE Id = @id AND OrganisationId = @orgId`,
      { ...tpl, id: req.params.id, orgId: req.user.organisationId },
    )
    if (!rows.length) throw notFound('Template')
    res.json(await loadTemplate(req.params.id, req.user.organisationId))
  }),
)

// DELETE /api/templates/:id
router.delete(
  '/:id',
  handle(async (req, res) => {
    const rows = await query(`DELETE FROM ${t.Templates} OUTPUT deleted.Id WHERE Id = @id AND OrganisationId = @orgId`, {
      id: req.params.id,
      orgId: req.user.organisationId,
    })
    if (!rows.length) throw notFound('Template')
    res.status(204).end()
  }),
)

export default router
