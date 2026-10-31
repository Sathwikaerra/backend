# eSign Doc Builder – API

Express + MS SQL Server backend for the eSign Doc Builder frontend (the Vite app in the folder above).

## 1. Prerequisites

- Node.js 20+
- SQL Server 2016 or newer (Express / Developer / Azure SQL all work) with **SQL Server authentication** enabled
  and TCP/IP turned on (SQL Server Configuration Manager → Protocols → TCP/IP → Enabled).

## 2. Configure

```bash
cd backend
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
```

Edit `.env`: set `DB_SERVER`, `DB_USER`, `DB_PASSWORD` (and `DB_INSTANCE=SQLEXPRESS` if you use a named
instance), and a long random `JWT_SECRET`.

## 3. Create the schema and tables

The tables live in their own schema (`eSign` by default, set with `DB_SCHEMA`) inside an **existing**
database (`DB_NAME`); nothing creates a database for you.

Either select your database in SSMS / Azure Data Studio and run [`sql/schema.sql`](sql/schema.sql), **or** let the API do it:

```bash
npm run db:init    # creates schema DB_SCHEMA and all tables inside DB_NAME
npm run db:seed    # optional: demo login admin@demo.com / admin123 + sample templates and contracts
```

Both are safe to run more than once. If you change `DB_SCHEMA`, `db:init` renames the schema in the
script automatically; when running the script by hand, replace `eSign` yourself.

## 4. Run

```bash
npm run dev        # http://localhost:4000/api  (restarts on file changes)
```

Then start the frontend from the project root with `npm run dev`. Vite forwards `/api` to port 4000,
so no extra frontend configuration is needed. Check the connection at http://localhost:4000/api/health.

## Tables (all in schema `eSign`)

| Table | Holds |
|---|---|
| `Organisations` | One row per organisation; every other table is scoped to one |
| `Users` | Login accounts (bcrypt password hash, role, last login) |
| `Workflows` | Workflow settings. Nested settings (basic, advanced, eStamp, participants, signature boxes) are JSON columns |
| `WorkflowFiles` | The contract PDF for each workflow (`VARBINARY(MAX)`) |
| `WorkflowVersions` | A snapshot on every save, shown in "Version History" |
| `Templates` | Word-style template document (HTML), page setup and signing setup |
| `Contracts` | A workflow initiated for real signers, with a snapshot of its signers and boxes; "expired" is computed from `ExpiresAt` |
| `ContractSigners` | Each reviewer and signer, in order (`Kind`): link token hash, invited / viewed / signed (approved) / declined (rejected) times, signature image, review comment, IP |
| `ContractDocuments` | The PDF the signers saw (`original`) and the final PDF with signatures and certificate (`signed`) |
| `ContractEvents` | Audit trail (created, invited, viewed, signed, declined, completed, cancelled) |
| `EmailOtps` | One-time login / signup codes (hashed), deleted once used |
| `ApiKeys` | Keys for the public API (`/api/v1`); only a SHA-256 of each key is stored |
| `Webhooks` | One webhook URL and signing secret per organisation |
| `WebhookDeliveries` | Each webhook sent: event, attempts, the receiver's status code or error (kept 30 days) |

Existing databases: run `npm run db:migrate` to apply [`sql/migrations`](sql/migrations) (safe to re-run).

## Signing flow

1. **Initiate** (`POST /api/contracts`): the workflow's PDF, signers and boxes are copied into the contract,
   so later workflow edits never change it. The first signer (sequential) or every signer (parallel) is emailed a private link.
   If the workflow has **reviewers**, they are invited first instead (one by one, or all at once for parallel).
   A reviewer opens the same page, reads the document and **approves** (optional comment) or **rejects** (with a reason,
   which stops the contract). Signers are invited only once every reviewer has approved.
2. **Sign** (public page `/sign/<token>`, no account needed): the signer reviews the PDF, draws or types a signature,
   agrees, and finishes. The next signer is then invited automatically.
3. **Complete**: when the last signer signs, the signatures are stamped into their boxes, a certificate of completion
   (signers, times, IPs, document SHA-256, audit trail) is appended, and the signed PDF is emailed to everyone.

Only a SHA-256 hash of each link token is stored. "Resend link" issues a new link and the old one stops working.
Links point to `APP_URL` if set, otherwise to the frontend the request came from (when it is in `CORS_ORIGIN`).

## API

