import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as Bridge from '../../src/index.ts'
import { FALLBACK_QODER_MODELS } from '../../src/drivers/qoder/catalog.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('qoder host integration', () => {
  it('registers the qoder provider with its own settings section and fallback catalog', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-llm-bridge-qoder-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    // An empty auth directory keeps this spec offline: the driver must serve
    // its fallback catalog without ever reaching Qoder, and must not read the
    // developer's own sign-in from the real home directory either.
    await ctx.plugin(Bridge, { qoder: { authDir: join(root, 'no-qoder-auth') } })

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('qoder')
    })

    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'qoder',
      displayName: 'Qoder',
      settingsNs: 'qoder',
      settingsPath: [],
      declared: false,
    })

    // The settings section round-trips the auth-directory override.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === Bridge.QODER_SETTINGS_NS)
    expect(descriptor).toBeDefined()
    await ctx.settings.update(Bridge.QODER_SETTINGS_NS, { authDir: '/tmp/qoder-auth' })
    const updated = ctx.settings.describe().find(entry => entry.ns === Bridge.QODER_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authDir']).toBe('/tmp/qoder-auth')

    // The static roster serves from first paint, so an offline upstream never
    // leaves the provider empty.
    const models = await ctx.llm.listModels('qoder')
    expect(models.map(model => model.id)).toEqual(FALLBACK_QODER_MODELS.map(model => model.id))
    expect(models.length).toBe(14)
    expect(models.every(model => model.provider === 'qoder')).toBe(true)

    // The thinking ladder reaches the host exactly as Qoder declares it.
    const dmodel = await ctx.llm.resolveModelInfo('qoder', 'dmodel')
    expect(dmodel.reasoning?.efforts.map(effort => effort.id)).toEqual(['high', 'max'])
    const qmax = await ctx.llm.resolveModelInfo('qoder', 'qmodel_38max')
    expect(qmax.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'xhigh'])
    expect(qmax.context?.contextWindow).toBe(200_000)

    // Image capability follows the per-model flag.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('mmodel')).toEqual(['text'])
    expect(modalities.get('auto')).toContain('image')
  })
})
