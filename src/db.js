import sql from 'mssql'
import { config } from './config.js'

let poolPromise = null

// Fully qualified table names, e.g. t.Users -> [eSign].[Users]. Use these in every query.
const TABLES = ['Organisations', 'Users', 'Workflows', 'WorkflowFiles', 'WorkflowVersions', 'Templates', 'Contracts', 'ContractSigners', 'ContractDocuments', 'ContractEvents', 'EmailOtps', 'ApiKeys', 'Webhooks', 'WebhookDeliveries']
export const t = Object.freeze(Object.fromEntries(TABLES.map((name) => [name, `[${config.db.schema}].[${name}]`])))

// One shared connection pool for the whole API, created on first use.
export function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config.db).connect().catch((err) => {
      poolPromise = null // allow a retry on the next request
      throw err
    })
  }
  return poolPromise
}

// Long text (JSON, HTML) must be sent as NVARCHAR(MAX) so it is never truncated.
export const text = (value) => ({ type: sql.NVarChar(sql.MAX), value })
export const binary = (value) => ({ type: sql.VarBinary(sql.MAX), value })

// Catches `${t.Something}` that resolved to undefined (typo, or a local variable named t)
function assertTables(statement) {
  const m = statement.match(/\b(FROM|INTO|UPDATE|JOIN)\s+undefined\b/i)
  if (m) throw new Error(`SQL refers to an undefined table after "${m[1]}". Check the t.<Table> names used in this query.`)
}

function bind(request, params) {
  for (const [name, param] of Object.entries(params)) {
    if (param && typeof param === 'object' && 'type' in param && 'value' in param) request.input(name, param.type, param.value)
    else request.input(name, param)
  }
  return request
}

// Runs a parameterised query and returns the rows. Never build SQL from user input.
export async function query(statement, params = {}) {
  assertTables(statement)
  const pool = await getPool()
  const result = await bind(pool.request(), params).query(statement)
  return result.recordset ?? []
}

// Runs fn(run) inside a transaction; run(statement, params) behaves like query().
// run.afterCommit(cb) queues work (e.g. webhooks) that must only happen if the transaction commits.
export async function transaction(fn) {
  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  const afterCommit = []
  await tx.begin()
  try {
    const run = async (statement, params = {}) => {
      assertTables(statement)
      return (await bind(new sql.Request(tx), params).query(statement)).recordset ?? []
    }
    run.afterCommit = (cb) => afterCommit.push(cb)
    const result = await fn(run)
    await tx.commit()
    for (const cb of afterCommit) Promise.resolve().then(cb).catch((err) => console.error('[db] after-commit task failed:', err))
    return result
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
}

export { sql }
