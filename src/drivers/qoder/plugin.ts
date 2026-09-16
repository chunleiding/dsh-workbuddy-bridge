/**
 * Qoder driver DSH plugin: compose the core mechanisms with the Qoder driver
 * pieces and register the `qoder` provider. Streaming, tool calls, compaction,
 * and permissions stay Harness-owned.
 *
 * @module dsh-llm-bridge/drivers/qoder/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { QoderCredentialStore } from './auth.ts'
import { QoderCatalog } from './catalog.ts'
import { createQoderAdapter, QODER_DISPLAY_NAME, QODER_PROVIDER } from './adapter.ts'
import { createQoderShim } from './shim.ts'
import { QoderUpstreamClient } from './upstream.ts'
import { registerQoderStatusRoute } from './web-status.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './heartbeat.ts'

/** Settings namespace owning the Qoder configuration card. */
export const QODER_SETTINGS_NS = 'qoder' as SettingsNamespace

/** Qoder driver configuration. */
export interface Config {
  /** Explicit Qoder auth directory, overriding env and platform defaults. */
  authDir?: string
  /**
   * Write a rotated refresh token back into the Qoder app's own credential
   * file. Default true; see the driver's auth module for why turning it off
   * eventually forces a re-sign-in in the Qoder app.
   */
  writeBack?: boolean
}

export const Config: z<Config> = z.object({
  authDir: z.string().description('Qoder auth directory (defaults to the app\'s own location)'),
  writeBack: z.boolean().description('Write a rotated refresh token back into the Qoder app\'s credential file'),
})

/**
 * Start the loopback endpoint, register the `qoder` provider, and refresh the
 * model catalog from the upstream once a credential is available. The static
 * fallback catalog serves from the first moment, so an offline upstream never
 * leaves the provider empty.
 */
export function applyQoderPlugin(ctx: Context, config: Config): void {
  const client = new QoderUpstreamClient({ logger: ctx.logger })
  const store = new QoderCredentialStore({
    ...config.authDir === undefined ? {} : { authDir: config.authDir },
    ...config.writeBack === undefined ? {} : { writeBack: config.writeBack },
    refresh: credential => client.refreshToken(credential),
  })
  const catalog = new QoderCatalog()
  const shim = createQoderShim({ store, client, catalog, logger: ctx.logger })

  // Same-origin status route backing the Plugin-configuration card; the
  // webServer service is optional (a headless profile serves no browser).
  ctx.inject(['webServer'], webCtx =>
    registerQoderStatusRoute(webCtx, { store, models: () => catalog.current() }))

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth directory live across edits.
  let current = () => config
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, QODER_SETTINGS_NS, Config, config, {
      setSource(source) { current = source },
      onChange() {
        store.setAuthDir(current().authDir)
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
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const qoder = createQoderAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })
        invalidate = qoder.invalidate

        let releaseAdapter: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([QODER_PROVIDER], qoder.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: QODER_PROVIDER,
            displayName: QODER_DISPLAY_NAME,
            settingsNs: QODER_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed.
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
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          releaseAdapter?.()
          releaseDirectory?.()
        }

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-llm-bridge: qoder provider registration failed', error)
        return
      }

      void (async () => {
        try {
          const credential = await store.current()
          if (credential === undefined || stopped) return
          // Resolve the region's inference host before the first request, so a
          // deployment that moves off the default gateway is picked up without
          // a code change. A failure falls back to the default and is logged.
          await client.discoverEndpoints(credential)
          if (stopped) return
          const models = await client.fetchModels(credential)
          if (stopped) return
          catalog.set([...models])
          invalidate?.()
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-llm-bridge: qoder dynamic model catalog unavailable; serving the static fallback list',
            error,
          )
        }
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-llm-bridge: qoder loopback endpoint failed to start; provider not registered', error)
    })
}
