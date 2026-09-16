/**
 * Loomy driver heartbeat: binds the core heartbeat mechanism to the
 * driver's file name so it never collides with another driver's file.
 *
 * @module dsh-llm-bridge/drivers/loomy/heartbeat
 */

import { createHostHeartbeat, isHeartbeatProcessAlive, processStartTimeMs } from '../../core/heartbeat.ts'
import type { HostHeartbeat } from '../../core/heartbeat.ts'
import { BRIDGE_VERSION } from '../../core/version.ts'

/** Basename of the host heartbeat file inside the Harness home. */
export const LOOMY_HOST_HEARTBEAT_FILENAME = '.loomy-host-heartbeat.json'

/** On-disk shape of the heartbeat. */
export type LoomyHostHeartbeat = HostHeartbeat

const heartbeat = createHostHeartbeat(
  {
    fileName: LOOMY_HOST_HEARTBEAT_FILENAME,
    packageName: 'dsh-llm-bridge',
  },
  BRIDGE_VERSION,
)

/** Absolute path of the host heartbeat file. */
export const loomyHostHeartbeatPath = heartbeat.path

/** Write (or overwrite) the heartbeat after the host registered the provider. */
export const writeHostHeartbeat = heartbeat.write

/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
export const clearHostHeartbeat = heartbeat.clear

/** Read and validate the heartbeat; `undefined` when absent or malformed. */
export const readHostHeartbeat = heartbeat.read

export { isHeartbeatProcessAlive, processStartTimeMs }
