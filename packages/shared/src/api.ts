import type { AccessReason, PaymentRequestStatus, PlanCode } from './plans.js'

/** Wire contracts for the TradePilot subscription API (all timestamps are ISO-8601 UTC). */

export interface RegisterDeviceRequest {
  fingerprint: string
  platform: string
  appVersion: string
}

export interface RegisterDeviceResponse {
  deviceId: string
  deviceToken: string
  referenceCode: string
}

export interface PlanDto {
  code: PlanCode
  name: string
  description: string
  priceCents: number
  currency: string
  billing: 'monthly' | 'one_time'
}

export interface PlansResponse {
  plans: PlanDto[]
  paymentInstructions: string | null
  referenceCode: string
}

export interface TrialDto {
  startedAt: string
  endsAt: string
  active: boolean
  remainingMs: number
}

export interface SubscriptionDto {
  planCode: PlanCode
  status: 'active' | 'expired'
  activatedAt: string
  expiresAt: string | null
}

export interface StatusResponse {
  serverTime: string
  deviceId: string
  referenceCode: string
  trial: TrialDto
  subscription: SubscriptionDto | null
  access: { allowed: boolean; reason: AccessReason; until: string | null }
  entitlementToken: string
  pendingRequestId: string | null
}

export interface PaymentRequestDto {
  id: string
  planCode: PlanCode
  amountCents: number
  currency: string
  transactionId: string
  status: PaymentRequestStatus
  createdAt: string
  decidedAt: string | null
  cancellationReason: string | null
  activationId: string | null
}

export interface PaymentRequestListResponse {
  requests: PaymentRequestDto[]
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> }
}

/** Payload signed by the server (Ed25519) and verified by the desktop main process. */
export interface EntitlementPayload {
  v: 1
  deviceId: string
  allowed: boolean
  reason: AccessReason
  planCode: PlanCode | null
  /** Moment access ends according to the server, or null for lifetime. */
  until: string | null
  serverTime: string
  /** Token validity for offline use; the client must refresh before this. */
  exp: string
}
