import { Router } from 'express'
import multer from 'multer'
import { binary, query, text, transaction, t } from '../db.js'
import { badRequest, handle, newId, notFound, oneOf, parseJson, requireString } from '../utils.js'

const router = Router()
const STATUSES = ['active', 'inactive', 'draft']

// PDFs are held in memory just long enough to be written to WorkflowFiles.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')
      ? cb(null, true)
      : cb(badRequest('Only PDF files are supported')),
})

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v)

const LIST_SELECT = `
  SELECT w.Id, w.Name, w.Status, w.Type, w.DocumentName, w.BasicJson, w.AdvancedJson, w.EstampJson,
         w.ParticipantsJson, w.BoxesJson, w.InitiationMessage, w.CreatedAt, w.UpdatedAt,
         CASE WHEN f.WorkflowId IS NULL THEN 0 ELSE 1 END AS HasFile
  FROM ${t.Workflows} w
  LEFT JOIN ${t.WorkflowFiles} f ON f.WorkflowId = w.Id`

// Database row -> the workflow shape the frontend works with
const toWorkflow = (row, versions = []) => ({
  id: row.Id,
  name: row.Name,
  status: row.Status,
  type: row.Type,
  documentName: row.DocumentName ?? '',
  basic: parseJson(row.BasicJson, {}),
  advanced: parseJson(row.AdvancedJson, {}),
  estamp: parseJson(row.EstampJson, {}),
  participants: parseJson(row.ParticipantsJson, []),
  boxes: parseJson(row.BoxesJson, []),
  initiationMessage: row.InitiationMessage ?? '',
  createdAt: row.CreatedAt,
  updatedAt: row.UpdatedAt,
  hasFile: !!row.HasFile,
  versions,
})

// Validates the editable part of a workflow sent by the client.
function readWorkflow(data, status) {
  if (!isObject(data)) throw badRequest('Workflow data is missing')
  const basic = isObject(data.basic) ? data.basic : {}
  const participants = Array.isArray(data.participants) ? data.participants : []
  const boxes = Array.isArray(data.boxes) ? data.boxes : []
  if (status === 'active' && !participants.some((p) => p?.kind === 'signer')) {
    throw badRequest('An active workflow needs at least one signer')
  }
  return {
    name: requireString(data.name, 'Workflow name'),
    documentName: typeof data.documentName === 'string' && data.documentName ? data.documentName.slice(0, 260) : null,
    signingMethod: basic.signingMethod === 'parallel' ? 'parallel' : 'sequential',
    basic,
    advanced: isObject(data.advanced) ? data.advanced : {},
    estamp: isObject(data.estamp) ? data.estamp : {},
    participants,
    boxes,
    initiationMessage: typeof data.initiationMessage === 'string' ? data.initiationMessage.slice(0, 2000) : null,
  }
}

const jsonParams = (w) => ({
  name: w.name,
  documentName: w.documentName,
  signingMethod: w.signingMethod,
  basic: text(JSON.stringify(w.basic)),
  advanced: text(JSON.stringify(w.advanced)),
  estamp: text(JSON.stringify(w.estamp)),
  participants: text(JSON.stringify(w.participants)),
  boxes: text(JSON.stringify(w.boxes)),
  initiationMessage: w.initiationMessage,
})

// Creates (no id) or updates a workflow, its PDF and a new version row, all in one transaction.
async function saveWorkflow({ orgId, userId, id, status, workflow, file }) {
  return transaction(async (run) => {
    let workflowId = id
    if (id) {
      const [existing] = await run(`SELECT Status FROM ${t.Workflows} WHERE Id = @id AND OrganisationId = @orgId`, { id, orgId })
      if (!existing) throw notFound('Workflow')
      status ||= existing.Status
      await run(
        `UPDATE ${t.Workflows} SET
           Name = @name, Status = @status, SigningMethod = @signingMethod,
           DocumentName = COALESCE(@documentName, DocumentName),
           BasicJson = @basic, AdvancedJson = @advanced, EstampJson = @estamp,
           ParticipantsJson = @participants, BoxesJson = @boxes, InitiationMessage = @initiationMessage,
           UpdatedAt = SYSUTCDATETIME()
         WHERE Id = @id AND OrganisationId = @orgId`,
        { ...jsonParams(workflow), status, id, orgId },
      )
    } else {
      workflowId = newId()
      status ||= 'draft'
      await run(
        `INSERT INTO ${t.Workflows}
           (Id, OrganisationId, Name, Status, SigningMethod, DocumentName, BasicJson, AdvancedJson, EstampJson,
            ParticipantsJson, BoxesJson, InitiationMessage, CreatedBy)
         VALUES
           (@id, @orgId, @name, @status, @signingMethod, @documentName, @basic, @advanced, @estamp,
            @participants, @boxes, @initiationMessage, @userId)`,
        { ...jsonParams(workflow), status, id: workflowId, orgId, userId },
      )
    }

    if (file) {
      await run(`DELETE FROM ${t.WorkflowFiles} WHERE WorkflowId = @id`, { id: workflowId })
      await run(
        `INSERT INTO ${t.WorkflowFiles} (WorkflowId, FileName, ContentType, SizeBytes, Data)
         VALUES (@id, @fileName, N'application/pdf', @size, @data)`,
        { id: workflowId, fileName: file.originalname.slice(0, 260), size: file.size, data: binary(file.buffer) },
      )
    }

    const [{ next }] = await run(`SELECT ISNULL(MAX(Version), 0) + 1 AS next FROM ${t.WorkflowVersions} WHERE WorkflowId = @id`, { id: workflowId })
    await run(
      `INSERT INTO ${t.WorkflowVersions} (WorkflowId, Version, Status, SnapshotJson, SavedBy)
       VALUES (@id, @version, @status, @snapshot, @userId)`,
      { id: workflowId, version: next, status, snapshot: text(JSON.stringify({ ...workflow, status })), userId },
    )
    return workflowId
  })
}

