// Creates a demo organisation, the demo login (admin@demo.com / admin123),
// sample templates and a few sample contracts. Safe to re-run.
// Usage: npm run db:seed
import bcrypt from 'bcryptjs'
import { getPool, query, text, t } from '../db.js'
import { computeExpiry, newId } from '../utils.js'
import { STARTER_DOCS } from '../../../src/constants/docTemplates.js'

const DEMO = { name: 'Demo Admin', email: 'admin@demo.com', password: 'admin123', org: 'Demo Organisation' }
const PAGE_SETUP = JSON.stringify({ size: 'A4', orientation: 'portrait', margin: 'normal' })
const doc = (id) => STARTER_DOCS.find((d) => d.id === id).html
const signer = (name, methods) => ({ id: newId().slice(0, 8), kind: 'signer', name, methods, signatureType: 'individual' })

try {
  const [existing] = await query(`SELECT Id, OrganisationId FROM ${t.Users} WHERE Email = @email`, { email: DEMO.email })
  if (existing) {
    console.log(`Demo user ${DEMO.email} already exists; nothing to do.`)
    process.exit(0)
  }

  const orgId = newId()
  const userId = newId()
  await query(`INSERT INTO ${t.Organisations} (Id, Name) VALUES (@orgId, @name)`, { orgId, name: DEMO.org })
  await query(
    `INSERT INTO ${t.Users} (Id, OrganisationId, Name, Email, PasswordHash, Role) VALUES (@userId, @orgId, @name, @email, @hash, N'admin')`,
    { userId, orgId, name: DEMO.name, email: DEMO.email, hash: await bcrypt.hash(DEMO.password, 10) },
  )

  const templates = [
    ['Mutual NDA', 'Two parties sign one after the other with Aadhaar OTP and Clickwrap.', 'nda', [signer('First Party', ['AADHAAR_OTP', 'CLICKWRAP']), signer('Second Party', ['AADHAAR_OTP', 'CLICKWRAP'])], 14, 'days', null],
    ['Loan Agreement', 'Borrower and co-borrower sign with Aadhaar OTP.', 'loan-agreement', [signer('Borrower', ['AADHAAR_OTP']), signer('Co-Borrower', ['AADHAAR_OTP', 'AADHAAR_FINGERPRINT'])], 7, 'days', 'eStamping'],
    ['Offer Letter', 'Employment offer signed by HR and the candidate.', 'offer-letter', [signer('HR Manager', ['SMART_ESIGN']), signer('Candidate', ['AADHAAR_OTP'])], 1, 'weeks', null],
  ]
  for (const [name, description, docId, participants, expiryValue, expiryUnit, stamping] of templates) {
    await query(
      `INSERT INTO ${t.Templates} (Id, OrganisationId, Name, Description, SigningMethod, StampingMethod, ExpiryValue, ExpiryUnit, ParticipantsJson, ContentHtml, PageSetupJson, CreatedBy)
       VALUES (@id, @orgId, @name, @description, N'sequential', @stamping, @expiryValue, @expiryUnit, @participants, @content, @pageSetup, @userId)`,
      { id: newId(), orgId, name, description, stamping, expiryValue, expiryUnit, participants: text(JSON.stringify(participants)), content: text(doc(docId)), pageSetup: PAGE_SETUP, userId },
    )
  }

  // Sample contracts so the dashboard has something to show
  const day = 24 * 3600 * 1000
  const samples = [
    ['Loan Agreement – R. Kumar', 0, 14, 'incomplete', ['AADHAAR_OTP', 'AADHAAR_OTP'], 'eStamping'],
    ['Group Loan – Shakti SHG', 1, 14, 'incomplete', ['AADHAAR_OTP', 'AADHAAR_FINGERPRINT', 'AADHAAR_OTP'], null],
    ['Vendor NDA – Acme Supplies', 2, 14, 'completed', ['AADHAAR_OTP', 'AADHAAR_FACE'], null],
    ['Employment Offer – P. Rao', 3, 14, 'completed', ['AADHAAR_OTP'], null],
    ['Lease Renewal – Unit 4B', 4, 2, 'incomplete', ['AADHAAR_FINGERPRINT', 'AADHAAR_OTP'], null],
  ]
  for (const [name, ageDays, expiresIn, status, methods, estamping] of samples) {
    const id = newId()
    const createdAt = new Date(Date.now() - ageDays * day)
    await query(
      `INSERT INTO ${t.Contracts} (Id, OrganisationId, Name, WorkflowName, Estamping, Status, CreatedBy, CreatedAt, ExpiresAt, CompletedAt)
       VALUES (@id, @orgId, @name, N'Sample', @estamping, @status, @userId, @createdAt, @expiresAt, @completedAt)`,
      { id, orgId, name, estamping, status, userId, createdAt, expiresAt: computeExpiry(expiresIn, 'days', createdAt), completedAt: status === 'completed' ? createdAt : null },
    )
    for (const [i, method] of methods.entries()) {
      await query(
        `INSERT INTO ${t.ContractSigners} (ContractId, SignerOrder, Name, Email, Method, Signed, SignedAt)
         VALUES (@id, @order, @name, @email, @method, @signed, @signedAt)`,
        { id, order: i + 1, name: `Signer ${i + 1}`, email: `signer${i + 1}@example.com`, method, signed: status === 'completed', signedAt: status === 'completed' ? createdAt : null },
      )
    }
  }

  console.log(`Seeded "${DEMO.org}". Log in with ${DEMO.email} / ${DEMO.password}`)
  ;(await getPool()).close()
} catch (err) {
  console.error(`Seed failed: ${err.message}`)
  process.exit(1)
}
