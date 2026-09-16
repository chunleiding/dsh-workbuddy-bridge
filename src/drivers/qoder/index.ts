/**
 * Public surface of the Qoder driver.
 *
 * @module dsh-llm-bridge/drivers/qoder
 */

export {
  QODER_DISPLAY_NAME,
  QODER_PROVIDER,
  QODER_STREAM_IDLE_TIMEOUT_MS,
  createQoderAdapter,
  type QoderAdapter,
  type QoderAdapterOptions,
} from './adapter.ts'
export { createQoderShim, type QoderShim, type QoderShimOptions } from './shim.ts'
export { FALLBACK_QODER_MODELS, QoderCatalog, type QoderModelEntry } from './catalog.ts'
export {
  defaultAuthDirectoryCandidates,
  QoderCredentialStore,
  type QoderStoreOptions,
  type QoderWriteBackOutcome,
} from './auth.ts'
export {
  credentialFromUserInfo,
  epochMsOf,
  isUsableMachineId,
  mergeRefreshOutcome,
  normalizeOrganizationTags,
  parseQoderRefreshResponse,
  qoderCredentialKey,
  QODER_CREDENTIAL_KEY_LENGTH,
  runtimeAuthFieldsInput,
  signingUserInfo,
  type QoderAuthStatus,
  type QoderCredential,
  type QoderRefreshOutcome,
  type QoderUserInfo,
} from './credential.ts'
export {
  classifyQoderError,
  mapQoderModel,
  modelKeyOf,
  prepareQoderChatBody,
  translateQoderStream,
  QoderUpstreamClient,
  type QoderChatResult,
  type QoderEffort,
  type QoderEndpoints,
  type QoderModelBilling,
  type QoderModelInfo,
  type QoderModelReasoning,
  type QoderUpstreamOptions,
} from './upstream.ts'
export {
  loadQoderWasm,
  openServerPayload,
  type QoderContextHandle,
  type QoderRequestResult,
  type QoderWasmApi,
  type QoderWasmLogger,
} from './wasm.ts'
export {
  QODER_HOST_HEARTBEAT_FILENAME,
  qoderHostHeartbeatPath,
  type QoderHostHeartbeat,
} from './heartbeat.ts'
export {
  QODER_STATUS_PATH,
  qoderStatusHandler,
  qoderWebStatus,
  registerQoderStatusRoute,
  type QoderStatusRouteOptions,
  type QoderWebStatus,
} from './web-status.ts'
export {
  applyQoderPlugin,
  Config as QoderDriverConfig,
  QODER_SETTINGS_NS,
} from './plugin.ts'
export {
  QODER_AGENT_ID,
  QODER_AUTO_MODEL,
  QODER_AUTH_DIR_ENV,
  QODER_CLIENT_METADATA,
  QODER_COSY_VERSION,
  QODER_GATEWAY_BASE,
  QODER_OPENAPI_BASE,
  QODER_SCENE,
} from './meta.ts'
