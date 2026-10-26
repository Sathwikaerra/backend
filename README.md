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
| `Contracts` | A workflow initiated for real signers; "expired" is computed from `ExpiresAt` |
| `ContractSigners` | Each signer of a contract, in signing order, with signed status |

## API

All routes except signup, login and health need `Authorization: Bearer <token>` (returned by login).
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
| POST | `/api/contracts` | `{ workflowId, signers: [{ name, email }] }` | contract (201) |
| POST | `/api/contracts/:id/signers/:order/sign` | | contract (marks completed when all signed) |

Every query is parameterised and filtered by the signed-in user's organisation.
