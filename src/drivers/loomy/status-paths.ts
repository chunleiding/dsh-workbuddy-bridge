/** Loomy card contract: the status route path and its document shape. */

import type { DriverWebStatus } from '../../core/status-types.ts'

/** Plugin-owned status endpoint consumed by the Loomy browser card. */
export const LOOMY_STATUS_PATH = '/plugins/dsh-llm-bridge/loomy/status'

/** The JSON document the Loomy plugin card renders (the generic shape). */
export type LoomyWebStatus = DriverWebStatus
