import { Router } from 'express'
import { cancelContract, createContract, loadContract, loadContracts } from '../contracts.js'
import { query, t } from '../db.js'
import { ensureSignedDocument, inviteSigner } from '../signing.js'
import { HttpError, badRequest, handle, notFound } from '../utils.js'

const router = Router()

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

// POST /api/contracts  { workflowId, signers: [{ name, email }], reviewers?: [{ name, email }] }
// -> creates the contract and emails the first invitation(s); reviewers go first
router.post(
  '/',
  handle(async (req, res) => {
    const orgId = req.user.organisationId
    const { id, invites } = await createContract(
      { orgId, userId: req.user.id, workflowId: req.body.workflowId, signers: req.body.signers, reviewers: req.body.reviewers },
      req,
    )
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
    if (signer.signed) throw new HttpError(409, `${signer.name} has already ${signer.kind === 'reviewer' ? 'approved' : 'signed'}`)
    const reviewing = signer.kind !== 'reviewer' && contract.signers.find((s) => s.kind === 'reviewer' && !s.signed)
    if (reviewing) throw new HttpError(409, `${signer.name} will be invited after ${reviewing.name} approves the document`)
    const waitingOn = contract.signingMethod !== 'parallel' && contract.signers.find((s) => s.order < order && !s.signed)
    if (waitingOn) throw new HttpError(409, `${signer.name} will be invited after ${waitingOn.name} ${waitingOn.kind === 'reviewer' ? 'approves' : 'signs'}`)

    res.json(await inviteSigner(contract.id, order, req, { reminder: !!signer.invitedAt }))
  }),
)

// POST /api/contracts/:id/cancel
router.post(
  '/:id/cancel',
  handle(async (req, res) => {
    res.json(await cancelContract(req.params.id, req.user.organisationId, req))
  }),
)

export default router
