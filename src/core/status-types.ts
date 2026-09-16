/**
 * Generic, node-free status contract shared by every driver's host status
 * route and its browser card.
 *
 * The shape is deliberately the common subset of "signed in / signed out,
 * optional quota, optional promo-model badges" — drivers omit whatever their
 * platform does not expose (for example a platform with no balance endpoint
 * simply never sets `credits`). A driver with genuinely different
 * information renders it through its own card instead of stretching this
 * type.
 *
 * @module dsh-llm-bridge/core/status-types
 */

/** One quota package and its remaining amount. */
export interface DriverWebCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated quota answer rendered by the plugin card. */
export interface DriverWebCredits {
  total: number
  accounts: readonly DriverWebCreditAccount[]
}

/** Billing/offer facts for one model, rendered as card badges. */
export interface DriverWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free. */
  free?: boolean
  /** Promotional badges in the platform's own spelling. */
  badges?: readonly string[]
  /** Rate/multiplier in a language-neutral display form, e.g. `x0.79`. */
  credits?: string
}

/** The JSON document any driver status card renders. */
export type DriverWebStatus =
  | { status: 'signed-out' }
  | {
    status: 'signed-in'
    /** Optional account label (never carry secrets or raw PII like phone numbers). */
    nickname?: string
    /** Access-credential expiry, epoch milliseconds. */
    expiresAt?: number
    /** Session-state refresh time, epoch milliseconds (platforms without expiring tokens). */
    updatedAt?: number
    credits?: DriverWebCredits
    creditsError?: string
    /** Offer facts for the models the driver serves. */
    models?: readonly DriverWebModelBadge[]
  }
  | { status: 'error'; message: string }
