/**
 * Public surface of the WorkBuddy driver: every symbol the package root
 * re-exported before the core/driver split, so downstream imports and the
 * diagnostic scripts (`scripts/`) keep working unchanged.
 *
 * @module dsh-llm-bridge/drivers/workbuddy
 */

export {
  WORKBUDDY_PROVIDER,
  WORKBUDDY_DISPLAY_NAME,
  WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
  createWorkBuddyAdapter,
  type WorkBuddyAdapter,
  type WorkBuddyAdapterOptions,
} from './adapter.ts'
export { createWorkBuddyShim, type WorkBuddyShim, type WorkBuddyShimOptions } from './shim.ts'
export {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
  type WorkBuddyStoreOptions,
} from './auth.ts'
export {
  classifyUpstreamError,
  normalizeCredits,
  prepareChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './heartbeat.ts'
export {
  WORKBUDDY_STATUS_PATH,
  registerWorkBuddyStatusRoute,
  workBuddyStatusHandler,
  workBuddyWebStatus,
  type WorkBuddyStatusRouteOptions,
  type WorkBuddyWebStatus,
} from './web-status.ts'
export {
  applyWorkBuddyPlugin,
  Config,
  WORKBUDDY_SETTINGS_NS,
  type Config as WorkBuddyConfig,
} from './plugin.ts'
