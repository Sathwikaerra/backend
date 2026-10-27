import { Router } from 'express'
import { query, text, transaction, t } from '../db.js'
import { sendSigningDeclined } from '../mailer.js'
import { STATUS_SQL, ensureSignedDocument, finalizeContract, hashToken, inviteNext, logEvent } from '../signing.js'
import { HttpError, badRequest, handle, notFound, parseJson } from '../utils.js'

/*
 * Public signing API. No login: the link token in the URL identifies the signer.
 *   GET  /api/sign/:token            -> what this signer sees (document info, their boxes, progress)
 *   GET  /api/sign/:token/document   -> the PDF (the signed one once everyone has signed)
 *   POST /api/sign/:token/sign       -> { signature, type, consent } adopts the signature and signs
 *   POST /api/sign/:token/approve    -> { comment? } a reviewer approves; signers are invited once all reviewers have
 *   POST /api/sign/:token/decline    -> { reason } declines (a reviewer: rejects) and stops the contract
 */
const router = Router()
const MAX_SIGNATURE_CHARS = 700_000

async function findSigner(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw notFound('Signing link')
  const [row] = await query(
    `SELECT s.ContractId, s.SignerOrder, s.RoleId, s.Kind, s.Name, s.Email, s.Signed, s.SignedAt, s.DeclinedAt, s.ViewedAt,
            c.Name AS ContractName, c.SigningMethod, c.ExpiresAt, c.CompletedAt, c.BoxesJson, c.ParticipantsJson, c.CreatedBy,
            ${STATUS_SQL} AS Status, o.Name AS OrgName, u.Name AS SenderName, u.Email AS SenderEmail
     FROM ${t.ContractSigners} s
     JOIN ${t.Contracts} c ON c.Id = s.ContractId
     JOIN ${t.Organisations} o ON o.Id = c.OrganisationId
     LEFT JOIN ${t.Users} u ON u.Id = c.CreatedBy
     WHERE s.TokenHash = @hash`,
    { hash: hashToken(token) },
  )
  // Same answer for a wrong, replaced or deleted link
  if (!row) throw new HttpError(404, 'This signing link is not valid. It may have been replaced by a newer invitation.')
  return row
}

const signerStatus = (s) => (s.Signed ? 'signed' : s.DeclinedAt ? 'declined' : 'pending')

// The signer's view of the contract
async function signingView(me) {
  const signers = await query(
    `SELECT SignerOrder, RoleId, Kind, Name, Signed, SignedAt, DeclinedAt, SignatureImage FROM ${t.ContractSigners} WHERE ContractId = @id ORDER BY SignerOrder`,
    { id: me.ContractId },
  )
  const participants = parseJson(me.ParticipantsJson, [])
  const byRole = new Map(signers.map((s) => [s.RoleId, s]))
  const earlierUnsigned = signers.filter((s) => s.SignerOrder < me.SignerOrder && !s.Signed)
  const pendingReviewers = signers.filter((s) => s.Kind === 'reviewer' && !s.Signed)
  const names = (list) => list.map((s) => s.Name).join(', ')
  const reviewer = me.Kind === 'reviewer'

  let blockedReason = null
  if (me.Status === 'expired') blockedReason = `This contract has expired and can no longer be ${reviewer ? 'reviewed' : 'signed'}.`
  else if (me.Status === 'cancelled') blockedReason = 'The sender has cancelled this contract.'
  else if (me.Status === 'declined' && !me.DeclinedAt) blockedReason = 'Another participant declined or rejected this contract, so it has been stopped.'
  else if (!reviewer && pendingReviewers.length) {
    // Signers always wait for every reviewer, whatever the signing order
    blockedReason = `This document is being reviewed by ${names(pendingReviewers)}. We'll email you when it's ready for your signature.`
  } else if (me.SigningMethod !== 'parallel' && earlierUnsigned.length) {
    blockedReason = `Waiting for ${names(earlierUnsigned)} to ${reviewer ? 'review' : 'sign'} first. We'll email you when it's your turn.`
  }

  const boxes = parseJson(me.BoxesJson, []).map((b) => {
    const owner = byRole.get(b.owner)
    const kind = participants.find((p) => p.id === b.owner)?.kind
    return {
      id: b.id,
      page: b.page,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      mine: b.owner === me.RoleId,
      kind: owner ? 'signer' : kind === 'auto' ? 'auto' : 'other',
      signerOrder: owner?.SignerOrder ?? null,
      label: owner ? owner.Name : kind === 'auto' ? me.OrgName : 'Participant',
      signed: !!owner?.Signed,
    }
  })

  return {
    contract: {
      id: me.ContractId,
      name: me.ContractName,
      organisation: me.OrgName,
      sender: me.SenderName,
      status: me.Status,
      signingMethod: me.SigningMethod,
      expiresAt: me.ExpiresAt,
      completedAt: me.CompletedAt,
    },
    // kind 'reviewer': canSign means the reviewer may approve or reject now
    me: { order: me.SignerOrder, kind: me.Kind, name: me.Name, email: me.Email, status: signerStatus(me), signedAt: me.SignedAt },
    canSign: !me.Signed && !me.DeclinedAt && !blockedReason && me.Status === 'incomplete',
    blockedReason: me.Signed || me.DeclinedAt ? null : blockedReason,
    signers: signers.map((s) => ({ order: s.SignerOrder, kind: s.Kind, name: s.Name, status: signerStatus(s), signedAt: s.SignedAt })),
    // Signatures already adopted, shown in their boxes
    signatures: Object.fromEntries(signers.filter((s) => s.Signed && s.SignatureImage).map((s) => [s.SignerOrder, s.SignatureImage])),
    boxes,
    hasSignedDocument: me.Status === 'completed',
  }
}

