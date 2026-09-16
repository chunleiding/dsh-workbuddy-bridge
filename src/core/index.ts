/**
 * DSH LLM Bridge core: platform-agnostic mechanisms for reusing a closed
 * AI agent's sign-in and quota inside DeepSeek Harness. The core knows no
 * platform name; every platform fact (credential discovery, native
 * protocol, model catalog, quota, errors, branding) lives in a driver.
 *
 * @module dsh-llm-bridge/core
 */

export { hostIsLoopback, hostnameOfHost, originIsLoopback, LOOPBACK_HOSTS } from './loopback.ts'
export { Catalog } from './catalog.ts'
export { CredentialRefresher, type CredentialRefresherOptions, type ExpiringCredential } from './credential.ts'
export { createShim, type BridgeShim, type BridgeShimOptions, type ShimLogger } from './shim.ts'
export { createBridgeAdapter, type BridgeAdapter, type BridgeAdapterOptions } from './adapter.ts'
export {
  createHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  type HeartbeatIdentity,
  type HostHeartbeat,
  type HostHeartbeatHandle,
} from './heartbeat.ts'
export {
  createStatusHandler,
  registerStatusRoute,
  safeMessage,
} from './status-route.ts'
export { BRIDGE_VERSION } from './version.ts'
export type {
  BridgeChatResult,
  BridgeErrorKind,
  BridgeUpstream,
  IdentifiedModel,
} from './types.ts'
