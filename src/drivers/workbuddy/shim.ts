/**
 * WorkBuddy driver binding onto the core loopback shim.
 *
 * The inbound side (hardening, shared secret, SSE pipe) is entirely core.
 * The one WorkBuddy-private fact injected here is the outbound request
 * conversion: {@link prepareChatBody} forces streaming, flattens
 * `tool_choice`, and rewrites `developer` messages before the bytes reach
 * the WorkBuddy upstream. No inbound stream translation is needed — the
 * WorkBuddy upstream already answers in OpenAI SSE, so the core pipes its
 * body verbatim.
 *
 * @module dsh-llm-bridge/drivers/workbuddy/shim
 */

import { createShim, type BridgeShim, type ShimLogger } from '../../core/shim.ts'
import type { WorkBuddyCredentialStore, WorkBuddyCredential } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import { WORKBUDDY_PROVIDER } from './meta.ts'
import { prepareChatBody, WorkBuddyUpstreamClient } from './upstream.ts'

/** What the plugin needs from a running shim. */
export type WorkBuddyShim = BridgeShim

/** Constructor dependencies (unchanged shape from the pre-refactor driver). */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
}

/**
 * Start the WorkBuddy loopback endpoint. Requests carry the shim shared
 * secret; the WorkBuddy access token is resolved from the store inside the
 * core shim and never reaches pi-ai.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog, logger } = options
  return createShim<WorkBuddyCredential, WorkBuddyModelInfo>({
    resolveCredential: () => store.resolve(),
    upstream: {
      // The driver applies WorkBuddy's outbound wire quirks here; the core
      // shim stays unaware of them.
      chat: (credential, bodyJson, signal) =>
        client.chatStream(credential, prepareChatBody(bodyJson), signal),
    },
    catalog,
    ownedBy: WORKBUDDY_PROVIDER,
    upstreamLabel: 'workbuddy upstream',
    ...logger === undefined ? {} : { logger },
  })
}
