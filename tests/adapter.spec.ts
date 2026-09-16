import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/drivers/workbuddy/adapter.ts'
import { WorkBuddyCredentialStore } from '../src/drivers/workbuddy/auth.ts'
import { FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/drivers/workbuddy/catalog.ts'
import type { WorkBuddyShim } from '../src/drivers/workbuddy/shim.ts'

/**
 * Regression cover for the profile contract `dsh-llm-pi-ai` enforces.
 *
 * `PiAiAdapter.modelOf()` reads `profile.modelErrors` unconditionally, and
 * `ResolvedPiAiProviderProfile` marks the field required. Because this plugin
 * assembles its profile by hand, an omitted `modelErrors` made every
 * `resolveModel()` call throw
 * `Cannot read properties of undefined (reading 'get')` on DSH >= 0.1.5 —
 * the model picker rendered "WorkBuddy 加载失败" and no WorkBuddy model could
 * be selected.
 *
 * The failure is asymmetric and easy to miss: `listModels()` only reaches
 * `profileOf()` and stayed green throughout, while `resolveModel()` reached
 * `modelOf()` and threw. Both paths are asserted here so a future contract
 * change cannot pass on the catalog list alone.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** Adapter options backed by a temp dir, so no real DSH home is touched. */
async function makeOptions() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-bridge-adapter-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))

  const store = new WorkBuddyCredentialStore({
    desktopPath: join(dir, 'desktop.json'),
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })

  // The adapter only ever reads the shim's origin string; nothing dials it.
  const shim: WorkBuddyShim = {
    ready: Promise.resolve(),
    baseUrl: () => 'http://127.0.0.1:1',
    token: () => 'test-token',
    close: async () => {},
  }

  return { shim, store, catalog: new WorkBuddyCatalog() }
}

describe('createWorkBuddyAdapter', () => {
  it('lists the catalog models', async () => {
    const { adapter } = createWorkBuddyAdapter(await makeOptions())

    const models = await adapter.listModels(WORKBUDDY_PROVIDER)

    expect(models.map(model => model.id)).toEqual(
      FALLBACK_WORKBUDDY_MODELS.map(model => model.id),
    )
    expect(models.every(model => model.provider === WORKBUDDY_PROVIDER)).toBe(true)
  })

  it('resolves every catalog model without throwing', async () => {
    const { adapter } = createWorkBuddyAdapter(await makeOptions())

    // `resolveModel` is the path that reads `profile.modelErrors`; a missing
    // field throws here rather than returning a wrong answer.
    for (const model of FALLBACK_WORKBUDDY_MODELS) {
      const resolved = await adapter.resolveModel(WORKBUDDY_PROVIDER, model.id)
      expect(resolved.id).toBe(model.id)
    }
  })

  it('keeps resolving models after invalidate()', async () => {
    const { adapter, invalidate } = createWorkBuddyAdapter(await makeOptions())

    invalidate()

    // `PiAiAdapter.current()` reuses a snapshot by profile-Map identity, so a
    // rebuild must reproduce every required field on the replacement profile.
    const resolved = await adapter.resolveModel(WORKBUDDY_PROVIDER, 'auto')
    expect(resolved.id).toBe('auto')
  })
})
