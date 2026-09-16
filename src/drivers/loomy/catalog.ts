/**
 * Loomy model catalog: a static fallback list captured from the live imodel
 * endpoint, replaced by the dynamic answer once it loads.
 *
 * @module dsh-llm-bridge/drivers/loomy/catalog
 */

import { Catalog } from '../../core/catalog.ts'
import type { LoomyModelInfo } from './upstream.ts'

/** One model entry the adapter exposes. */
export type LoomyModelEntry = LoomyModelInfo

/**
 * Static chat models observed on the imodel endpoint on 2026-09-16. The
 * upstream refresh replaces this list at startup; it exists so the provider
 * registers with a usable catalog even while the first fetch is in flight or
 * offline.
 *
 * The two image-generation models (`doubao-seedream-5-lite`,
 * `qwen-image-3.0-pro`, `type: "image"`) are intentionally absent — the
 * chat-completions shim cannot serve them. Names are the platform's own
 * display names (they already carry the rate/promo suffix, e.g.
 * `Spark X2.5（限时免费）`), so no driver-side name decoration is applied.
 */
export const FALLBACK_LOOMY_MODELS: readonly LoomyModelEntry[] = [
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731（x3.0）', contextWindow: 1_048_576, maxTokens: 384_000, supportsImages: false, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'MiniMax-M3', name: 'MiniMax M3 （x4.0）', contextWindow: 1_048_576, maxTokens: 512_000, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6 （x6.5）', contextWindow: 262_144, maxTokens: 65_536, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max (x12.0)', contextWindow: 1_000_000, maxTokens: 65_536, supportsImages: false, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash(x0.8)', contextWindow: 1_048_576, maxTokens: 131_072, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'qwen3.8-flash', name: 'qwen 3.8 flash（x0.8）', contextWindow: 1_000_000, maxTokens: 131_072, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'spark-x', name: 'Spark X2.5（限时免费）', contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: false, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'doubao-seed-2.0-mini', name: 'Doubao Seed 2.0 mini（x0.8）', contextWindow: 262_144, maxTokens: 131_072, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'mimo-v2.5', name: 'MiMo V2.5（x3.3）', contextWindow: 1_048_576, maxTokens: 131_072, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
  { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash（x1.0）', contextWindow: 1_000_000, maxTokens: 65_536, supportsImages: true, reasoning: { supports: true, supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' } },
]

/** Mutable Loomy catalog seeded with the fallback roster. */
export class LoomyCatalog extends Catalog<LoomyModelEntry> {
  constructor() {
    super(FALLBACK_LOOMY_MODELS)
  }
}
