import { Router } from 'express'
import { cancelContract, createContract, loadContract, loadContracts } from '../contracts.js'
import { query, t } from '../db.js'
import { ensureSignedDocument, issueLink, logEvent } from '../signing.js'
import { HttpError, badRequest, handle, notFound, parseJson } from '../utils.js'
import pdfTools from './pdfTools.js'

/*
 * Public API for other systems. Authenticate with "X-API-Key: esk_..." (create keys on the Developers page).
 *
 *   GET  /api/v1/workflows                              active workflows and the roles each one needs
 *   POST /api/v1/contracts                              start a contract (own PDF optional) -> signing links
 *   GET  /api/v1/contracts?externalRef=...              find contracts (newest first, at most 100)
 *   GET  /api/v1/contracts/:id                          status of the contract and every participant
 *   GET  /api/v1/contracts/:id/events                   audit trail
 *   GET  /api/v1/contracts/:id/document?kind=signed|original[&format=base64]
 *   POST /api/v1/contracts/:id/signers/:order/link      fresh link for one participant (the old one stops working)
 *   POST /api/v1/contracts/:id/cancel
 *   POST /api/v1/tools/pdf-to-base64                    a PDF (form field "file" or raw body) -> its base64
 */
const router = Router()
router.use('/tools', pdfTools)

const participantStatus = (s) =>
  s.kind === 'reviewer' && s.status === 'signed' ? 'approved' : s.kind === 'reviewer' && s.status === 'declined' ? 'rejected' : s.status

function apiContract(c, links = {}) {
  return {
    id: c.id,
    externalRef: c.externalRef,
    name: c.name,
    status: c.status,
    workflowId: c.workflowId,
    workflowName: c.workflowName,
    signingOrder: c.signingMethod,
    linksDeliveredBy: c.notify === 'none' ? 'caller' : 'email',
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    completedAt: c.completedAt,
    cancelledAt: c.cancelledAt,
    participants: c.signers.map((s) => ({
      order: s.order,
      kind: s.kind,
      name: s.name,
      email: s.email,
      phone: s.phone,
      status: participantStatus(s),
      invitedAt: s.invitedAt,
      viewedAt: s.viewedAt,
      signedAt: s.signedAt,
      declinedAt: s.declinedAt,
      declineReason: s.declineReason,
      reviewComment: s.reviewComment,
      signedWith: s.signedMethod ?? null,
      verification: s.verification ?? null,
      ...(links[s.order] ? { signingLink: links[s.order] } : {}),
    })),
  }
}

// GET /api/v1/workflows
router.get(
  '/workflows',
  handle(async (req, res) => {
    const rows = await query(
      `SELECT w.Id, w.Name, w.SigningMethod, w.ParticipantsJson, w.BoxesJson, w.UpdatedAt, f.FileName
       FROM ${t.Workflows} w LEFT JOIN ${t.WorkflowFiles} f ON f.WorkflowId = w.Id
       WHERE w.OrganisationId = @orgId AND w.Status = N'active'
       ORDER BY w.UpdatedAt DESC`,
      { orgId: req.user.organisationId },
    )
    res.json(
      rows.map((w) => {
        const people = parseJson(w.ParticipantsJson, [])
        const role = (p) => ({ role: p.name, methods: p.methods ?? [] })
        return {
          id: w.Id,
          name: w.Name,
          signingOrder: w.SigningMethod === 'parallel' ? 'parallel' : 'sequential',
          reviewers: people.filter((p) => p.kind === 'reviewer').map(role),
          signers: people.filter((p) => p.kind === 'signer').map(role),
          // A PDF sent with a contract needs at least this many pages
          minPages: Math.max(0, ...parseJson(w.BoxesJson, []).map((b) => Number(b.page) || 0)),
          defaultDocument: w.FileName ?? null,
          updatedAt: w.UpdatedAt,
        }
      }),
    )
  }),
)

/*
 * POST /api/v1/contracts
 * {
 *   workflowId, name?, externalRef?,
 *   document?: { fileName, base64 },          // instead of the workflow's PDF; same layout expected
 *   reviewers?: [{ name, email, phone? }],    // in the workflow's order
 *   signers: [{ name, email, phone? }],
 *   sendEmails?: true                         // false: we send nothing; deliver the returned links yourself
 * }
 */
