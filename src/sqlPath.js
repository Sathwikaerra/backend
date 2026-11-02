import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Finds the sql folder at runtime, so the migration scripts work both from source
 * (backend/sql) and from the bundled, obfuscated build (dist/sql, copied by webpack).
 * Searches upward from the working directory first, then from this file's location.
 */
export function resolveSql(...segments) {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'sql', ...segments)
      if (existsSync(candidate)) return candidate
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  // Last resort: alongside the running file (dist/sql/...), even if it does not exist yet
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql', ...segments)
}
