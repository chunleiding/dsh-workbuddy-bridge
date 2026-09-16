/**
 * The WorkBuddy driver's pi-ai adapter: platform-specific catalog mapping
 * (reasoning effort ladders, image capability) and the billing/badge name
 * decoration, assembled on top of the core's generic loopback-backed
 * adapter.
 *
 * @module dsh-llm-bridge/drivers/workbuddy/adapter
 */

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { createBridgeAdapter, type BridgeAdapter, type BridgeAdapterOptions } from '../../core/adapter.ts'
import type { BridgeShim } from '../../core/shim.ts'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import {
  WORKBUDDY_DISPLAY_NAME,
  WORKBUDDY_PROVIDER,
  WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
} from './meta.ts'
import { normalizeCredits } from './upstream.ts'

export { WORKBUDDY_DISPLAY_NAME, WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS } from './meta.ts'

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  shim: BridgeShim
  /**
   * Credential store. The core adapter authenticates via the shim secret,
   * so this is not read on the request path; it remains part of the
   * driver's assembly surface for parity and future use.
   */
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createWorkBuddyAdapter} hands back. */
export type WorkBuddyAdapter = BridgeAdapter

/**
 * The suffix appended to a model's display name so its billing rate is visible
 * wherever the name is shown.
 *
 * The separator is a middle dot rather than a hyphen or colon: model names
 * already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
 * separator would be ambiguous about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/**
 * The catalog display suffix: the billing rate followed by the declared promo
 * badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
 * The badge labels are the upstream's own spellings and the host seam has no
 * locale service, so non-Chinese UIs see them verbatim — accepted until the
 * picker grows a localized badge slot.
 */
function displaySuffix(info: WorkBuddyModelInfo): string | undefined {
  const parts = [
    normalizeCredits(info.billing?.credits),
    ...(info.billing?.badges ?? []),
  ].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name: string, info: WorkBuddyModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}
function withRate(name: string, info: WorkBuddyModelInfo): string {
  const rate = normalizeCredits(info.billing?.credits)
  return rate === undefined ? name : `${name}${RATE_SEPARATOR}${rate}`
}

/**
 * Resolve a WorkBuddy model's reasoning capability into pi-ai's
 * `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
 * unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
 *
 * Declared sets only: a thinking control is offered exactly when the upstream
 * catalog declares a `supportedEfforts` list, and it offers exactly the
 * declared values. Rows without a list (the older `{effort, summary}` shape)
 * get no control at all — their selectable set is client-side knowledge the
 * catalog does not carry (the desktop app differs per model there: GLM-5.2
 * gets a thinking control while MiniMax-M3 and Kimi-K2.6 do not, though their
 * catalog rows are identical), and another implementation against the same
 * upstream (workbuddy2api) gates on the declared set and downgrades
 * out-of-set values rather than passing them through, so sending an
 * undeclared value risks a 400. Such models never carry `reasoning_effort`
 * on the wire; the upstream applies its own default.
 * `off` is offered only when the model explicitly reports thinking can be
 * disabled (`canDisableThinking === true`).
 */
function reasoningFields(info: WorkBuddyModelInfo): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const efforts = reasoning.supportedEfforts
  if (efforts === undefined || efforts.length === 0) {
    // No declared set: no thinking control, no `reasoning_effort` on the wire
    // — identical to the pre-#9 behavior for these rows.
    return { reasoning: false }
  }
  const map: Record<ModelThinkingLevel, string | null> = {
    off: reasoning.canDisableThinking === true ? 'off' : null,
    // `minimal` is not in the upstream effort vocabulary (EFFORT_VALUES), so
    // no declared set can ever contain it.
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: WorkBuddyModelInfo, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: WORKBUDDY_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

/**
 * Assemble the WorkBuddy adapter through the core seam. The provider's
 * `getModels` reads the live catalog, and every model's `baseUrl` is
 * re-resolved per read so the shim's ephemeral port applies from the first
 * snapshot after startup.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const coreOptions: BridgeAdapterOptions<WorkBuddyModelInfo> = {
    providerId: WORKBUDDY_PROVIDER,
    displayName: WORKBUDDY_DISPLAY_NAME,
    credentialName: 'WorkBuddy OAuth bearer token',
    credentialSource: 'WorkBuddy',
    shim: options.shim,
    catalog: options.catalog,
    toModel: (info, baseUrl) => toPiModel(info, baseUrl),
    // The rate AND the declared promo badges ride the *name* alone: since DSH
    // 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name`
    // only — `description` is no longer read there at all. This is
    // display-only and cannot affect routing: the wire request is built from
    // `model.id`, and nothing in the host resolves a model by name.
    decorateModelName: (name, info) => withCatalogDisplay(name, info),
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
  }
  return createBridgeAdapter<WorkBuddyModelInfo>(coreOptions)
}
