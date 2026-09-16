/**
 * The Loomy driver's pi-ai adapter: platform catalog mapping (image
 * capability, reasoning effort ladder) on top of the core's generic
 * loopback-backed adapter.
 *
 * Loomy's effort vocabulary uses `none` where OpenAI/pi-ai says `off`, so
 * the only mapping here is `off -> 'none'` plus dropping the levels Loomy
 * does not declare (`minimal`, `max`). Model names are shown verbatim — the
 * platform's own names already carry their rate/promo suffix, so unlike the
 * WorkBuddy driver there is no display-name decorator.
 *
 * @module dsh-llm-bridge/drivers/loomy/adapter
 */

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createBridgeAdapter, type BridgeAdapter, type BridgeAdapterOptions } from '../../core/adapter.ts'
import type { BridgeShim } from '../../core/shim.ts'
import type { LoomySessionStore } from './auth.ts'
import type { LoomyCatalog, LoomyModelEntry } from './catalog.ts'
import {
  LOOMY_DISPLAY_NAME,
  LOOMY_PROVIDER,
  LOOMY_STREAM_IDLE_TIMEOUT_MS,
} from './meta.ts'
import type { LoomyModelInfo } from './upstream.ts'

export { LOOMY_DISPLAY_NAME, LOOMY_PROVIDER, LOOMY_STREAM_IDLE_TIMEOUT_MS } from './meta.ts'

/** Constructor dependencies. */
export interface LoomyAdapterOptions {
  shim: BridgeShim
  /** Not read on the request path (auth rides the shim secret); kept for assembly parity. */
  store: LoomySessionStore
  catalog: LoomyCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createLoomyAdapter} hands back. */
export type LoomyAdapter = BridgeAdapter

/**
 * Map a Loomy model's reasoning declaration into pi-ai's
 * `thinkingLevelMap`. Every Loomy chat model declares its selectable effort
 * set explicitly, including `none`, so thinking can always be switched off.
 */
function reasoningFields(info: LoomyModelInfo): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || !reasoning.supports) return { reasoning: false }
  const efforts = reasoning.supportedEfforts
  const map: Record<ModelThinkingLevel, string | null> = {
    // Loomy spells the off position `none` rather than OpenAI's `off`.
    off: efforts.includes('none') ? 'none' : null,
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: LoomyModelEntry, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: LOOMY_PROVIDER,
    baseUrl,
    input: info.supportsImages ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

/** Assemble the Loomy adapter through the core seam. */
export function createLoomyAdapter(options: LoomyAdapterOptions): LoomyAdapter {
  const coreOptions: BridgeAdapterOptions<LoomyModelEntry> = {
    providerId: LOOMY_PROVIDER,
    displayName: LOOMY_DISPLAY_NAME,
    credentialName: 'Loomy session token',
    credentialSource: 'Loomy',
    shim: options.shim,
    catalog: options.catalog,
    toModel: (info, baseUrl) => toPiModel(info, baseUrl),
    streamIdleTimeoutMs: LOOMY_STREAM_IDLE_TIMEOUT_MS,
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
  }
  return createBridgeAdapter<LoomyModelEntry>(coreOptions)
}
