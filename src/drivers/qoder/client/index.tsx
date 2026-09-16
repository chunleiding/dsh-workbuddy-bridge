/** Browser half: register the Qoder account status card in Plugin configuration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { QoderPluginCard } from './QoderPluginCard.tsx'
import type { QoderPluginCardInjected } from './QoderPluginCard.tsx'
import { en, zh } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy. */
    'settings.qoder': QoderSettingsKey
  }
}

/**
 * Register card copy and the Qoder card under Plugin configuration. Guarded
 * the same way as the other drivers: a slot-API breaking change degrades to a
 * `console.error` instead of breaking the DSH loader; every host provider keeps
 * working.
 */
export function registerQoderCard(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-llm-bridge: qoder settings copy')
    const t = ctx.locale.bind(namespace) as QoderPluginCardInjected['t']
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'qoder',
      priority: 40,
      inject: (): QoderPluginCardInjected => ({ t }),
    }, QoderPluginCard))
  } catch (error: unknown) {
    console.error('[dsh-llm-bridge] qoder client card failed to load (host provider unaffected):', error)
  }
}
