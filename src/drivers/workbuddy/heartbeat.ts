/**
 * WorkBuddy driver heartbeat: binds the core heartbeat mechanism to this
 * driver's file name and the package marker. The file name stays
 * WorkBuddy-scoped (`.workbuddy-host-heartbeat.json`) so a future second
 * driver never collides on the same file; the package marker follows the
 * renamed package.
 *
 * @module dsh-llm-bridge/drivers/workbuddy/heartbeat
 */

import {
  createHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
} from '../../core/heartbeat.ts'
import type { HostHeartbeat } from '../../core/heartbeat.ts'
import { BRIDGE_VERSION } from '../../core/version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const WORKBUDDY_HOST_HEARTBEAT_FILENAME = '.workbuddy-host-heartbeat.json'

/** On-disk shape of the heartbeat. */
export type WorkBuddyHostHeartbeat = HostHeartbeat

const heartbeat = createHostHeartbeat(
  {
    fileName: WORKBUDDY_HOST_HEARTBEAT_FILENAME,
    packageName: 'dsh-llm-bridge',
  },
  BRIDGE_VERSION,
)

/** Absolute path of the host heartbeat file. */
export const workbuddyHostHeartbeatPath = heartbeat.path

/** Write (or overwrite) the heartbeat after the host registered the provider. */
export const writeHostHeartbeat = heartbeat.write

/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
export const clearHostHeartbeat = heartbeat.clear

/** Read and validate the heartbeat; `undefined` when absent or malformed. */
export const readHostHeartbeat = heartbeat.read

export { isHeartbeatProcessAlive, processStartTimeMs }
