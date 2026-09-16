import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoomyAdapter, LOOMY_PROVIDER } from '../../src/drivers/loomy/adapter.ts'
import { LoomySessionStore } from '../../src/drivers/loomy/auth.ts'
import { FALLBACK_LOOMY_MODELS, LoomyCatalog } from '../../src/drivers/loomy/catalog.ts'
import type { LoomyShim } from '../../src/drivers/loomy/shim.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function makeOptions() {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-adapter-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const store = new LoomySessionStore({ sessionFile: join(dir, 'missing.json') })
  const shim: LoomyShim = {
    ready: Promise.resolve(),
    baseUrl: () => 'http://127.0.0.1:1',
    token: () => 'test-token',
    close: async () => {},
  }
  return { shim, store, catalog: new LoomyCatalog() }
}

describe('createLoomyAdapter', () => {
  it('lists the fallback chat models under the loomy provider', async () => {
    const { adapter } = createLoomyAdapter(await makeOptions())
    const models = await adapter.listModels(LOOMY_PROVIDER)
    expect(models.map(model => model.id)).toEqual(FALLBACK_LOOMY_MODELS.map(model => model.id))
    expect(models.length).toBe(10)
    expect(models.every(model => model.provider === LOOMY_PROVIDER)).toBe(true)
  })

  it('resolves every fallback model without throwing', async () => {
    const { adapter } = createLoomyAdapter(await makeOptions())
    for (const model of FALLBACK_LOOMY_MODELS) {
      const resolved = await adapter.resolveModel(LOOMY_PROVIDER, model.id)
      expect(resolved.id).toBe(model.id)
    }
  })

  it('maps image capability from the catalog', async () => {
    const { adapter } = createLoomyAdapter(await makeOptions())
    const models = await adapter.listModels(LOOMY_PROVIDER)
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('spark-x')?.inputModalities).toEqual(['text'])
    expect(byId.get('GLM-5.3-Flash')?.inputModalities).toContain('image')
  })

  it('shows model names verbatim (rates/promo already ride the upstream names)', async () => {
    const { adapter } = createLoomyAdapter(await makeOptions())
    const models = await adapter.listModels(LOOMY_PROVIDER)
    const spark = models.find(model => model.id === 'spark-x')
    expect(spark?.name).toBe('Spark X2.5（限时免费）')
  })
})
