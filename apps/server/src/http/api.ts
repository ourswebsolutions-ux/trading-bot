import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { PlansResponse } from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import { AppError, badRequest } from '../errors.js'
import { buildStatus, computeAccess, issueEntitlementToken } from '../services/access.js'
import { authenticateDevice, registerDevice, type DeviceRow } from '../services/devices.js'
import { createPaymentRequest, listDeviceRequests, listPlans, paymentAvailability, withdrawPaymentRequest, type UploadedScreenshot } from '../services/payments.js'
import { getSetting } from '../services/settings.js'
import { sha256Hex } from '../security/tokens.js'

declare module 'fastify' {
  interface FastifyRequest {
    device?: DeviceRow
  }
}

const RegisterSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/, 'fingerprint must be a sha256 hex digest'),
  platform: z.string().min(1).max(32),
  appVersion: z.string().min(1).max(32)
})

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7).trim()
}

export async function registerApiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireDevice = async (request: FastifyRequest) => {
    const token = bearer(request)
    const device = token ? authenticateDevice(ctx, token) : null
    if (!device) throw new AppError(401, 'unauthorized', 'Device credentials are missing or invalid. Re-register the device.')
    if (device.disabled) throw new AppError(403, 'device_disabled', 'This device has been disabled. Contact support.')
    request.device = device
  }

  app.post('/v1/devices/register', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request) => {
    const parsed = RegisterSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest('Invalid registration payload')
    return registerDevice(ctx, parsed.data, request.ip)
  })

  app.get('/v1/status', { preHandler: requireDevice, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) =>
    buildStatus(ctx, request.device!)
  )

  app.get('/v1/plans', { preHandler: requireDevice }, async (request): Promise<PlansResponse> => ({
    plans: listPlans(ctx),
    paymentInstructions: getSetting(ctx.db, 'payment_instructions'),
    referenceCode: request.device!.reference_code,
    payments: paymentAvailability(ctx)
  }))

  app.get('/v1/payment-requests', { preHandler: requireDevice }, async (request) => ({ requests: listDeviceRequests(ctx, request.device!.id) }))

  app.post(
    '/v1/payment-requests',
    {
      preHandler: requireDevice,
      // keyed per device credential, so users behind one NAT do not throttle each other
      config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: (req: FastifyRequest) => (bearer(req) ? `dev:${sha256Hex(bearer(req)!)}` : req.ip) } }
    },
    async (request, reply) => {
      if (!request.isMultipart()) throw badRequest('Expected multipart/form-data')
      const fields: Record<string, string> = {}
      let screenshot: UploadedScreenshot | null = null
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'screenshot' || screenshot) {
            part.file.resume()
            continue
          }
          const bytes = await part.toBuffer()
          screenshot = { bytes, originalName: part.filename || null, truncated: part.file.truncated }
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value
        }
      }
      const created = await createPaymentRequest(
        ctx,
        request.device!,
        { planCode: fields.planCode ?? '', transactionId: fields.transactionId ?? '', contactEmail: fields.contactEmail, note: fields.note },
        screenshot,
        request.ip
      )
      return reply.status(201).send(created)
    }
  )

  /** The app withdraws its own undecided request when it could not email it to the business address. */
  app.delete('/v1/payment-requests/:id', { preHandler: requireDevice, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { reason?: unknown }
    await withdrawPaymentRequest(ctx, request.device!, String(id).slice(0, 64), typeof body.reason === 'string' ? body.reason : 'withdrawn by the app', request.ip)
    return reply.status(204).send()
  })

  /** In-app notifications for this device (approval / cancellation outcomes). */
  app.get('/v1/notifications', { preHandler: requireDevice }, async (request) => {
    const rows = ctx.db.prepare(
      `SELECT id, kind, subject, body, request_id, created_at FROM notifications
       WHERE channel = 'in_app' AND device_id = ? ORDER BY created_at DESC LIMIT 50`
    ).all(request.device!.id) as { id: string; kind: string; subject: string; body: string; request_id: string | null; created_at: string }[]
    return {
      notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.subject, body: r.body, requestId: r.request_id, createdAt: r.created_at }))
    }
  })

  /** Server-side authorization gate for paid features: 402 unless the trial or a subscription is active. */
  app.get('/v1/entitlement', { preHandler: requireDevice }, async (request, reply) => {
    const { now, access } = computeAccess(ctx, request.device!.id)
    const token = issueEntitlementToken(ctx, request.device!.id, access, now)
    if (!access.allowed) {
      return reply.status(402).send({ error: { code: 'payment_required', message: 'Your trial or subscription has ended.' }, entitlementToken: token })
    }
    return { entitlementToken: token, access }
  })
}
