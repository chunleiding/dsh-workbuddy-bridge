/**
 * Browser entry: register every shipped driver's Plugin-configuration card.
 *
 * The host bundle registers one provider per driver; this browser bundle
 * registers one settings card per driver. Each registration is independently
 * guarded inside the driver, so a failing card never blocks the other card
 * or the host providers.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { registerWorkBuddyCard } from '../drivers/workbuddy/client/index.tsx'
import { registerLoomyCard } from '../drivers/loomy/client/index.tsx'
import { registerQoderCard } from '../drivers/qoder/client/index.tsx'

/** Stable browser-plugin name. */
export const name = 'dsh-llm-bridge-client'

/** Client services required by the Plugin configuration contributions. */
export const inject = ['slots', 'locale']

/**
 * Register the WorkBuddy, Loomy and Qoder cards under Plugin configuration.
 *
 * The registrations mirror each driver's guarded `register*Card` (the try/
 * catch shape is duplicated in `tests/client-fallback.spec.ts`, which cannot
 * import browser-only DSH packages).
 */
export function apply(ctx: ClientContext): void {
  registerWorkBuddyCard(ctx)
  registerLoomyCard(ctx)
  registerQoderCard(ctx)
}