// GET /api/sign/:token
router.get(
  '/:token',
  handle(async (req, res) => {
    const me = await findSigner(req.params.token)
    if (!me.ViewedAt && me.Status === 'incomplete') {
      const marked = await query(
        `UPDATE ${t.ContractSigners} SET ViewedAt = SYSUTCDATETIME() OUTPUT inserted.Id
         WHERE ContractId = @id AND SignerOrder = @order AND ViewedAt IS NULL`,
        { id: me.ContractId, order: me.SignerOrder },
      )
      if (marked.length) await logEvent(query, { contractId: me.ContractId, signerOrder: me.SignerOrder, event: 'viewed', detail: 'Opened the signing link', req })
    }
    res.json(await signingView(me))
  }),
)

// GET /api/sign/:token/document
router.get(
  '/:token/document',
  handle(async (req, res) => {
    const me = await findSigner(req.params.token)
    let file
    if (me.Status === 'completed') {
      const signed = await ensureSignedDocument(me.ContractId)
      file = { FileName: signed.fileName, Data: signed.data }
    } else {
      ;[file] = await query(`SELECT FileName, Data FROM ${t.ContractDocuments} WHERE ContractId = @id AND Kind = N'original'`, { id: me.ContractId })
    }
    if (!file) throw notFound('Document')
    res.set('Content-Type', 'application/pdf')
    res.set('Cache-Control', 'no-store')
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.FileName)}`)
    res.send(file.Data)
  }),
)

// POST /api/sign/:token/sign  { signature: "data:image/png;base64,...", type: "draw" | "type", consent: true }
router.post(
  '/:token/sign',
  handle(async (req, res) => {
    const me = await findSigner(req.params.token)
    const { signature, type, consent } = req.body ?? {}
    if (consent !== true) throw badRequest('Please agree to sign electronically')
    if (!['draw', 'type'].includes(type)) throw badRequest('Signature type must be draw or type')
    if (typeof signature !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) throw badRequest('The signature image is not valid')
    if (signature.length > MAX_SIGNATURE_CHARS) throw badRequest('The signature image is too large')

    if (me.Kind === 'reviewer') throw new HttpError(409, 'Reviewers approve the document instead of signing it.')
    await complete(me, req, {
      set: 'SignatureType = @type, SignatureImage = @signature',
      params: { type, signature: text(signature) },
      event: 'signed',
      detail: `${type === 'type' ? 'Typed' : 'Drew'} and adopted a signature`,
    })
    res.json(await signingView(await findSigner(req.params.token)))
  }),
)

// POST /api/sign/:token/approve  { comment? }  (reviewers only)
router.post(
  '/:token/approve',
  handle(async (req, res) => {
    const me = await findSigner(req.params.token)
    if (me.Kind !== 'reviewer') throw new HttpError(409, 'Only reviewers approve documents. Please sign it instead.')
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 1000) : ''
    await complete(me, req, {
      set: 'ReviewComment = @comment',
      params: { comment: comment || null },
      event: 'approved',
      detail: comment ? `Approved: ${comment}` : 'Approved the document',
    })
    res.json(await signingView(await findSigner(req.params.token)))
  }),
)

/*
 * Marks a signer as signed (or a reviewer as approved), then either finishes the contract or
 * invites whoever is next. `set` adds columns to the update.
 */
async function complete(me, req, { set, params, event, detail }) {
  const view = await signingView(me)
  const done = me.Kind === 'reviewer' ? 'approved' : 'signed'
  if (me.Signed) throw new HttpError(409, `You have already ${done} this document.`)
  if (me.DeclinedAt) throw new HttpError(409, `You ${me.Kind === 'reviewer' ? 'rejected' : 'declined'} this document.`)
  if (!view.canSign) throw new HttpError(409, view.blockedReason || 'This document cannot be completed right now.')

  const completed = await transaction(async (run) => {
    const updated = await run(
      `UPDATE ${t.ContractSigners}
       SET Signed = 1, SignedAt = SYSUTCDATETIME(), SignedIp = @ip, SignedUserAgent = @agent, ${set}
       OUTPUT inserted.Id
       WHERE ContractId = @id AND SignerOrder = @order AND Signed = 0 AND DeclinedAt IS NULL`,
      {
        id: me.ContractId,
        order: me.SignerOrder,
        ip: (req.ip || '').replace(/^::ffff:/, '').slice(0, 64),
        agent: (req.get('user-agent') || '').slice(0, 400),
        ...params,
      },
    )
    if (!updated.length) throw new HttpError(409, `You have already ${done} this document.`)
    await logEvent(run, { contractId: me.ContractId, signerOrder: me.SignerOrder, event, detail, req })
    // Only the request that finishes last gets a row back here, so finalizing happens exactly once
    const finished = await run(
      `UPDATE ${t.Contracts} SET Status = N'completed', CompletedAt = SYSUTCDATETIME()
       OUTPUT inserted.Id
       WHERE Id = @id AND Status = N'incomplete'
         AND NOT EXISTS (SELECT 1 FROM ${t.ContractSigners} WHERE ContractId = @id AND Signed = 0)`,
      { id: me.ContractId },
    )
    return finished.length > 0
  })

  if (completed) {
    await finalizeContract(me.ContractId, req).catch((err) => console.error('[sign] could not finalise contract', me.ContractId, err))
  } else {
    await inviteNext(me.ContractId, req)
  }
}

// POST /api/sign/:token/decline  { reason }
router.post(
  '/:token/decline',
  handle(async (req, res) => {
    const me = await findSigner(req.params.token)
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : ''
    const reviewer = me.Kind === 'reviewer'
    if (!reason) throw badRequest(`Please tell the sender why you are ${reviewer ? 'rejecting' : 'declining'}`)
    if (me.Signed) throw new HttpError(409, `You have already ${reviewer ? 'approved' : 'signed'} this document.`)
    if (me.Status !== 'incomplete') throw new HttpError(409, 'This contract is no longer open for signing.')

    await transaction(async (run) => {
      const updated = await run(
        `UPDATE ${t.ContractSigners} SET DeclinedAt = SYSUTCDATETIME(), DeclineReason = @reason
         OUTPUT inserted.Id WHERE ContractId = @id AND SignerOrder = @order AND Signed = 0 AND DeclinedAt IS NULL`,
        { id: me.ContractId, order: me.SignerOrder, reason },
      )
      if (!updated.length) throw new HttpError(409, 'This contract is no longer open for signing.')
      await run(`UPDATE ${t.Contracts} SET Status = N'declined' WHERE Id = @id AND Status = N'incomplete'`, { id: me.ContractId })
      await logEvent(run, { contractId: me.ContractId, signerOrder: me.SignerOrder, event: reviewer ? 'rejected' : 'declined', detail: reason, req })
    })

    if (me.SenderEmail) {
      await sendSigningDeclined({ to: me.SenderEmail, name: me.SenderName, contractName: me.ContractName, signerName: me.Name, reason, review: reviewer }).catch(
        () => {},
      )
    }
    res.json(await signingView(await findSigner(req.params.token)))
  }),
)

export default router
