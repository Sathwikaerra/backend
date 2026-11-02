import path from 'node:path'
import fs from 'node:fs'
import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { getPool } from './db.js'
import { errorHandler, notFoundRoute, requireApiKey, requireAuth } from './middleware.js'
import authRoutes from './routes/auth.js'
import workflowRoutes from './routes/workflows.js'
import templateRoutes from './routes/templates.js'
import contractRoutes from './routes/contracts.js'
import signRoutes from './routes/sign.js'
import translateRoutes from './routes/translate.js'
import developerRoutes from './routes/developer.js'
import v1Routes from './routes/v1.js'
import webhookReceiverRoutes from './routes/webhookReceiver.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // Requests arrive through a proxy (Vite in development, nginx / IIS when deployed); trust it for the client IP
  app.set('trust proxy', config.trustProxy)
  app.use(cors({ origin: config.corsOrigins }))
  // Sample webhook receiver; mounted before the JSON parser because it checks the signature on the raw body
  app.use('/api/webhook-receiver', webhookReceiverRoutes)
  // Templates can embed images, so allow larger JSON bodies than the default 100 KB
  app.use(express.json({ limit: '20mb' }))

  // Liveness + database check
  app.get('/api/health', async (_req, res) => {
    try {
      await (await getPool()).request().query('SELECT 1 AS ok')
      res.json({ status: 'ok', database: 'connected' })
    } catch (err) {
      res.status(503).json({ status: 'degraded', database: 'unavailable', error: err.message })
    }
  })

  app.use('/api/auth', authRoutes)
  app.use('/api/workflows', requireAuth, workflowRoutes)
  app.use('/api/templates', requireAuth, templateRoutes)
  app.use('/api/contracts', requireAuth, contractRoutes)
  app.use('/api/translate', requireAuth, translateRoutes)
  app.use('/api/developer', requireAuth, developerRoutes)
  // Other systems call this with an API key instead of a login
  app.use('/api/v1', requireApiKey, v1Routes)
  // Signers open their emailed link without an account
  app.use('/api/sign', signRoutes)

  // FRONTEND_DIST: serve the built site as well, so one address runs both (anything not under /api gets index.html)
  if (config.frontendDist) {
    const dist = path.resolve(config.frontendDist)
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      console.warn(`[app] FRONTEND_DIST=${dist} has no index.html. Run npm run build in the frontend first.`)
    } else {
      app.use(express.static(dist, { index: false, maxAge: '1h' }))
      app.get(/^\/(?!api(\/|$)).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
    }
  }

  app.use(notFoundRoute)
  app.use(errorHandler)
  return app
}
