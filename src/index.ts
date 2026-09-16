/**
 * DSH LLM Bridge — reuse a closed AI agent's sign-in and quota inside DeepSeek
 * Harness.
 *
 * Architecture:
 * - `src/core/` holds the platform-agnostic mechanisms (credential lifecycle,
 *   model catalog, loopback shim, pi-ai adapter shell, SSE pipe, shared
 *   secret, heartbeat, status-route mounting). It contains no platform name.
 * - `src/drivers/<platform>/` holds every platform-private fact: credential
 *   discovery/parsing, token refresh, endpoints, request/response protocol
 *   conversion, model roster, quota, error classification, and UI branding.
 *
 * The package currently ships exactly one driver — WorkBuddy — and composes
 * it here into the DSH plugin. Future drivers (Trae, Qoder) get their own
 * directories; no multi-driver registry exists until a second real driver
 * validates the seam.
 *
 * @module dsh-llm-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, applyWorkBuddyPlugin } from './drivers/workbuddy/plugin.ts'
import type { WorkBuddyConfig } from './drivers/workbuddy/index.ts'

// The public surface is the WorkBuddy driver surface today.
export * from './drivers/workbuddy/index.ts'
export type { WorkBuddyConfig as Config }

/** Stable Cordis plugin name. */
export const name = 'llm-bridge'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Compose the core mechanisms with the WorkBuddy driver and register the
 * `workbuddy` provider. Streaming, tool calls, compaction, and permissions
 * stay Harness-owned.
 */
export function apply(ctx: Context, config: Config): void {
  applyWorkBuddyPlugin(ctx, config)
}
