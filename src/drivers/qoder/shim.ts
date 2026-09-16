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
import { FALLBACK_QODER_MODELS, type QoderCatalog, type QoderModelEntry } from './catalog.ts'
import { QODER_PROVIDER } from './meta.ts'
import { modelKeyOf, prepareQoderChatBody, QoderUpstreamClient, type QoderChatResult } from './upstream.ts'

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
      chat: (credential, bodyJson, signal) => {
        const selection = resolveQoderModelSelection(bodyJson, catalog)
        if (!selection.ok) return Promise.resolve(selection.result)
        return client.chatStream(credential, prepareQoderChatBody(selection.bodyJson), signal)
      },
    },
    catalog,
    ownedBy: QODER_PROVIDER,
    upstreamLabel: 'qoder upstream',
    ...logger === undefined ? {} : { logger },
  })
}

/**
 * Resolve the model a chat body actually targets against the account's live
 * catalog, and reject selections the account cannot drive.
 *
 * The Qoder gateway silently downgrades a request for a disabled model to its
 * hard default (observed answering as "Qwen3.5") rather than erroring — which
 * is exactly the mis-routing a user reports. We intercept it here:
 *
 * - an `auto`/missing selection resolves to the catalog's default *enabled*
 *   model, so the host's "Auto" choice lands on a real model instead of the
 *   silent downgrade; and
 * - a selection that is absent from the post-refresh catalog but was a known
 *   catalog id is reported as unavailable, instead of being let through to a
 *   misleading answer from the wrong model.
 *
 * The membership test doubles as the refresh detector: before the live catalog
 * loads, `catalog.current()` is the static fallback (which lists every known
 * id), so every known selection passes; after the live refresh drops
 * `enable: false` rows, a disabled selection is no longer present and is
 * rejected.
 */
function resolveQoderModelSelection(
  bodyJson: string,
  catalog: QoderCatalog,
): { ok: true; bodyJson: string } | { ok: false; result: QoderChatResult } {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return { ok: true, bodyJson }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: true, bodyJson }
  const document = body as Record<string, unknown>
  let key = modelKeyOf(bodyJson)
  let rewrote = false
  if (key === 'auto' || key === '') {
    const def = catalog.current().find((m) => m.isDefault)
    if (def !== undefined) {
      document['model'] = def.id
      key = def.id
      rewrote = true
    }
  }
  const live = catalog.current()
  if (!live.some((m) => m.id === key)) {
    const known = FALLBACK_QODER_MODELS.some((m) => m.id === key)
    const available = live.map((m) => m.id).join(', ')
    const message = known
      ? `qoder: model "${key}" is not available on your Qoder account (it is disabled or requires a subscription). Available models: ${available || '(none)'}`
      : `qoder: unknown model "${key}"`
    return { ok: false, result: { ok: false, status: 400, kind: 'client', message } }
  }
  return { ok: true, bodyJson: rewrote ? JSON.stringify(document) : bodyJson }
}
