/**
 * Plan codes are shared between client and server. Prices are deliberately NOT
 * defined here: the server database is the only source of truth for pricing,
 * and the desktop app renders whatever the server returns.
 */
export const PLAN_CODES = ['monthly', 'lifetime'] as const
export type PlanCode = (typeof PLAN_CODES)[number]

export const TRIAL_DURATION_HOURS = 72
export const TRIAL_DURATION_MS = TRIAL_DURATION_HOURS * 60 * 60 * 1000

export type PaymentRequestStatus = 'pending' | 'approved' | 'cancelled'

export type AccessReason = 'trial' | 'subscription' | 'trial_expired' | 'subscription_expired' | 'none'
