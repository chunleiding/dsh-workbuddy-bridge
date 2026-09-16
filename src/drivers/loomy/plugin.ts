/**
 * Loomy driver DSH plugin: compose the core mechanisms with the Loomy
 * driver pieces and register the `loomy` provider. Streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 *
 * @module dsh-llm-bridge/drivers/loomy/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { LoomySessionStore } from './auth.ts'
import { LoomyCatalog } from './catalog.ts'
import { createLoomyAdapter, LOOMY_DISPLAY_NAME, LOOMY_PROVIDER } from './adapter.ts'
import { createLoomyShim } from './shim.ts'
import { LoomyUpstreamClient } from './upstream.ts'
import { registerLoomyStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './heartbeat.ts'

/** Settings namespace owning the Loomy configuration card. */
export const LOOMY_SETTINGS_NS = 'loomy' as SettingsNamespace

/** Loomy driver configuration. */
export interface Config {
  /** Explicit Loomy session-file path, overriding env and platform defaults. */
  sessionFile?: string
}

export const Config: z<Config> = z.object({
  sessionFile: z.string().description('Loomy desktop auth-session.json file (defaults to the app\'s own location)'),
})

/**
 * Start the loopback endpoint, register the `loomy` provider, and refresh
 * the model catalog from imodel once a session is available. The static
 * fallback catalog serves from the first moment, so an offline upstream
 * never leaves the provider empty.
 */
export function applyLoomyPlugin(ctx: Context, config: Config): void {
  const client = new LoomyUpstreamClient()
  const store = new LoomySessionStore({
    ...config.sessionFile === undefined ? {} : { sessionFile: config.sessionFile },
  })
  const catalog = new LoomyCatalog()
  const shim = createLoomyShim({ store, client, catalog, logger: ctx.logger })

  ctx.inject(['webServer'], webCtx => registerLoomyStatusRoute(webCtx, { store }))

  let current = () => config
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, LOOMY_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        store.setSessionPath(current().sessionFile)
      },
    })
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready
    .then(() => {
      if (stopped) return

      let invalidate: (() => void) | undefined
      try {
        const loomy = createLoomyAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })
        invalidate = loomy.invalidate

        let releaseAdapter: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([LOOMY_PROVIDER], loomy.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: LOOMY_PROVIDER,
            displayName: LOOMY_DISPLAY_NAME,
            settingsNs: LOOMY_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          releaseAdapter?.()
          releaseDirectory?.()
        }

        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-llm-bridge: loomy provider registration failed', error)
        return
      }

      void (async () => {
        try {
          const session = await store.resolve().catch(() => undefined)
          if (session === undefined || stopped) return
          const models = await client.fetchModels(session)
          if (stopped) return
          catalog.set([...models])
          invalidate?.()
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-llm-bridge: loomy dynamic model catalog unavailable; serving the static fallback list',
            error,
          )
        }
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-llm-bridge: loomy loopback endpoint failed to start; provider not registered', error)
    })
}
