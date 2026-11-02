import { createApp } from './app.js'
import { config } from './config.js'
import { getPool } from './db.js'
import { verifyMailer } from './mailer.js'

const app = createApp()

app.listen(config.port, () => {
  console.log(`eSign API listening on port ${config.port} (http://localhost:${config.port}/api)`)
  console.log(`Signing links point to ${config.appUrl || 'the frontend that made the request (set APP_URL when deployed)'}`)
  if (config.frontendDist) console.log(`Serving the site from ${config.frontendDist}`)
  // Connect early so a wrong .env shows up in the console right away
  getPool()
    .then(() => console.log(`Connected to SQL Server database "${config.db.database}" on ${config.db.server}`))
    .catch((err) => console.error(`Could not connect to SQL Server: ${err.message}\nCheck the DB_* settings in backend/.env`))
  if (config.mail.host) {
    verifyMailer().then(({ ok, reason }) =>
      ok
        ? console.log(`Email ready: sending through ${config.mail.host} as ${config.mail.from}`)
        : console.error(`Email NOT working (${config.mail.host}): ${reason}\nCheck the SMTP_* settings in backend/.env`),
    )
  }
})
