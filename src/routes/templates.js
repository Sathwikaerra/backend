import { Router } from 'express'
import { query, text, t } from '../db.js'
import { badRequest, handle, newId, notFound, parseJson, requireString } from '../utils.js'

const router = Router()
const DEFAULT_PAGE_SETUP = { size: 'A4', orientation: 'portrait', margin: 'normal' }

const SELECT = `
  SELECT Id, Name, Description, ContentHtml, PageSetupJson, CreatedAt, UpdatedAt
  FROM ${t.Templates}`

const normalizePageSetup = (page) => ({
  size: typeof page?.size === 'string' ? page.size : DEFAULT_PAGE_SETUP.size,
  orientation: typeof page?.orientation === 'string' ? page.orientation : DEFAULT_PAGE_SETUP.orientation,
  margin: typeof page?.margin === 'string' ? page.margin : DEFAULT_PAGE_SETUP.margin,
})

const toTemplate = (row) => ({
  id: row.Id,
  name: row.Name,
  description: row.Description ?? '',
  content: row.ContentHtml,
  pageSetup: normalizePageSetup(parseJson(row.PageSetupJson, DEFAULT_PAGE_SETUP)),
  createdAt: row.CreatedAt,
  updatedAt: row.UpdatedAt,
})

function readTemplate(body) {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const content = typeof data.content === 'string' ? data.content : '<p></p>'
  if (content.length > 15_000_000) throw badRequest('The document is too large. Use smaller images.')
  const page = data.pageSetup && typeof data.pageSetup === 'object' && !Array.isArray(data.pageSetup) ? data.pageSetup : DEFAULT_PAGE_SETUP
  return {
    name: requireString(data.name, 'Template name'),
    description: typeof data.description === 'string' ? data.description.slice(0, 1000) : null,
    content: text(content),
    pageSetup: JSON.stringify(normalizePageSetup(page)),
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
         (Id, OrganisationId, Name, Description, ContentHtml, PageSetupJson, CreatedBy)
       VALUES
         (@id, @orgId, @name, @description, @content, @pageSetup, @userId)`,
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
         Name = @name, Description = @description, ContentHtml = @content,
         PageSetupJson = @pageSetup, UpdatedAt = SYSUTCDATETIME()
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
