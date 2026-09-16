/**
 * Loomy driver binding onto the core loopback shim.
 *
 * The inbound side (hardening, shared secret, SSE pipe) is entirely core.
 * The only Loomy-private outbound conversion is flattening the OpenAI
 * `tool_choice` object to its string form; dual session headers and the
 * per-request `traceparent` are added further down in the Loomy upstream
 * client. No stream translation exists — imodel already speaks OpenAI SSE.
 *
 * @module dsh-llm-bridge/drivers/loomy/shim
 */

import { createShim, type BridgeShim, type ShimLogger } from '../../core/shim.ts'
import type { LoomySession, LoomySessionStore } from './auth.ts'
import type { LoomyCatalog, LoomyModelEntry } from './catalog.ts'
import { LOOMY_PROVIDER } from './meta.ts'
import { prepareLoomyChatBody, LoomyUpstreamClient } from './upstream.ts'

/** What the plugin needs from a running shim. */
export type LoomyShim = BridgeShim

/** Constructor dependencies. */
export interface LoomyShimOptions {
  store: LoomySessionStore
  client: Pick<LoomyUpstreamClient, 'chatStream'>
  catalog: LoomyCatalog
  logger?: ShimLogger
}

/** Start the Loomy loopback endpoint. */
export function createLoomyShim(options: LoomyShimOptions): LoomyShim {
  const { store, client, catalog, logger } = options
  return createShim<LoomySession, LoomyModelEntry>({
    resolveCredential: () => store.resolve(),
    upstream: {
      chat: (session, bodyJson, signal) =>
        client.chatStream(session, prepareLoomyChatBody(bodyJson), signal),
    },
    catalog,
    ownedBy: LOOMY_PROVIDER,
    upstreamLabel: 'loomy upstream',
    ...logger === undefined ? {} : { logger },
  })
}
