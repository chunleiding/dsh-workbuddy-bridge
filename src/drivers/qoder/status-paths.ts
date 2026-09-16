/** Qoder card contract: the status route path and its document shape. */

import type { DriverWebStatus } from '../../core/status-types.ts'

/** Plugin-owned status endpoint consumed by the Qoder browser card. */
export const QODER_STATUS_PATH = '/plugins/dsh-llm-bridge/qoder/status'

/** The JSON document the Qoder plugin card renders (the generic shape). */
export type QoderWebStatus = DriverWebStatus
