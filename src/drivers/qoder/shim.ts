/**
 * Qoder driver binding onto the core loopback shim.
 *
 * The inbound side (hardening, shared secret, SSE pipe) is entirely core. Two
 * Qoder-private facts are injected here:
 *
 * - the outbound request normalization ({@link prepareQoderChatBody}), and
 * - the upstream call, whose response is Qoder's enveloped SSE already
 *   translated into ordinary OpenAI frames by the upstream client.
 *
 * From the shim's point of view the platform therefore looks like any other
 * OpenAI SSE upstream: it pipes the body verbatim and never learns that the
 * frames were unwrapped.
 *
 * @module dsh-llm-bridge/drivers/qoder/shim
 */

import { createShim, type BridgeShim, type ShimLogger } from '../../core/shim.ts'
import type { QoderCredential } from './credential.ts'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderCatalog, QoderModelEntry } from './catalog.ts'
import { QODER_PROVIDER } from './meta.ts'
import { prepareQoderChatBody, QoderUpstreamClient } from './upstream.ts'

/** What the plugin needs from a running shim. */
export type QoderShim = BridgeShim

/** Constructor dependencies. */
export interface QoderShimOptions {
  store: QoderCredentialStore
  client: Pick<QoderUpstreamClient, 'chatStream'>
  catalog: QoderCatalog
  logger?: ShimLogger
}

/**
 * Start the Qoder loopback endpoint. Requests carry the shim shared secret;
 * the Qoder device token is resolved from the store inside the core shim and
 * never reaches pi-ai.
 */
export function createQoderShim(options: QoderShimOptions): QoderShim {
  const { store, client, catalog, logger } = options
  return createShim<QoderCredential, QoderModelEntry>({
    resolveCredential: () => store.resolve(),
    upstream: {
      chat: (credential, bodyJson, signal) =>
        client.chatStream(credential, prepareQoderChatBody(bodyJson), signal),
    },
    catalog,
    ownedBy: QODER_PROVIDER,
    upstreamLabel: 'qoder upstream',
    ...logger === undefined ? {} : { logger },
  })
}
