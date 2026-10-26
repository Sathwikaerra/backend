// Runs every script in sql/migrations (in name order) against DB_NAME. Each script is idempotent.
// Usage: npm run db:migrate
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sql from 'mssql'
import { config } from '../config.js'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql/migrations')
const stripComments = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').trim()

try {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const pool = await new sql.ConnectionPool(config.db).connect()
  for (const file of files) {
    const batches = (await fs.readFile(path.join(dir, file), 'utf8'))
      .replace(/\beSign(?=[.'])/g, config.db.schema)
      .split(/^\s*GO\s*$/im)
      .filter((b) => stripComments(b))
    for (const batch of batches) await pool.request().batch(batch)
    console.log(`Applied ${file}`)
  }
  await pool.close()
  console.log(`Migrations complete on [${config.db.schema}] in "${config.db.database}".`)
} catch (err) {
  console.error(`Migration failed: ${err.message}`)
  process.exit(1)
}
