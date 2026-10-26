import 'dotenv/config'

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes'].includes(String(v).toLowerCase()))

export const config = {
  port: Number(process.env.PORT) || 4000,
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  db: {
    server: process.env.DB_SERVER || 'localhost',
    port: process.env.DB_INSTANCE ? undefined : Number(process.env.DB_PORT) || 1433,
    database: process.env.DB_NAME || 'EsignDocBuilder',
    // SQL schema that holds the app's tables (see sql/schema.sql)
    schema: process.env.DB_SCHEMA || 'eSign',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      instanceName: process.env.DB_INSTANCE || undefined,
      encrypt: bool(process.env.DB_ENCRYPT, false),
      trustServerCertificate: bool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  },
  // Outgoing email (for OTP codes). Leave SMTP_HOST empty in development to print codes in the console instead.
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'eSign Doc Builder <no-reply@localhost>',
  },
  otp: {
    length: 6,
    expiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES) || 5,
    maxAttempts: 5,
    resendCooldownSeconds: 30,
    maxResends: 5,
    // Codes one email address may request per 15 minutes
    maxPerWindow: 8,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },
}

// The schema name is put into SQL text, so only allow a plain identifier
if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(config.db.schema)) {
  throw new Error(`DB_SCHEMA "${config.db.schema}" must be a plain name (letters, numbers, underscores).`)
}

if (!config.jwt.secret ||config.jwt.secret === 'change-me-to-a-long-random-string') {
  console.warn('[config] JWT_SECRET is not set to a real secret. Set it in backend/.env before using this beyond local development.')
  config.jwt.secret ||= 'dev-only-insecure-secret'
}