async function loadWorkflow(id, orgId) {
  const [row] = await query(`${LIST_SELECT} WHERE w.Id = @id AND w.OrganisationId = @orgId`, { id, orgId })
  if (!row) throw notFound('Workflow')
  const versions = await query(
    `SELECT Version AS version, Status AS status, SavedAt AS savedAt FROM ${t.WorkflowVersions} WHERE WorkflowId = @id ORDER BY Version`,
    { id },
  )
  return toWorkflow(row, versions)
}

// Multipart body: field "data" (workflow JSON), optional "status", optional "file" (PDF)
function readMultipart(req) {
  const workflow = typeof req.body.data === 'string' ? parseJson(req.body.data, null) : req.body.data
  const status = req.body.status ? oneOf(req.body.status, STATUSES, 'Status') : undefined
  return { workflow: readWorkflow(workflow, status), status }
}

// GET /api/workflows?status=active
router.get(
  '/',
  handle(async (req, res) => {
    const status = req.query.status ? oneOf(req.query.status, STATUSES, 'Status') : null
    const rows = await query(
      `${LIST_SELECT} WHERE w.OrganisationId = @orgId AND (@status IS NULL OR w.Status = @status) ORDER BY w.CreatedAt DESC`,
      { orgId: req.user.organisationId, status },
    )
    res.json(rows.map((r) => toWorkflow(r)))
  }),
)

// GET /api/workflows/:id
router.get(
  '/:id',
  handle(async (req, res) => res.json(await loadWorkflow(req.params.id, req.user.organisationId))),
)

// POST /api/workflows  (multipart)
router.post(
  '/',
  upload.single('file'),
  handle(async (req, res) => {
    const { workflow, status } = readMultipart(req)
    const id = await saveWorkflow({ orgId: req.user.organisationId, userId: req.user.id, status, workflow, file: req.file })
    res.status(201).json(await loadWorkflow(id, req.user.organisationId))
  }),
)

// PUT /api/workflows/:id  (multipart; the file is optional and replaces the old one)
router.put(
  '/:id',
  upload.single('file'),
  handle(async (req, res) => {
    const { workflow, status } = readMultipart(req)
    const id = await saveWorkflow({ orgId: req.user.organisationId, userId: req.user.id, id: req.params.id, status, workflow, file: req.file })
    res.json(await loadWorkflow(id, req.user.organisationId))
  }),
)

// PATCH /api/workflows/:id/status  { status }
router.patch(
  '/:id/status',
  handle(async (req, res) => {
    const status = oneOf(req.body.status, STATUSES, 'Status')
    const rows = await query(
      `UPDATE ${t.Workflows} SET Status = @status, UpdatedAt = SYSUTCDATETIME()
       OUTPUT inserted.Id WHERE Id = @id AND OrganisationId = @orgId`,
      { status, id: req.params.id, orgId: req.user.organisationId },
    )
    if (!rows.length) throw notFound('Workflow')
    res.json(await loadWorkflow(req.params.id, req.user.organisationId))
  }),
)

// DELETE /api/workflows/:id   (file and versions go with it; contracts keep their history)
router.delete(
  '/:id',
  handle(async (req, res) => {
    const rows = await query(`DELETE FROM ${t.Workflows} OUTPUT deleted.Id WHERE Id = @id AND OrganisationId = @orgId`, {
      id: req.params.id,
      orgId: req.user.organisationId,
    })
    if (!rows.length) throw notFound('Workflow')
    res.status(204).end()
  }),
)

// POST /api/workflows/import  (JSON exported from the detail page) -> saved as a draft
router.post(
  '/import',
  handle(async (req, res) => {
    const data = req.body
    if (!isObject(data) || !data.name || !Array.isArray(data.participants)) throw badRequest('This file is not a valid workflow export')
    const workflow = readWorkflow({ ...data, name: `${String(data.name).slice(0, 185)} (imported)` }, 'draft')
    const id = await saveWorkflow({ orgId: req.user.organisationId, userId: req.user.id, status: 'draft', workflow })
    res.status(201).json(await loadWorkflow(id, req.user.organisationId))
  }),
)

// GET /api/workflows/:id/file  -> the PDF
router.get(
  '/:id/file',
  handle(async (req, res) => {
    const [file] = await query(
      `SELECT f.FileName, f.ContentType, f.Data
       FROM ${t.WorkflowFiles} f JOIN ${t.Workflows} w ON w.Id = f.WorkflowId
       WHERE f.WorkflowId = @id AND w.OrganisationId = @orgId`,
      { id: req.params.id, orgId: req.user.organisationId },
    )
    if (!file) throw notFound('File')
    res.set('Content-Type', file.ContentType)
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.FileName)}`)
    res.send(file.Data)
  }),
)

export default router
