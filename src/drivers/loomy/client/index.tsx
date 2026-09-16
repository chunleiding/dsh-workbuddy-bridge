/** Browser half: register the Loomy account status card in Plugin configuration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { LoomyPluginCard } from './LoomyPluginCard.tsx'
import type { LoomyPluginCardInjected } from './LoomyPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { LoomySettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Loomy plugin card copy. */
    'settings.loomy': LoomySettingsKey
  }
}

/**
 * Register card copy and the Loomy card under Plugin configuration. Guarded
 * the same way as the WorkBuddy registration: a slot-API breaking change
 * degrades to a `console.error` instead of breaking the DSH loader; both
 * host providers keep working.
 */
export function registerLoomyCard(ctx: ClientContext): void {
  try {
    const namespace = 'settings.loomy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-llm-bridge: loomy settings copy')
    const t = ctx.locale.bind(namespace) as LoomyPluginCardInjected['t']
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'loomy',
      priority: 30,
      inject: (): LoomyPluginCardInjected => ({ t }),
    }, LoomyPluginCard))
  } catch (error: unknown) {
    console.error('[dsh-llm-bridge] loomy client card failed to load (host provider unaffected):', error)
  }
}
