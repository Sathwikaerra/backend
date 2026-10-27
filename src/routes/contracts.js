import { Router } from 'express'
import { binary, query, text, transaction, t } from '../db.js'
import { STATUS_SQL, ensureSignedDocument, inviteNext, inviteSigner, logEvent, sha256 } from '../signing.js'
import { EMAIL_RE, HttpError, badRequest, computeExpiry, handle, newId, notFound, requireString } from '../utils.js'

const router = Router()

const signerStatus = (r) => (r.Signed ? 'signed' : r.DeclinedAt ? 'declined' : r.ViewedAt ? 'viewed' : r.InvitedAt ? 'invited' : 'waiting')

async function loadContracts(where, params) {
  const rows = await query(
    `SELECT c.Id, c.WorkflowId, c.Name, c.WorkflowName, c.Estamping, c.SigningMethod, ${STATUS_SQL} AS Status,
            c.CreatedAt, c.ExpiresAt, c.CompletedAt, c.CancelledAt,
            s.SignerOrder, s.Name AS SignerName, s.Email, s.Method, s.Signed, s.SignedAt,
            s.InvitedAt, s.ViewedAt, s.DeclinedAt, s.DeclineReason
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
        signingMethod: r.SigningMethod,
        status: r.Status,
        createdAt: r.CreatedAt,
        expiresAt: r.ExpiresAt,
        completedAt: r.CompletedAt,
        cancelledAt: r.CancelledAt,
        signers: [],
      })
    }
    if (r.SignerOrder != null) {
      byId.get(r.Id).signers.push({
        order: r.SignerOrder,
        name: r.SignerName,
        email: r.Email,
        method: r.Method,
        signed: !!r.Signed,
        signedAt: r.SignedAt,
        invitedAt: r.InvitedAt,
        viewedAt: r.ViewedAt,
        declinedAt: r.DeclinedAt,
        declineReason: r.DeclineReason,
        status: signerStatus(r),
      })
    }
  }
  return [...byId.values()]
}

async function loadContract(id, orgId) {
  const [contract] = await loadContracts('c.Id = @id AND c.OrganisationId = @orgId', { id, orgId })
  if (!contract) throw notFound('Contract')
  return contract
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

// POST /api/contracts  { workflowId, signers: [{ name, email }] }  -> creates the contract and emails the first invitation(s)
router.post(
  '/',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const workflowId = requireString(req.body.workflowId, 'workflowId', { max: 32 })
    const [wf] = await query(
      `SELECT w.Name, w.Status, w.SigningMethod, w.BasicJson, w.ParticipantsJson, w.BoxesJson, f.FileName, f.Data
       FROM ${t.Workflows} w LEFT JOIN ${t.WorkflowFiles} f ON f.WorkflowId = w.Id
       WHERE w.Id = @workflowId AND w.OrganisationId = @orgId`,
      { workflowId, orgId },
    )
    if (!wf) throw notFound('Workflow')
    if (wf.Status !== 'active') throw new HttpError(409, 'Only active workflows can be initiated')
    if (!wf.Data) throw new HttpError(409, 'This workflow has no document. Edit it and upload a PDF first.')

    const basic = JSON.parse(wf.BasicJson)
    const participants = JSON.parse(wf.ParticipantsJson)
    const roles = participants.filter((p) => p.kind === 'signer')
    const signers = Array.isArray(req.body.signers) ? req.body.signers : []
    if (signers.length !== roles.length) throw badRequest(`This workflow needs exactly ${roles.length} signer(s)`)
    const clean = signers.map((s, i) => {
      const email = requireString(s?.email, `Email of signer ${i + 1}`, { max: 320 }).toLowerCase()
      if (!EMAIL_RE.test(email)) throw badRequest(`Enter a valid email for signer ${i + 1}`)
      return { name: requireString(s?.name, `Name of signer ${i + 1}`), email, method: roles[i].methods?.[0] ?? null, roleId: String(roles[i].id) }
    })
    if (new Set(clean.map((s) => s.email)).size !== clean.length) throw badRequest('Each signer needs a different email address')

    const id = newId()
    const now = new Date()
    const name = (basic.contractName || wf.Name).slice(0, 200)
    await transaction(async (run) => {
      await run(
        `INSERT INTO ${t.Contracts}
           (Id, OrganisationId, WorkflowId, Name, WorkflowName, Estamping, CreatedBy, CreatedAt, ExpiresAt,
            SigningMethod, ParticipantsJson, BoxesJson, EmailSubject)
         VALUES (@id, @orgId, @workflowId, @name, @workflowName, @estamping, @userId, @now, @expiresAt,
            @signingMethod, @participants, @boxes, @subject)`,
        {
          id,
          orgId,
          workflowId,
          name,
          workflowName: wf.Name,
          estamping: basic.stampingMethod || null,
          userId: req.user.id,
          now,
          expiresAt: computeExpiry(basic.expiryValue, basic.expiryUnit, now),
          signingMethod: wf.SigningMethod === 'parallel' ? 'parallel' : 'sequential',
          participants: text(JSON.stringify(participants)),
          boxes: text(wf.BoxesJson),
          subject: basic.emailSubject ? String(basic.emailSubject).slice(0, 300) : null,
        },
      )
      // The signers sign this exact copy, even if the workflow's PDF is replaced later
      await run(
        `INSERT INTO ${t.ContractDocuments} (ContractId, Kind, FileName, SizeBytes, Sha256, Data)
         VALUES (@id, N'original', @fileName, @size, @hash, @data)`,
        { id, fileName: wf.FileName, size: wf.Data.length, hash: sha256(wf.Data), data: binary(wf.Data) },
      )
      for (const [i, s] of clean.entries()) {
        await run(
          `INSERT INTO ${t.ContractSigners} (ContractId, SignerOrder, RoleId, Name, Email, Method)
           VALUES (@id, @order, @roleId, @name, @email, @method)`,
          { id, order: i + 1, ...s },
        )
      }
      await logEvent(run, { contractId: id, event: 'created', detail: `Initiated from workflow "${wf.Name}"`, req })
    })

    const invites = await inviteNext(id, req)
    res.status(201).json({
      ...(await loadContract(id, orgId)),
      invites: invites.map(({ order, email, emailed, error }) => ({ order, email, emailed, error })),
    })
  }),
)

// GET /api/contracts/:id  -> contract with signers, documents and audit trail
router.get(
  '/:id',
  handle(async (req, res) => {
    const contract = await loadContract(req.params.id, req.user.organisationId)
    const events = await query(
      `SELECT SignerOrder AS signerOrder, Event AS event, Detail AS detail, IpAddress AS ip, CreatedAt AS at
       FROM ${t.ContractEvents} WHERE ContractId = @id ORDER BY CreatedAt DESC, Id DESC`,
      { id: contract.id },
    )
    const documents = await query(
      `SELECT Kind AS kind, FileName AS fileName, SizeBytes AS size, Sha256 AS sha256, CreatedAt AS createdAt
       FROM ${t.ContractDocuments} WHERE ContractId = @id`,
      { id: contract.id },
    )
    res.json({ ...contract, events, documents })
  }),
)

// GET /api/contracts/:id/document?kind=signed|original   (signed is only available once completed)
router.get(
  '/:id/document',
  handle(async (req, res) => {
    const contract = await loadContract(req.params.id, req.user.organisationId)
    const kind = req.query.kind === 'original' || contract.status !== 'completed' ? 'original' : 'signed'
    let file
    if (kind === 'signed') {
      const signed = await ensureSignedDocument(contract.id)
      file = { FileName: signed.fileName, Data: signed.data }
    } else {
      ;[file] = await query(`SELECT FileName, Data FROM ${t.ContractDocuments} WHERE ContractId = @id AND Kind = N'original'`, { id: contract.id })
    }
    if (!file) throw notFound('Document')
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.FileName)}`)
    res.send(file.Data)
  }),
)

