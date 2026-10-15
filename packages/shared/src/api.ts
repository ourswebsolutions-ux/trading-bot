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
  /** Optional extra payment details configured on the server (e.g. account or wallet). The app shows its own step-by-step instructions. */
  paymentInstructions: string | null
  referenceCode: string
  /** Whether payment requests can be submitted right now, and exactly why not. */
  payments: PaymentAvailability
}

export interface PaymentAvailability {
  available: boolean
  /** Address the app emails every payment request to (with its Confirm Payment / Cancel Request links). */
  businessEmail: string
  /** Precise reason when unavailable (server configuration). */
  problem: string | null
  /** Machine-readable cause, so the app can show the exact setup steps. */
  problemCode?: 'review_passphrase_missing' | 'business_email_missing' | null
  /** One-time setup command for the server operator, when a setting is missing. */
  setupCommand?: string | null
}

/** Returned when a payment request is created. The app emails these links to businessEmail
 *  through the client's own SMTP connection. Acting on them requires the business's review
 *  passphrase, so holding the links does not let anyone else approve the request. */
export interface CreatedPaymentRequest {
  request: PaymentRequestDto
  review: { confirmUrl: string; cancelUrl: string; expiresAt: string }
  businessEmail: string
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
