/** Browser half: register the WorkBuddy account status card in Plugin configuration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WorkBuddyPluginCard } from './WorkBuddyPluginCard.tsx'
import type { WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.workbuddy': WorkBuddySettingsKey
  }
}

/**
 * Register card copy and the WorkBuddy card under Plugin configuration.
 *
 * The body is guarded so that a DSH slot-API breaking change (for example
 * the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades to a
 * `console.error` instead of throwing into the DSH loader and raising the
 * red "Failed to load plugins" banner. The host providers keep working.
 *
 * NOTE: the try/catch boundary of this function is mirrored (duplicated) in
 * `tests/client-fallback.spec.ts`, which cannot import browser-only DSH
 * packages. If you change the guarded body or the `console.error` message
 * here, update that mirror too.
 */
export function registerWorkBuddyCard(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-llm-bridge: workbuddy settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyPluginCardInjected['t']
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'workbuddy',
      priority: 30,
      inject: (): WorkBuddyPluginCardInjected => ({ t }),
    }, WorkBuddyPluginCard))
  } catch (error: unknown) {
    console.error('[dsh-llm-bridge] workbuddy client card failed to load (host provider unaffected):', error)
  }
}
