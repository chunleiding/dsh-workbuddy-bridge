/**
 * Public surface of the Loomy driver.
 *
 * @module dsh-llm-bridge/drivers/loomy
 */

export {
  LOOMY_PROVIDER,
  LOOMY_DISPLAY_NAME,
  LOOMY_STREAM_IDLE_TIMEOUT_MS,
  createLoomyAdapter,
  type LoomyAdapter,
  type LoomyAdapterOptions,
} from './adapter.ts'
export { createLoomyShim, type LoomyShim, type LoomyShimOptions } from './shim.ts'
export {
  FALLBACK_LOOMY_MODELS,
  LoomyCatalog,
  type LoomyModelEntry,
} from './catalog.ts'
export {
  defaultSessionCandidates,
  defaultSessionPath,
  parseLoomySession,
  LoomySessionStore,
  type LoomyAuthStatus,
  type LoomySession,
} from './auth.ts'
export {
  LOOMY_SESSION_FILENAME,
  LOOMY_SESSION_FILE_ENV,
} from './meta.ts'
export {
  classifyLoomyError,
  prepareLoomyChatBody,
  LoomyUpstreamClient,
  type LoomyChatResult,
  type LoomyEffort,
  type LoomyModelInfo,
  type LoomyModelReasoning,
} from './upstream.ts'
export {
  LOOMY_HOST_HEARTBEAT_FILENAME,
  loomyHostHeartbeatPath,
  type LoomyHostHeartbeat,
} from './heartbeat.ts'
export {
  LOOMY_STATUS_PATH,
  registerLoomyStatusRoute,
  loomyStatusHandler,
  loomyWebStatus,
  type LoomyStatusRouteOptions,
  type LoomyWebStatus,
} from './web-status.ts'
export {
  applyLoomyPlugin,
  Config as LoomyDriverConfig,
  LOOMY_SETTINGS_NS,
} from './plugin.ts'
