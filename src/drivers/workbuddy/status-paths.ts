/** WorkBuddy card contract: the status route path and its document shape.
 *  Node-free so the browser card can import it directly. */

import type { DriverWebStatus } from '../../core/status-types.ts'

/** Plugin-owned status endpoint consumed by the WorkBuddy browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-llm-bridge/workbuddy/status'

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /** Credits multiplier in display form, e.g. `x0.79`. */
  credits?: string
}

/** The JSON document the WorkBuddy plugin card renders. */
export type WorkBuddyWebStatus =
  | { status: 'signed-out' }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    models?: readonly WorkBuddyWebModelBadge[]
  }
  | { status: 'error'; message: string }

// Structural compatibility with the generic card document is intentional and
// checked in the driver's web-status builder.
export type { DriverWebStatus }
