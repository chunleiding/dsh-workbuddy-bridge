/**
 * The Qoder driver's pi-ai adapter: catalog-to-descriptor mapping (image
 * capability, thinking-effort ladder, offer badges) on top of the core's
 * generic loopback-backed adapter.
 *
 * @module dsh-llm-bridge/drivers/qoder/adapter
 */

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createBridgeAdapter, type BridgeAdapter, type BridgeAdapterOptions } from '../../core/adapter.ts'
import type { BridgeShim } from '../../core/shim.ts'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderCatalog, QoderModelEntry } from './catalog.ts'
import {
  QODER_DISPLAY_NAME,
  QODER_PROVIDER,
  QODER_STREAM_IDLE_TIMEOUT_MS,
} from './meta.ts'
import type { QoderEffort, QoderModelInfo } from './upstream.ts'

export { QODER_DISPLAY_NAME, QODER_PROVIDER, QODER_STREAM_IDLE_TIMEOUT_MS } from './meta.ts'

/** Constructor dependencies. */
export interface QoderAdapterOptions {
  shim: BridgeShim
  /**
   * Credential store. The core adapter authenticates via the shim secret, so
   * this is not read on the request path; it remains part of the driver's
   * assembly surface for parity.
   */
  store: QoderCredentialStore
  catalog: QoderCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createQoderAdapter} hands back. */
export type QoderAdapter = BridgeAdapter

/** Separator between a model's name and its offer suffix in the picker. */
const SUFFIX_SEPARATOR = ' · '

/**
 * The picker suffix: the price multiplier followed by the catalog's promo
 * badges, or undefined when the row carries neither.
 *
 * The badges are the catalog's own Chinese spellings, as with the WorkBuddy
 * driver — the host seam has no locale service, so whatever string is produced
 * here is rendered verbatim in every UI language.
 */
function displaySuffix(info: QoderModelInfo): string | undefined {
  const parts = [info.billing?.credits, ...(info.billing?.badges ?? [])]
    .filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(SUFFIX_SEPARATOR)
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name: string, info: QoderModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${SUFFIX_SEPARATOR}${suffix}`
}

/**
 * Map a Qoder model's declared thinking ladder into pi-ai's
 * `thinkingLevelMap`.
 *
 * `thinkingLevelMap` values are what pi-ai puts on the wire as
 * `reasoning_effort`, so only spellings the catalog actually declares are
 * mapped: a declared level is offered, an undeclared one is `null`, and the
 * selector shows exactly the ladder the Qoder app itself offers for that model.
 *
 * `off` is deliberately always `null`, even for rows whose `thinking_config`
 * declares a `disabled` state. The endpoint accepts **any** string for
 * `reasoning_effort` (verified: meaningless values return HTTP 200 too), so
 * there is no spelling whose "thinking off" meaning could be confirmed — and a
 * switch that appears to work while the server silently keeps thinking is worse
 * than no switch. `off: null` means pi-ai sends no `reasoning_effort` at all
 * unless the user picks a level, which leaves the server on its own default.
 *
 * Rows with no declared ladder (`supportedEfforts` absent) describe reasoning
 * models whose selectable set is client-side knowledge the catalog does not
 * carry; they get no control at all rather than a guessed one.
 */
function reasoningFields(info: QoderModelInfo): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return { reasoning: false }
  const efforts = reasoning.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return { reasoning: false }
  const has = (effort: QoderEffort): boolean => efforts.includes(effort)
  const map: Record<ModelThinkingLevel, string | null> = {
    off: null,
    // `minimal` is not in Qoder's declared vocabulary.
    minimal: null,
    low: has('low') ? 'low' : null,
    medium: has('medium') ? 'medium' : null,
    high: has('high') ? 'high' : null,
    xhigh: has('xhigh') ? 'xhigh' : null,
    max: has('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: QoderModelEntry, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: QODER_PROVIDER,
    baseUrl,
    input: info.supportsImages ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

/**
 * Assemble the Qoder adapter through the core seam. The provider's
 * `getModels` reads the live catalog, and every model's `baseUrl` is
 * re-resolved per read so the shim's ephemeral port applies from the first
 * snapshot after startup.
 */
export function createQoderAdapter(options: QoderAdapterOptions): QoderAdapter {
  const coreOptions: BridgeAdapterOptions<QoderModelEntry> = {
    providerId: QODER_PROVIDER,
    displayName: QODER_DISPLAY_NAME,
    credentialName: 'Qoder device token',
    credentialSource: 'Qoder',
    shim: options.shim,
    catalog: options.catalog,
    toModel: (info, baseUrl) => toPiModel(info, baseUrl),
    // The rate and the promo badges ride the *name* alone: DSH's composer model
    // seat renders `model.name` only, so a badge put on `description` would
    // never be seen. This is display-only — the wire request is built from
    // `model.id`, and nothing in the host resolves a model by name.
    decorateModelName: (name, info) => withCatalogDisplay(name, info),
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
  }
  return createBridgeAdapter<QoderModelEntry>(coreOptions)
}
