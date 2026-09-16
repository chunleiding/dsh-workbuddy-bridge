/**
 * Qoder status document for the plugin card: sign-in state, device-token
 * expiry, and the model roster's offer facts.
 *
 * No quota section is built: the driver has not verified a balance endpoint
 * for this credential, and inventing a number for the card would be worse than
 * omitting it. The account label is the app's display name only — never the
 * uid, and never token material.
 *
 * @module dsh-llm-bridge/drivers/qoder/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createStatusHandler, registerStatusRoute } from '../../core/status-route.ts'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderModelEntry } from './catalog.ts'
import { QODER_STATUS_PATH } from './status-paths.ts'
import type { QoderWebStatus } from './status-paths.ts'

export { QODER_STATUS_PATH } from './status-paths.ts'
export type { QoderWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface QoderStatusRouteOptions {
  store: QoderCredentialStore
  /** Current catalog, read live so a refresh is reflected immediately. */
  models: () => readonly QoderModelEntry[]
}

/** Assemble the card's status document. */
export async function qoderWebStatus(deps: QoderStatusRouteOptions): Promise<QoderWebStatus> {
  const status = await deps.store.status()
  if (status.state !== 'signed-in') return { status: 'signed-out' }
  const models = deps.models().map(model => ({
    id: model.id,
    name: model.name,
    ...model.billing === undefined ? {} : { free: model.billing.free },
    ...model.billing?.badges === undefined ? {} : { badges: model.billing.badges },
    ...model.billing?.credits === undefined ? {} : { credits: model.billing.credits },
  }))
  return {
    status: 'signed-in',
    ...status.nickname === undefined ? {} : { nickname: status.nickname },
    ...status.expiresAtMs === undefined ? {} : { expiresAt: status.expiresAtMs },
    ...models.length === 0 ? {} : { models },
  }
}

/** The status route's request handler, extracted so tests can mount it bare. */
export function qoderStatusHandler(
  deps: QoderStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return createStatusHandler(() => qoderWebStatus(deps))
}

/** Mount the GET status route on an optional webServer context. */
export function registerQoderStatusRoute(ctx: Context, deps: QoderStatusRouteOptions): void {
  registerStatusRoute(ctx, QODER_STATUS_PATH, () => qoderWebStatus(deps))
}
