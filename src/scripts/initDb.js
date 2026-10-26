// Creates the schema and all tables from sql/schema.sql inside the EXISTING database DB_NAME.
// Usage: npm run db:init     (safe to re-run)
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sql from 'mssql'
import { config } from '../config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaFile = path.resolve(here, '../../sql/schema.sql')
const { database, schema } = config.db

const stripComments = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').trim()

// The script is written for SSMS with "eSign" as the schema and GO between batches.
// Rename the schema if DB_SCHEMA differs (only identifier uses: eSign.Table, N'eSign', SCHEMA eSign').
const raw = await fs.readFile(schemaFile, 'utf8')
const batches = raw
  .replace(/\beSign(?=[.'])/g, schema)
  .split(/^\s*GO\s*$/im)
  .map((b) => b.trim())
  .filter((b) => {
    const code = stripComments(b)
    return code && !/^USE\s/i.test(code) && !/CREATE\s+DATABASE/i.test(code)
  })

try {
  const pool = await new sql.ConnectionPool(config.db).connect()
  for (const batch of batches) await pool.request().batch(batch)
  const [{ n }] = (
    await pool
      .request()
      .input('schema', schema)
      .query('SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema')
  ).recordset
  await pool.close()
  console.log(`Schema [${schema}] in database "${database}" is ready with ${n} tables. Next: npm run db:seed`)
} catch (err) {
  console.error(`Failed: ${err.message}`)
  if (/Cannot open database/i.test(err.message)) console.error(`Database "${database}" must already exist. Check DB_NAME in backend/.env.`)
  process.exit(1)
}
