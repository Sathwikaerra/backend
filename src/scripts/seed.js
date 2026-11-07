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
    ['Mutual NDA', 'A template for a mutual non-disclosure agreement.', 'nda'],
    ['Loan Agreement', 'A template for a loan agreement.', 'loan-agreement'],
    ['Offer Letter', 'A template for an employment offer.', 'offer-letter'],
  ]
  for (const [name, description, docId] of templates) {
    await query(
      `INSERT INTO ${t.Templates} (Id, OrganisationId, Name, Description, ContentHtml, PageSetupJson, CreatedBy)
       VALUES (@id, @orgId, @name, @description, @content, @pageSetup, @userId)`,
      { id: newId(), orgId, name, description, content: text(doc(docId)), pageSetup: PAGE_SETUP, userId },
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
