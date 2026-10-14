import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { SCREENSHOT_MAX_BYTES } from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { registerReviewRoutes } from './review.js'
import { registerApiRoutes } from './api.js'

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }
      : false,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 256 * 1024
  })

  await app.register(cookie)
  await app.register(formbody, { bodyLimit: 32 * 1024 })
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: SCREENSHOT_MAX_BYTES, files: 1, fields: 8, fieldSize: 4096, parts: 10 }
  })
  await app.register(rateLimit, { global: false })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    if (ctx.config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    // Route-specific values (e.g. the sandboxed evidence response) take precedence.
    if (request.url.startsWith('/review')) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store')
      if (!reply.hasHeader('Content-Security-Policy')) {
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
        )
      }
    }
    return payload
  })

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, fields: err.fields } })
    }
    const status = (err as { statusCode?: number }).statusCode
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } })
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: err instanceof Error ? err.message : 'Bad request' } })
    }
    request.log.error({ err }, 'unhandled error')
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } })
  })

  app.get('/healthz', async () => ({ ok: true }))
  await registerApiRoutes(app, ctx)
  await registerReviewRoutes(app, ctx)
  return app
}
