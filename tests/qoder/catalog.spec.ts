import { describe, expect, it } from 'vitest'
import { FALLBACK_QODER_MODELS, QoderCatalog } from '../../src/drivers/qoder/catalog.ts'

describe('FALLBACK_QODER_MODELS', () => {
  it('is the roster the live catalog answered with', () => {
    expect(FALLBACK_QODER_MODELS.length).toBe(14)
    expect(new Set(FALLBACK_QODER_MODELS.map(model => model.id)).size).toBe(14)
    expect(FALLBACK_QODER_MODELS.every(model => model.source === 'system')).toBe(true)
  })

  it('keeps the models this driver has actually driven end to end', () => {
    const ids = FALLBACK_QODER_MODELS.map(model => model.id)
    // `auto` is the fallback an unparsable body resolves to, and `dmodel` is
    // the row the live probe used — it carries `enable:false` upstream, which
    // is a UI default rather than a capability limit.
    expect(ids).toContain('auto')
    expect(ids).toContain('dmodel')
    expect(ids).toContain('mmodel')
  })

  it('declares a complete entry for every model', () => {
    for (const model of FALLBACK_QODER_MODELS) {
      expect(model.name).not.toBe('')
      expect(model.contextWindow).toBeGreaterThan(0)
      expect(model.maxTokens).toBeGreaterThan(0)
      expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow)
      expect(typeof model.supportsImages).toBe('boolean')
    }
  })

  it('only declares effort ladders the endpoint actually accepts', () => {
    const vocabulary = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const model of FALLBACK_QODER_MODELS) {
      for (const effort of model.reasoning?.supportedEfforts ?? []) {
        expect(vocabulary.has(effort)).toBe(true)
      }
      const declared = model.reasoning?.supportedEfforts
      const fallback = model.reasoning?.defaultEffort
      if (fallback !== undefined) expect(declared).toContain(fallback)
    }
  })

  it('leaves the thinking ladder undeclared for a reasoning model without one', () => {
    // A reasoning model whose selectable set is client-side knowledge the
    // catalog does not carry: the adapter offers no control rather than a guess.
    const qmodelLatest = FALLBACK_QODER_MODELS.find(model => model.id === 'qmodel_latest')
    expect(qmodelLatest?.reasoning?.supports).toBe(true)
    expect(qmodelLatest?.reasoning?.supportedEfforts).toBeUndefined()
  })
})

describe('QoderCatalog', () => {
  it('is seeded with the fallback roster', () => {
    const catalog = new QoderCatalog()
    expect(catalog.current()).toEqual(FALLBACK_QODER_MODELS)
  })

  it('accepts a wholesale replacement from the upstream answer', () => {
    const catalog = new QoderCatalog()
    catalog.set([{ id: 'live-only', name: 'Live', contextWindow: 1, maxTokens: 1, supportsImages: false, source: 'system' }])
    expect(catalog.current().map(model => model.id)).toEqual(['live-only'])
    // The fallback constant itself is never mutated.
    expect(FALLBACK_QODER_MODELS.length).toBe(14)
  })
})