// POST /api/contracts/:id/signers/:order/resend  -> emails a fresh link (the old one stops working) and returns it
router.post(
  '/:id/signers/:order/resend',
  handle(async (req, res) => {
    const contract = await loadContract(req.params.id, req.user.organisationId)
    const order = Number(req.params.order)
    const signer = contract.signers.find((s) => s.order === order)
    if (!signer) throw notFound('Signer')
    if (contract.status !== 'incomplete') throw new HttpError(409, `This contract is ${contract.status}`)
    if (signer.signed) throw new HttpError(409, `${signer.name} has already signed`)
    const waitingOn = contract.signingMethod !== 'parallel' && contract.signers.find((s) => s.order < order && !s.signed)
    if (waitingOn) throw new HttpError(409, `${signer.name} will be invited after ${waitingOn.name} signs`)

    res.json(await inviteSigner(contract.id, order, req, { reminder: !!signer.invitedAt }))
  }),
)

// POST /api/contracts/:id/cancel
router.post(
  '/:id/cancel',
  handle(async (req, res) => {
    const contract = await loadContract(req.params.id, req.user.organisationId)
    const rows = await query(
      `UPDATE ${t.Contracts} SET Status = N'cancelled', CancelledAt = SYSUTCDATETIME()
       OUTPUT inserted.Id WHERE Id = @id AND Status = N'incomplete' AND ExpiresAt >= SYSUTCDATETIME()`,
      { id: contract.id },
    )
    if (!rows.length) throw new HttpError(409, `This contract is ${contract.status}`)
    await logEvent(query, { contractId: contract.id, event: 'cancelled', detail: 'Cancelled by the sender', req })
    res.json(await loadContract(contract.id, req.user.organisationId))
  }),
)

export default router