All routes except auth, health and `/api/sign/*` need `Authorization: Bearer <token>` (returned by login).
Errors are returned as `{ "error": "message" }` with a matching HTTP status.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | database status |
| POST | `/api/auth/signup` | `{ name, email, password, organisationName? }` | `{ user }` (201) |
| POST | `/api/auth/login` | `{ email, password }` | `{ token, user }` |
| GET | `/api/auth/me` | | `{ user }` |
| GET | `/api/workflows` | `?status=active\|inactive\|draft` | workflows |
| GET | `/api/workflows/:id` | | workflow with `versions` |
| POST | `/api/workflows` | multipart: `data` (JSON), `status`, `file` (PDF) | workflow (201) |
| PUT | `/api/workflows/:id` | multipart, same as POST (file optional) | workflow |
| PATCH | `/api/workflows/:id/status` | `{ status }` | workflow |
| DELETE | `/api/workflows/:id` | | 204 |
| POST | `/api/workflows/import` | exported workflow JSON | draft workflow (201) |
| GET | `/api/workflows/:id/file` | | the PDF |
| GET | `/api/templates` | | templates |
| GET | `/api/templates/:id` | | template |
| POST | `/api/templates` | template JSON | template (201) |
| PUT | `/api/templates/:id` | template JSON | template |
| DELETE | `/api/templates/:id` | | 204 |
| GET | `/api/contracts` | `?from=&to=` (optional dates) | contracts with signers |
| POST | `/api/contracts` | `{ workflowId, signers: [{ name, email }], reviewers?: [{ name, email }] }` | contract + `invites` (201); emails the first link(s) |
| GET | `/api/contracts/:id` | | contract with signers, `events`, `documents` |
| GET | `/api/contracts/:id/document` | `?kind=original\|signed` | the PDF (signed once completed) |
| POST | `/api/contracts/:id/signers/:order/resend` | | `{ link, emailed, error }`; the old link stops working |
| POST | `/api/contracts/:id/cancel` | | contract |
| GET | `/api/sign/:token` | | what the signer sees: contract, their boxes, progress (public) |
| GET | `/api/sign/:token/document` | | the PDF (public) |
| POST | `/api/sign/:token/sign` | `{ signature: PNG data URL, type: draw\|type, consent: true }` | updated view (public) |
| POST | `/api/sign/:token/approve` | `{ comment? }` (reviewers only) | updated view (public) |
| POST | `/api/sign/:token/decline` | `{ reason }` (a reviewer's decline is a rejection) | updated view (public) |
| POST | `/api/translate` | `{ texts: string[], target: 'hi', source? }` | `{ translations, provider }` (template editor: Review > Translate) |

**Translation:** set `GOOGLE_TRANSLATE_API_KEY` (Google Cloud Translation API; the first 500,000 characters a month are free)
for reliable use. Without it, Google's free public endpoint is used: fine for trying the feature, but it is
unofficial and refuses requests for a few minutes after bursts of traffic.

Every query is parameterised and filtered by the signed-in user's organisation.

## Public API for other systems (`/api/v1`)

Other systems (a loan system, an HR system) start contracts without logging in. Create a key on the
**Developers** page of the app and send it as `X-API-Key: esk_...` (`X-Auth-Token` and `Authorization: Bearer esk_...`
are accepted too). A key acts for its organisation; revoking it stops it at once.

One workflow is set up once in the app (signer roles, order, signature boxes, expiry). Each call then sends its own PDF and people:

```http
POST /api/v1/contracts
X-API-Key: esk_...
Content-Type: application/json

{
  "workflowId": "a2e5920d212a99f4a13e681c",
  "name": "Home loan - Ravi Kumar",
  "externalRef": "LOAN-1001",
  "document": { "fileName": "loan-ravi.pdf", "base64": "JVBERi0x..." },
  "reviewers": [{ "name": "Officer Rao", "email": "officer@yourco.com" }],
  "signers": [{ "name": "Ravi Kumar", "email": "ravi@example.com", "phone": "9876543210" }],
  "sendEmails": false
}
```

- `document` is optional; without it the workflow's PDF is used. Signature boxes keep the workflow's positions,
  so send PDFs with the same layout. A PDF with fewer pages than the boxes need is refused (`GET /api/v1/workflows` shows `minPages`).
  Up to 15 MB; password-protected PDFs are refused.
- `reviewers` / `signers` must match the workflow's roles, in order. Emails must all differ. `phone` is optional (8-15 digits).
- `sendEmails: false`: nothing is emailed and the response has a `signingLink` for **every** participant. Someone whose turn
  has not come sees "waiting for ..." until it does. Default (`true`): we email links as usual and the response has links only
  for whoever was invited now; later ones arrive in the `invited` webhook.
- `externalRef` is your own id. Sending one that exists returns `409` with `contractId`, so retries never create duplicates.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/workflows` | active workflows with their reviewer / signer roles and `minPages` |
| POST | `/api/v1/contracts` | contract with `participants[]` (`signingLink` as above) (201) |
| GET | `/api/v1/contracts?externalRef=&status=` | up to 100 contracts, newest first |
| GET | `/api/v1/contracts/:id` | status of the contract and each participant (`waiting`, `invited`, `viewed`, `signed`, `declined`; reviewers `approved` / `rejected`) |
| GET | `/api/v1/contracts/:id/events` | audit trail |
| GET | `/api/v1/contracts/:id/document` | `?kind=original\|signed` and `&format=base64` for JSON; the PDF otherwise. `signed` once completed |
| POST | `/api/v1/contracts/:id/signers/:order/link` | `{ order, signingLink }`: a new link; the old one stops working |
| POST | `/api/v1/contracts/:id/cancel` | the cancelled contract |
| POST | `/api/v1/tools/pdf-to-base64` | `{ fileName, sizeBytes, pages, base64 }` for a PDF sent as form field `file`, or as the raw body with `Content-Type: application/pdf` (`?fileName=`) |

**Getting the base64 of a PDF.** Most languages do it in one line (C#: `Convert.ToBase64String(File.ReadAllBytes(path))`,
Node: `fs.readFileSync(path).toString('base64')`). Otherwise:

- `npm run pdf:base64 -- C:\docs\loan.pdf --json` writes `loan.base64.txt` and `loan.document.json` (`{ fileName, base64 }`,
  ready to paste as `document`) next to the PDF.
- `curl -X POST -H "X-API-Key: esk_..." -F "file=@loan.pdf" http://localhost:4000/api/v1/tools/pdf-to-base64`
  (signed-in users: `POST /api/developer/pdf-to-base64`).
- In code: `import { pdfToBase64 } from './src/pdf.js'`; `await pdfToBase64('loan.pdf')`.

All three check that the file is a readable, unprotected PDF of at most 15 MB, and report its page count.

## Webhooks

Set one URL per organisation on the Developers page (`https://`, or `http://localhost` while developing).
Every contract event is POSTed as JSON: `created`, `invited`, `viewed`, `approved`, `signed`, `rejected`, `declined`,
`completed`, `cancelled`, `reminded`, `link_reissued` (and `ping` from "Send test").

```json
{
  "id": "delivery id", "event": "signed", "occurredAt": "2026-10-28T13:09:50.000Z",
  "contract": { "id": "...", "externalRef": "LOAN-1001", "name": "...", "workflowId": "...", "source": "api", "status": "incomplete", "expiresAt": "...", "completedAt": null },
  "signer": { "order": 2, "kind": "signer", "name": "Ravi Kumar", "email": "ravi@example.com", "phone": "9876543210", "status": "signed", "signedAt": "..." },
  "detail": "Drew and adopted a signature"
}
```

On `invited` (when we email the link) `signer.signingLink` is included. Headers: `X-Esign-Event`, `X-Esign-Delivery`,
`X-Esign-Timestamp` and `X-Esign-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>` with the webhook secret.
Verify it, and reject old timestamps. Answer 2xx within 10 s; otherwise we retry after 5 s and 30 s. Webhooks are sent
after the change is saved and never slow down signing. When `completed` arrives, fetch the signed PDF from
`/api/v1/contracts/:id/document?kind=signed`.

### Built-in sample receiver

To try webhooks without writing a receiver, set the webhook URL to `http://localhost:4000/api/webhook-receiver`.
It plays the part of a loan system: it checks the signature, logs each event in the console, and on `completed` saves the
signed PDF to `backend/webhook-inbox/<externalRef>-signed.pdf`. `GET /api/webhook-receiver` (signed in) lists the latest
events it received for your organisation. They are kept in memory only, so a restart clears them.

## Signing methods

Each signer is asked to verify themselves with the method(s) the workflow gives them, in a window of its own on the
signing page (`POST /api/sign/:token/verify/start` then `/verify/complete`; `/sign` spends the verified check):

| Method | What the signer does | Signature |
|---|---|---|
| `CLICKWRAP` | Types their name and clicks "I agree" | Generated stamp |
| `SMART_ESIGN` | Enters a code emailed to them (texted too when a phone is known; SMS prints to the console for now) | Drawn or typed |
| `AADHAAR_OTP` | Aadhaar number + consent, then the OTP sent to the Aadhaar-linked mobile | Generated stamp with masked Aadhaar |
| `AADHAAR_FINGERPRINT` | Aadhaar number + consent, then a fingerprint scan | Generated stamp |
| `AADHAAR_FACE` | Aadhaar number + consent, then a live photo from the camera (kept with the audit record) | Generated stamp |
| `DSC_TOKEN` | Picks the certificate on their USB token and enters its PIN | Generated stamp |

`ESIGN_MODE=sandbox` (the default) imitates the Aadhaar eSign provider and the DSC token: the Aadhaar OTP is shown on the
page and printed in the console, any fingerprint or photo is accepted and the token holds one test certificate. Signatures
made this way say `[sandbox]` in the certificate. Real Aadhaar eSign needs a licensed eSign Service Provider (ESP) and real
DSC signing needs the signer's token utility; they plug into `provider` in `src/verification.js`. Until then
`ESIGN_MODE=live` turns those methods off (HTTP 501).

The certificate of completion and `GET /api/v1/contracts/:id` (`signedWith`, `verification`) show the method used and what
was checked. Only a hash of an OTP and the last 4 digits of an Aadhaar number are stored.

### Location and live photo

In the workflow's signer setup ("More Options" > Capture while signing) a signer can be asked for their **GPS location**
and a **live photo** from the camera. The signing page then adds those steps before the consent, and `/sign` refuses to
sign without them (`location: { lat, lng, accuracy }`, `photo: "data:image/jpeg;base64,..."`). Both are kept on the signer
(`LocationJson`, `PhotoImage`), written to the audit trail, and shown on the certificate of completion (coordinates with a
map link, and the photo). The sender sees them on the contract page; `GET /api/v1/contracts/:id` returns `location` and
`photoCaptured`, and the photo itself is at `GET /api/v1/contracts/:id/signers/:order/photo`.
