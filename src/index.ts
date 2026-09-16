/**
 * DSH LLM Bridge — reuse closed AI agents' existing sign-in and quota inside
 * DeepSeek Harness.
 *
 * Architecture:
 * - `src/core/` holds the platform-agnostic mechanisms (credential lifecycle,
 *   model catalog, loopback shim, pi-ai adapter shell, SSE pipe, shared
 *   secret, heartbeat, status route, status card) with no platform name.
 * - `src/drivers/<platform>/` holds every platform-private fact: credential
 *   discovery, token/session handling, endpoints, request/response protocol
 *   conversion, model roster, quota, error classification, and branding.
 *
 * This package ships three drivers — WorkBuddy, Loomy and Qoder — and
 * registers one provider per driver. Switching platform is just picking a
 * model in the DSH model selector.
 *
 * @module dsh-llm-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyLoomyPlugin } from './drivers/loomy/plugin.ts'
import { applyQoderPlugin } from './drivers/qoder/plugin.ts'
import { applyWorkBuddyPlugin, Config as WorkBuddyDriverConfig } from './drivers/workbuddy/plugin.ts'
import { Config as LoomyDriverConfig } from './drivers/loomy/plugin.ts'
import { Config as QoderDriverConfig } from './drivers/qoder/plugin.ts'
import type { Config as WorkBuddyDriverConfigType } from './drivers/workbuddy/plugin.ts'
import type { Config as LoomyDriverConfigType } from './drivers/loomy/plugin.ts'
import type { Config as QoderDriverConfigType } from './drivers/qoder/plugin.ts'

export * from './drivers/workbuddy/index.ts'
export * from './drivers/loomy/index.ts'
export * from './drivers/qoder/index.ts'

/** Plugin configuration: one optional section per driver. */
export interface Config {
  workbuddy?: WorkBuddyDriverConfigType
  loomy?: LoomyDriverConfigType
  qoder?: QoderDriverConfigType
}

// In this schemastery fork object properties are optional unless explicitly
// marked required, so omitting a driver's section validates as {}.
export const Config: z<Config> = z.object({
  workbuddy: WorkBuddyDriverConfig,
  loomy: LoomyDriverConfig,
  qoder: QoderDriverConfig,
})

/** Stable Cordis plugin name. */
export const name = 'llm-bridge'

/** The model registry required before any provider can register. */
export const inject = ['llm']

/**
 * Compose the core mechanisms with every shipped driver and register their
 * providers (`workbuddy`, `loomy`, `qoder`). Streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 */
export function apply(ctx: Context, config: Config): void {
  applyWorkBuddyPlugin(ctx, config.workbuddy ?? {})
  applyLoomyPlugin(ctx, config.loomy ?? {})
  applyQoderPlugin(ctx, config.qoder ?? {})
}
