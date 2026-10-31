import { binary, query, text, transaction, t } from './db.js'
import { checkPdf } from './pdf.js'
import { STATUS_SQL, inviteNext, issueLink, logEvent, sha256 } from './signing.js'
import { EMAIL_RE, HttpError, badRequest, computeExpiry, newId, notFound, requireString } from './utils.js'

/*
 * Contracts shared by the app (routes/contracts.js) and the public API (routes/v1.js).
 */

const signerStatus = (r) => (r.Signed ? 'signed' : r.DeclinedAt ? 'declined' : r.ViewedAt ? 'viewed' : r.InvitedAt ? 'invited' : 'waiting')

export async function loadContracts(where, params) {
  const rows = await query(
    `SELECT c.Id, c.WorkflowId, c.Name, c.WorkflowName, c.Estamping, c.SigningMethod, ${STATUS_SQL} AS Status,
            c.CreatedAt, c.ExpiresAt, c.CompletedAt, c.CancelledAt, c.Source, c.ExternalRef, c.Notify,
            s.SignerOrder, s.Kind, s.Name AS SignerName, s.Email, s.Phone, s.Method, s.SignedMethod, s.Verification, s.Signed, s.SignedAt,
            s.InvitedAt, s.ViewedAt, s.DeclinedAt, s.DeclineReason, s.ReviewComment
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
        source: r.Source,
        externalRef: r.ExternalRef,
        notify: r.Notify,
        createdAt: r.CreatedAt,
        expiresAt: r.ExpiresAt,
        completedAt: r.CompletedAt,
        cancelledAt: r.CancelledAt,
        signers: [],
      })
    }
    if (r.SignerOrder != null) {
      // Reviewers are listed here too (kind 'reviewer'): "signed" means approved, "declined" means rejected
      byId.get(r.Id).signers.push({
        order: r.SignerOrder,
        kind: r.Kind,
        reviewComment: r.ReviewComment,
        name: r.SignerName,
        email: r.Email,
        phone: r.Phone,
        method: r.Method,
        signedMethod: r.SignedMethod,
        verification: r.Verification,
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

export async function loadContract(id, orgId) {
  const [contract] = await loadContracts('c.Id = @id AND c.OrganisationId = @orgId', { id, orgId })
  if (!contract) throw notFound('Contract')
  return contract
}

// Stops an open contract; links stop working for everyone
export async function cancelContract(id, orgId, req, detail = 'Cancelled by the sender') {
  const contract = await loadContract(id, orgId)
  const rows = await query(
    `UPDATE ${t.Contracts} SET Status = N'cancelled', CancelledAt = SYSUTCDATETIME()
     OUTPUT inserted.Id WHERE Id = @id AND Status = N'incomplete' AND ExpiresAt >= SYSUTCDATETIME()`,
    { id: contract.id },
  )
  if (!rows.length) throw new HttpError(409, `This contract is ${contract.status}`)
  await logEvent(query, { contractId: contract.id, event: 'cancelled', detail, req })
  return loadContract(contract.id, orgId)
}

const PHONE_RE =/^\+?[0-9]{8,15}$/

// Checks the people entered for one kind of role; `label` is used in error messages
function cleanPeople(list, roles, label) {
  const people = Array.isArray(list) ? list : []
  if (people.length !== roles.length) throw badRequest(`This workflow needs exactly ${roles.length} ${label}(s)`)
  return people.map((p, i) => {
    const email = requireString(p?.email, `Email of ${label} ${i + 1}`, { max: 320 }).toLowerCase()
    if (!EMAIL_RE.test(email)) throw badRequest(`Enter a valid email for ${label} ${i + 1}`)
    let phone = null
    if (p?.phone != null && String(p.phone).trim() !== '') {
      phone = String(p.phone).replace(/[\s()-]/g, '')
      if (!PHONE_RE.test(phone)) throw badRequest(`Phone of ${label} ${i + 1} must be 8-15 digits, optionally starting with +`)
    }
    return { name: requireString(p?.name, `Name of ${label} ${i + 1}`), email, phone, method: roles[i].methods?.[0] ?? null, methods: (roles[i].methods ?? []).join(',') || null, roleId: String(roles[i].id) }
  })
}

// A PDF sent instead of the workflow's: { fileName?, base64 }. Must have every page the signature boxes are on.
async function cleanDocument(doc, boxes) {
  if (typeof doc !== 'object' || doc === null) throw badRequest('document must be an object: { fileName, base64 }')
  const raw = typeof doc.base64 === 'string' ? doc.base64.replace(/^data:application\/pdf;base64,/, '').replace(/\s/g, '') : ''
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw badRequest('document.base64 must be the PDF encoded as base64')
  const data = Buffer.from(raw, 'base64')
  const pages = await checkPdf(data)
  const needed = Math.max(0, ...boxes.map((b) => Number(b.page) || 0))
  if (pages < needed) throw badRequest(`This workflow places signatures on page ${needed}, but the PDF only has ${pages} page(s)`)
  let fileName = typeof doc.fileName === 'string' ? doc.fileName.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 200) : ''
  if (!fileName) fileName = 'document.pdf'
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf'
  return { fileName, data }
}

/*
 * Creates a contract from an active workflow and invites whoever goes first (reviewers before signers).
 *   document     optional { fileName, base64 } used instead of the workflow's PDF
 *   notify       'email' (we email the links) or 'none' (links are returned for the caller to deliver)
 * Returns { id, invites, links } where links maps each participant's order to their signing link
 * (every participant when notify is 'none'; otherwise only those invited just now).
 */
export async function createContract(
  { orgId, userId, workflowId, signers, reviewers, document = null, name = null, externalRef = null, notify = 'email', source = 'app' },
  req,
) {
  workflowId = requireString(workflowId, 'workflowId', { max: 32 })
  const [wf] = await query(
    `SELECT w.Name, w.Status, w.SigningMethod, w.BasicJson, w.ParticipantsJson, w.BoxesJson, f.FileName, f.Data
     FROM ${t.Workflows} w LEFT JOIN ${t.WorkflowFiles} f ON f.WorkflowId = w.Id
     WHERE w.Id = @workflowId AND w.OrganisationId = @orgId`,
    { workflowId, orgId },
  )
  if (!wf) throw notFound('Workflow')
  if (wf.Status !== 'active') throw new HttpError(409, 'Only active workflows can be initiated')

  const basic = JSON.parse(wf.BasicJson)
  const participants = JSON.parse(wf.ParticipantsJson)
  const boxes = JSON.parse(wf.BoxesJson || '[]')
  const file = document ? await cleanDocument(document, boxes) : wf.Data ? { fileName: wf.FileName, data: wf.Data } : null
  if (!file) throw new HttpError(409, 'This workflow has no document. Upload a PDF to it, or send one in the request.')

  const reviewerList = cleanPeople(reviewers, participants.filter((p) => p.kind === 'reviewer'), 'reviewer').map((r) => ({ ...r, method: null, methods: null, kind: 'reviewer' }))
  const signerList = cleanPeople(signers, participants.filter((p) => p.kind === 'signer'), 'signer').map((s) => ({ ...s, kind: 'signer' }))
  const clean = [...reviewerList, ...signerList]
  if (new Set(clean.map((s) => s.email)).size !== clean.length) throw badRequest('Each reviewer and signer needs a different email address')

  const title = name != null && String(name).trim() ? requireString(name, 'name') : (basic.contractName || wf.Name).slice(0, 200)
  const ref = externalRef != null && String(externalRef).trim() ? requireString(String(externalRef), 'externalRef', { max: 100 }) : null
  if (ref) {
    // Lets callers retry safely: the same reference never creates a second contract
    const [dup] = await query(`SELECT Id FROM ${t.Contracts} WHERE OrganisationId = @orgId AND ExternalRef = @ref`, { orgId, ref })
    if (dup) throw Object.assign(new HttpError(409, `A contract with externalRef "${ref}" already exists`), { contractId: dup.Id })
  }

  const id = newId()
  const now = new Date()
  await transaction(async (run) => {
    await run(
      `INSERT INTO ${t.Contracts}
         (Id, OrganisationId, WorkflowId, Name, WorkflowName, Estamping, CreatedBy, CreatedAt, ExpiresAt,
          SigningMethod, ParticipantsJson, BoxesJson, EmailSubject, Source, ExternalRef, Notify)
       VALUES (@id, @orgId, @workflowId, @name, @workflowName, @estamping, @userId, @now, @expiresAt,
          @signingMethod, @participants, @boxes, @subject, @source, @ref, @notify)`,
      {
        id,
        orgId,
        workflowId,
        name: title,
        workflowName: wf.Name,
        estamping: basic.stampingMethod || null,
        userId,
        now,
        expiresAt: computeExpiry(basic.expiryValue, basic.expiryUnit, now),
        signingMethod: wf.SigningMethod === 'parallel' ? 'parallel' : 'sequential',
        participants: text(JSON.stringify(participants)),
        boxes: text(JSON.stringify(boxes)),
        subject: basic.emailSubject ? String(basic.emailSubject).slice(0, 300) : null,
        source: source === 'api' ? 'api' : 'app',
        ref,
        notify: notify === 'none' ? 'none' : 'email',
      },
    )
    // The signers sign this exact copy, even if the workflow's PDF is replaced later
    await run(
      `INSERT INTO ${t.ContractDocuments} (ContractId, Kind, FileName, SizeBytes, Sha256, Data)
       VALUES (@id, N'original', @fileName, @size, @hash, @data)`,
      { id, fileName: file.fileName, size: file.data.length, hash: sha256(file.data), data: binary(file.data) },
    )
    for (const [i, s] of clean.entries()) {
      await run(
        `INSERT INTO ${t.ContractSigners} (ContractId, SignerOrder, RoleId, Kind, Name, Email, Phone, Method, Methods)
         VALUES (@id, @order, @roleId, @kind, @name, @email, @phone, @method, @methods)`,
        { id, order: i + 1, ...s },
      )
    }
    const how = source === 'api' ? 'through the API' : 'in the app'
    await logEvent(run, { contractId: id, event: 'created', detail: `Initiated ${how} from workflow "${wf.Name}"${document ? ` with ${file.fileName}` : ''}`, req })
  })

  const links = {}
  if (notify === 'none') {
    // Everyone gets their link now; people whose turn has not come see "waiting for ..." until it does
    for (const i of clean.keys()) links[i + 1] = await issueLink(id, i + 1, req)
  }
  const invites = await inviteNext(id, req)
  for (const inv of invites) if (inv.link) links[inv.order] = inv.link
  return { id, invites, links }
}
