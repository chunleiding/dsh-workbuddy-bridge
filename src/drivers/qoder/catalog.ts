/**
 * Qoder model catalog: a static fallback roster captured from the live
 * endpoint, replaced by the upstream's dynamic answer once it loads.
 *
 * The roster and every field on it are Qoder-private facts; only the mutable
 * container comes from the core.
 *
 * @module dsh-llm-bridge/drivers/qoder/catalog
 */

import { Catalog } from '../../core/catalog.ts'
import type { QoderModelInfo } from './upstream.ts'

/** One model entry the adapter exposes. */
export type QoderModelEntry = QoderModelInfo

/**
 * The `chat` roster as observed on 2026-09-16 (14 models, all
 * `format: openai`, `source: system`). The upstream refresh replaces this list
 * at startup; it exists so the provider registers with a usable catalog even
 * while the first fetch is in flight or offline.
 *
 * Every field is transcribed from the live catalog rather than guessed:
 * `contextWindow` is the default tier of `context_config`,
 * `supportedEfforts`/`defaultEffort`/`canDisableThinking` come from
 * `thinking_config`, and `credits` is `price_factor` in display form.
 *
 * `maxTokens` is the one field the catalog does not declare, so it carries the
 * driver's shared default (@see DEFAULT_MAX_OUTPUT_TOKENS). Models whose rows
 * declare no effort ladder (`supportedEfforts` absent) are reasoning models
 * whose selectable set is client-side knowledge the catalog does not carry;
 * they get no thinking control, matching the WorkBuddy driver's handling of the
 * same situation.
 */
export const FALLBACK_QODER_MODELS: readonly QoderModelEntry[] = [
  { id: 'auto', name: 'Auto', contextWindow: 180_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: false }, billing: { credits: 'x0.5', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: true, supportedEfforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' }, billing: { credits: 'x0.5', badges: ['错峰 4 折'], free: true }, source: 'system', enabled: true, isDefault: true },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: true, supportedEfforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' }, billing: { credits: 'x0.1', badges: ['错峰 4 折'], free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: true }, billing: { credits: 'x0.5', badges: ['错峰2折'], free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: true }, billing: { credits: 'x0.1', badges: ['错峰4折'], free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: false }, billing: { credits: 'x0.1', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: true, supportedEfforts: ['high', 'max'], defaultEffort: 'max' }, billing: { credits: 'x0.8', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: false, canDisableThinking: false }, billing: { credits: 'x0.2', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: false, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max' }, billing: { credits: 'x0.6', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: false, supportedEfforts: ['high', 'max'], defaultEffort: 'max' }, billing: { credits: 'x0.1', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: true, supportedEfforts: ['high', 'max'], defaultEffort: 'max' }, billing: { credits: 'x0.6', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: false, canDisableThinking: false }, billing: { credits: 'x0.8', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 200_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, canDisableThinking: false, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'max' }, billing: { credits: 'x0.3', free: false }, source: 'system', enabled: false, isDefault: false },
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200_000, maxTokens: 32_000, supportsImages: false, reasoning: { supports: false, canDisableThinking: false }, billing: { credits: 'x0.2', free: false }, source: 'system', enabled: false, isDefault: false },
]

/**
 * Mutable Qoder catalog seeded with the fallback roster; shared by the shim's
 * `/v1/models` and the adapter.
 */
export class QoderCatalog extends Catalog<QoderModelEntry> {
  constructor() {
    super(FALLBACK_QODER_MODELS)
  }
}
