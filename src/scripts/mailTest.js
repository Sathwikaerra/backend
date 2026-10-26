// Sends one test email using the SMTP settings in backend/.env.
// Usage: npm run mail:test -- you@example.com
import { config } from '../config.js'
import { sendTestEmail, verifyMailer } from '../mailer.js'

const to = process.argv[2]
if (!to) {
  console.error('Usage: npm run mail:test -- you@example.com')
  process.exit(1)
}

const check = await verifyMailer()
if (!check.ok) {
  console.error(`SMTP check failed: ${check.reason}`)
  process.exit(1)
}
try {
  await sendTestEmail(to)
  console.log(`Test email sent to ${to} through ${config.mail.host}. Check the inbox (and spam folder).`)
} catch (err) {
  console.error(`Sending failed: ${err.message}`)
  process.exit(1)
}
