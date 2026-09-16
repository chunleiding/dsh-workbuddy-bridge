import { describe, expect, it } from 'vitest'
import { createQoderAdapter, QODER_PROVIDER } from '../../src/drivers/qoder/adapter.ts'
import { QoderCredentialStore } from '../../src/drivers/qoder/auth.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from '../../src/drivers/qoder/catalog.ts'
import { mustNotRefresh } from './fixtures.ts'
import type { QoderModelEntry } from '../../src/drivers/qoder/catalog.ts'

/** The adapter only needs a base URL and a token from the shim on this path. */
function makeOptions(entries?: readonly QoderModelEntry[]) {
  const catalog = new QoderCatalog()
  if (entries !== undefined) catalog.set(entries)
  return {
    catalog,
    shim: {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'test-token',
      close: async () => {},
    },
    store: new QoderCredentialStore({ authDir: '/nonexistent/qoder-auth', refresh: mustNotRefresh }),
  }
}

describe('createQoderAdapter', () => {
  it('lists the fallback roster under the qoder provider', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    const models = await adapter.listModels(QODER_PROVIDER)
    expect(models.map(model => model.id)).toEqual(FALLBACK_QODER_MODELS.map(model => model.id))
    expect(models.length).toBe(14)
    expect(models.every(model => model.provider === QODER_PROVIDER)).toBe(true)
  })

  it('resolves every fallback model without throwing', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    for (const model of FALLBACK_QODER_MODELS) {
      const resolved = await adapter.resolveModel(QODER_PROVIDER, model.id)
      expect(resolved.id).toBe(model.id)
    }
  })

  it('maps image capability from the catalog', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    const models = await adapter.listModels(QODER_PROVIDER)
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('mmodel')?.inputModalities).toEqual(['text'])
    expect(byId.get('auto')?.inputModalities).toContain('image')
  })

  it('carries the context window from the catalog', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    const resolved = await adapter.resolveModel(QODER_PROVIDER, 'qmodel_38max')
    expect(resolved.context?.contextWindow).toBe(200_000)
  })

  it('offers exactly the thinking ladder Qoder offers for that model', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    const effortsOf = async (id: string): Promise<string[] | undefined> => {
      const resolved = await adapter.resolveModel(QODER_PROVIDER, id)
      return resolved.reasoning?.efforts?.map(effort => effort.id)
    }
    expect(await effortsOf('qmodel_38max')).toEqual(['low', 'medium', 'xhigh'])
    expect(await effortsOf('dmodel')).toEqual(['high', 'max'])
    expect(await effortsOf('gmodel')).toEqual(['low', 'high', 'max'])
  })

  it('offers no thinking control for a model with no declared ladder', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    // These are reasoning models whose selectable set is client-side knowledge
    // the catalog does not carry; a guessed ladder would be a control that
    // does nothing.
    expect((await adapter.resolveModel(QODER_PROVIDER, 'qmodel_latest')).reasoning).toBeUndefined()
  })

  it('offers no thinking control for a non-reasoning model', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    expect((await adapter.resolveModel(QODER_PROVIDER, 'dfmodel')).reasoning).toBeUndefined()
    expect((await adapter.resolveModel(QODER_PROVIDER, 'kmodel_latest')).reasoning).toBeUndefined()
  })

  it('never offers a "thinking off" level, because none could be verified', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    // The endpoint accepts any string for `reasoning_effort`, so no spelling's
    // "off" meaning is provable; offering one would be a switch that appears
    // to work while the server keeps thinking.
    for (const model of FALLBACK_QODER_MODELS) {
      const resolved = await adapter.resolveModel(QODER_PROVIDER, model.id)
      const ids = resolved.reasoning?.efforts?.map(effort => effort.id) ?? []
      expect(ids).not.toContain('off')
      expect(ids).not.toContain('minimal')
    }
  })

  it('rides the rate and the promo badge on the display name', async () => {
    const { adapter } = createQoderAdapter(makeOptions())
    const models = await adapter.listModels(QODER_PROVIDER)
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('auto')?.name).toBe('Auto · x0.5')
    expect(byId.get('qmodel_38max')?.name).toBe('Qwen3.8-Max · x0.5 · 错峰 4 折')
  })

  it('leaves a name with no offer facts alone', async () => {
    const { adapter } = createQoderAdapter(makeOptions([
      { id: 'bare', name: 'Bare', contextWindow: 1000, maxTokens: 100, supportsImages: false, source: 'system', enabled: true, isDefault: false },
    ]))
    const models = await adapter.listModels(QODER_PROVIDER)
    expect(models.map(model => model.name)).toEqual(['Bare'])
  })

  it('tracks a catalog replacement without being rebuilt', async () => {
    const options = makeOptions()
    const { adapter } = createQoderAdapter(options)
    expect((await adapter.listModels(QODER_PROVIDER)).length).toBe(14)
    options.catalog.set([
      { id: 'live-only', name: 'Live Only', contextWindow: 1000, maxTokens: 100, supportsImages: false, source: 'system', enabled: true, isDefault: true },
    ])
    const models = await adapter.listModels(QODER_PROVIDER)
    expect(models.map(model => model.id)).toEqual(['live-only'])
    expect((await adapter.resolveModel(QODER_PROVIDER, 'live-only')).name).toBe('Live Only')
  })
})