router.post(
  '/contracts',
  handle(async (req, res) => {
    const b = req.body ?? {}
    if (b.sendEmails !== undefined && typeof b.sendEmails !== 'boolean') throw badRequest('sendEmails must be true or false')
    const orgId = req.user.organisationId
    const { id, links } = await createContract(
      {
        orgId,
        userId: req.user.id,
        workflowId: b.workflowId,
        signers: b.signers,
        reviewers: b.reviewers,
        document: b.document ?? null,
        name: b.name ?? null,
        externalRef: b.externalRef ?? null,
        notify: b.sendEmails === false ? 'none' : 'email',
        source: 'api',
      },
      req,
    )
    res.status(201).json(apiContract(await loadContract(id, orgId), links))
  }),
)

// GET /api/v1/contracts?externalRef=...&status=...
router.get(
  '/contracts',
  handle(async (req, res) => {
    const ref = typeof req.query.externalRef === 'string' ? req.query.externalRef : null
    const rows = await query(
      `SELECT TOP 100 Id FROM ${t.Contracts} WHERE OrganisationId = @orgId AND (@ref IS NULL OR ExternalRef = @ref) ORDER BY CreatedAt DESC`,
      { orgId: req.user.organisationId, ref },
    )
    if (!rows.length) return res.json([])
    const ids = rows.map((r) => r.Id)
    const params = Object.fromEntries(ids.map((v, i) => [`id${i}`, v]))
    const list = await loadContracts(`c.OrganisationId = @orgId AND c.Id IN (${ids.map((_, i) => `@id${i}`).join(', ')})`, {
      orgId: req.user.organisationId,
      ...params,
    })
    const status = typeof req.query.status === 'string' ? req.query.status : null
    res.json(list.filter((c) => !status || c.status === status).map((c) => apiContract(c)))
  }),
)

// GET /api/v1/contracts/:id
router.get(
  '/contracts/:id',
  handle(async (req, res) => {
    res.json(apiContract(await loadContract(req.params.id, req.user.organisationId)))
  }),
)

// GET /api/v1/contracts/:id/events
router.get(
  '/contracts/:id/events',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id, req.user.organisationId)
    const events = await query(
      `SELECT SignerOrder AS participantOrder, Event AS event, Detail AS detail, IpAddress AS ip, CreatedAt AS at
       FROM ${t.ContractEvents} WHERE ContractId = @id ORDER BY CreatedAt, Id`,
      { id: c.id },
    )
    res.json(events)
  }),
)

// GET /api/v1/contracts/:id/document?kind=signed|original&format=base64
router.get(
  '/contracts/:id/document',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id, req.user.organisationId)
    const kind = req.query.kind === 'original' ? 'original' : req.query.kind === 'signed' ? 'signed' : c.status === 'completed' ? 'signed' : 'original'
    if (kind === 'signed' && c.status !== 'completed') throw new HttpError(409, `The signed PDF is ready once the contract is completed (it is ${c.status})`)
    let file
    if (kind === 'signed') {
      const signed = await ensureSignedDocument(c.id)
      file = { fileName: signed.fileName, data: signed.data }
    } else {
      const [row] = await query(`SELECT FileName, Data FROM ${t.ContractDocuments} WHERE ContractId = @id AND Kind = N'original'`, { id: c.id })
      if (row) file = { fileName: row.FileName, data: row.Data }
    }
    if (!file) throw notFound('Document')
    if (req.query.format === 'base64') return res.json({ kind, fileName: file.fileName, base64: Buffer.from(file.data).toString('base64') })
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
    res.send(file.data)
  }),
)

// POST /api/v1/contracts/:id/signers/:order/link  -> { order, signingLink }
router.post(
  '/contracts/:id/signers/:order/link',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id, req.user.organisationId)
    const order = Number(req.params.order)
    const s = c.signers.find((x) => x.order === order)
    if (!s) throw notFound('Participant')
    if (c.status !== 'incomplete') throw new HttpError(409, `This contract is ${c.status}`)
    if (s.signed) throw new HttpError(409, `${s.name} has already ${s.kind === 'reviewer' ? 'approved' : 'signed'}`)
    const signingLink = await issueLink(c.id, order, req)
    await logEvent(query, { contractId: c.id, signerOrder: order, event: 'link_reissued', detail: 'New signing link created through the API', req })
    res.json({ order, signingLink })
  }),
)

// POST /api/v1/contracts/:id/cancel
router.post(
  '/contracts/:id/cancel',
  handle(async (req, res) => {
    res.json(apiContract(await cancelContract(req.params.id, req.user.organisationId, req, 'Cancelled through the API')))
  }),
)

export default router
