/**
 * Loomy status document for the plugin card: sign-in state and the session
 * refresh time. Loomy exposes no balance endpoint to the client, so no quota
 * section is built; the phone number in the session file is PII and is never
 * read here.
 *
 * @module dsh-llm-bridge/drivers/loomy/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createStatusHandler, registerStatusRoute } from '../../core/status-route.ts'
import type { LoomySessionStore } from './auth.ts'
import { LOOMY_STATUS_PATH } from './status-paths.ts'
import type { LoomyWebStatus } from './status-paths.ts'

export { LOOMY_STATUS_PATH } from './status-paths.ts'
export type { LoomyWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface LoomyStatusRouteOptions {
  store: LoomySessionStore
}

/** Assemble the card's status document. */
export async function loomyWebStatus(deps: LoomyStatusRouteOptions): Promise<LoomyWebStatus> {
  const status = await deps.store.status()
  if (status.state !== 'signed-in') return { status: 'signed-out' }
  return {
    status: 'signed-in',
    ...status.updatedAtMs === undefined ? {} : { updatedAt: status.updatedAtMs },
  }
}

/** The status route's request handler, extracted so tests can mount it bare. */
export function loomyStatusHandler(
  deps: LoomyStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return createStatusHandler(() => loomyWebStatus(deps))
}

/** Mount the GET status route on an optional webServer context. */
export function registerLoomyStatusRoute(ctx: Context, deps: LoomyStatusRouteOptions): void {
  registerStatusRoute(ctx, LOOMY_STATUS_PATH, () => loomyWebStatus(deps))
}
