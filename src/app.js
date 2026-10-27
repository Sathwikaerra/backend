import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { getPool } from './db.js'
import { errorHandler, notFoundRoute, requireAuth } from './middleware.js'
import authRoutes from './routes/auth.js'
import workflowRoutes from './routes/workflows.js'
import templateRoutes from './routes/templates.js'
import contractRoutes from './routes/contracts.js'
import signRoutes from './routes/sign.js'
import translateRoutes from './routes/translate.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // Requests arrive through the Vite proxy in development; trust it for the client IP
  app.set('trust proxy', 'loopback')
  app.use(cors({ origin: config.corsOrigins }))
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
  // Signers open their emailed link without an account
  app.use('/api/sign', signRoutes)

  app.use(notFoundRoute)
  app.use(errorHandler)
  return app
}
