// Bundles audit log, feature switches, API keys/API v1, AI analytics and retention for index.js.
import fs from 'node:fs'
import { audit, auditMiddleware, auditRoutes } from './audit.js'
import { featureRoutes } from './features.js'
import { apiKeyRoutes } from './apikeys.js'
import { apiV1Router } from './api-v1.js'
import { analyticsRoutes } from './ai/analytics.js'
import { retentionRoutes, startRetention } from './retention.js'

export { apiV1Router, auditMiddleware }

export function platformRoutes(app) {
  auditRoutes(app)
  featureRoutes(app)
  apiKeyRoutes(app)
  analyticsRoutes(app)
  retentionRoutes(app)
}

export function platformStartup() {
  let version = null
  try {
    version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    /* ignore */
  }
  audit({ via: 'system' }, 'system.startup', { details: { version, node: process.version } })
  startRetention()
}
