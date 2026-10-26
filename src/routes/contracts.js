import { Router } from 'express'
import { query, transaction, t } from '../db.js'
import { EMAIL_RE, HttpError, badRequest, computeExpiry, handle, newId, notFound, requireString } from '../utils.js'

const router = Router()

// "expired" is derived, so it is always correct without a background job.
const STATUS_SQL = `CASE WHEN c.Status = N'incomplete' AND c.ExpiresAt < SYSUTCDATETIME() THEN N'expired' ELSE c.Status END`

async function loadContracts(where, params) {
  const rows = await query(
    `SELECT c.Id, c.WorkflowId, c.Name, c.WorkflowName, c.Estamping, ${STATUS_SQL} AS Status, c.CreatedAt, c.ExpiresAt, c.CompletedAt,
            s.SignerOrder, s.Name AS SignerName, s.Email, s.Method, s.Signed, s.SignedAt
     FROM ${t.Contracts} c
     LEFT JOIN ${t.ContractSigners} s ON s.ContractId = c.Id
     WHERE ${where}
     ORDER BY c.CreatedAt DESC, s.SignerOrder`,
    params,
  )
  // Rows come back one per signer; fold them into one object per contract
  const byId = new Map()
  for (const r of rows) {
    if (!byId.has(r.Id)) {
      byId.set(r.Id, {
        id: r.Id,
        workflowId: r.WorkflowId,
        name: r.Name,
        workflowName: r.WorkflowName,
        estamping: r.Estamping || '—',
        status: r.Status,
        createdAt: r.CreatedAt,
        expiresAt: r.ExpiresAt,
        completedAt: r.CompletedAt,
        signers: [],
      })
    }
    if (r.SignerOrder != null) {
      byId.get(r.Id).signers.push({ order: r.SignerOrder, name: r.SignerName, email: r.Email, method: r.Method, signed: !!r.Signed, signedAt: r.SignedAt })
    }
  }
  return [...byId.values()]
}

// GET /api/contracts?from=2026-10-01&to=2026-10-31   (dates optional, inclusive)
router.get(
  '/',
  handle(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : null
    const to = req.query.to ? new Date(req.query.to) : null
    if ((from && Number.isNaN(+from)) || (to && Number.isNaN(+to))) throw badRequest('from / to must be valid dates')
    const contracts = await loadContracts(
      'c.OrganisationId = @orgId AND (@from IS NULL OR c.CreatedAt >= @from) AND (@to IS NULL OR c.CreatedAt <= @to)',
      { orgId: req.user.organisationId, from, to },
    )
    res.json(contracts)
  }),
)

// POST /api/contracts  { workflowId, signers: [{ name, email }] }  -> initiates a contract
router.post(
  '/',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const workflowId = requireString(req.body.workflowId, 'workflowId', { max: 32 })
    const [wf] = await query(
      `SELECT Name, Status, BasicJson, ParticipantsJson FROM ${t.Workflows} WHERE Id = @workflowId AND OrganisationId = @orgId`,
      { workflowId, orgId },
    )
    if (!wf) throw notFound('Workflow')
    if (wf.Status !== 'active') throw new HttpError(409, 'Only active workflows can be initiated')

    const basic = JSON.parse(wf.BasicJson)
    const roles = JSON.parse(wf.ParticipantsJson).filter((p) => p.kind === 'signer')
    const signers = Array.isArray(req.body.signers) ? req.body.signers : []
    if (signers.length !== roles.length) throw badRequest(`This workflow needs exactly ${roles.length} signer(s)`)
    const clean = signers.map((s, i) => {
      const email = requireString(s?.email, `Email of signer ${i + 1}`, { max: 320 }).toLowerCase()
      if (!EMAIL_RE.test(email)) throw badRequest(`Enter a valid email for signer ${i + 1}`)
      return { name: requireString(s?.name, `Name of signer ${i + 1}`), email, method: roles[i].methods?.[0] ?? null }
    })

    const id = newId()
    const now = new Date()
    await transaction(async (run) => {
      await run(
        `INSERT INTO ${t.Contracts} (Id, OrganisationId, WorkflowId, Name, WorkflowName, Estamping, CreatedBy, CreatedAt, ExpiresAt)
         VALUES (@id, @orgId, @workflowId, @name, @workflowName, @estamping, @userId, @now, @expiresAt)`,
        {
          id,
          orgId,
          workflowId,
          name: (basic.contractName || wf.Name).slice(0, 200),
          workflowName: wf.Name,
          estamping: basic.stampingMethod || null,
          userId: req.user.id,
          now,
          expiresAt: computeExpiry(basic.expiryValue, basic.expiryUnit, now),
        },
      )
      for (const [i, s] of clean.entries()) {
        await run(
          `INSERT INTO ${t.ContractSigners} (ContractId, SignerOrder, Name, Email, Method) VALUES (@id, @order, @name, @email, @method)`,
          { id, order: i + 1, ...s },
        )
      }
    })

    const [contract] = await loadContracts('c.Id = @id AND c.OrganisationId = @orgId', { id, orgId })
    res.status(201).json(contract)
  }),
)

// POST /api/contracts/:id/signers/:order/sign  -> records a signature (e.g. from an eSign provider callback)
router.post(
  '/:id/signers/:order/sign',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const id = req.params.id
    const order = Number(req.params.order)
    const [contract] = await loadContracts('c.Id = @id AND c.OrganisationId = @orgId', { id, orgId })
    if (!contract) throw notFound('Contract')
    if (contract.status !== 'incomplete') throw new HttpError(409, `This contract is ${contract.status}`)
    if (!contract.signers.some((s) => s.order === order)) throw notFound('Signer')

    await transaction(async (run) => {
      await run(`UPDATE ${t.ContractSigners} SET Signed = 1, SignedAt = SYSUTCDATETIME() WHERE ContractId = @id AND SignerOrder = @order AND Signed = 0`, { id, order })
      await run(
        `UPDATE ${t.Contracts} SET Status = N'completed', CompletedAt = SYSUTCDATETIME()
         WHERE Id = @id AND NOT EXISTS (SELECT 1 FROM ${t.ContractSigners} WHERE ContractId = @id AND Signed = 0)`,
        { id },
      )
    })
    const [updated] = await loadContracts('c.Id = @id AND c.OrganisationId = @orgId', { id, orgId })
    res.json(updated)
  }),
)

export default router
