import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as Bridge from '../../src/index.ts'

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

describe('multi-driver host integration', () => {
  it('registers the workbuddy, loomy and qoder providers with their own sections', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-llm-bridge-multi-'))
    vi.stubEnv('DSH_HOME', root)
    // Point the Qoder driver at an empty directory so this spec stays offline
    // and never reads the developer's own Qoder sign-in.
    vi.stubEnv('QODER_AUTH_DIR', join(root, 'no-qoder-auth'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Bridge, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id).sort())
        .toEqual(['loomy', 'qoder', 'workbuddy'])
    })

    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'loomy',
      displayName: 'Loomy',
      settingsNs: 'loomy',
      settingsPath: [],
      declared: false,
    })

    // The Loomy section exists with its flat schema and persists a sessionFile.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === Bridge.LOOMY_SETTINGS_NS)
    expect(descriptor).toBeDefined()
    await ctx.settings.update(Bridge.LOOMY_SETTINGS_NS, { sessionFile: '/tmp/loomy.json' })
    const updated = ctx.settings.describe().find(entry => entry.ns === Bridge.LOOMY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['sessionFile']).toBe('/tmp/loomy.json')

    // The Loomy fallback catalog serves from first paint.
    const models = await ctx.llm.listModels('loomy')
    const ids = models.map(model => model.id)
    expect(ids.length).toBe(10)
    expect(ids).toContain('spark-x')
    expect(ids).not.toContain('qwen-image-3.0-pro')
    expect(models.every(model => model.provider === 'loomy')).toBe(true)

    // Loomy declares none/low/medium/high/xhigh: `none` maps to the selector's
    // `off`; `minimal`/`max` are not in the Loomy vocabulary and stay absent.
    const spark = await ctx.llm.resolveModelInfo('loomy', 'spark-x')
    expect(spark.reasoning?.efforts.map(effort => effort.id).sort()).toEqual(['high', 'low', 'medium', 'off', 'xhigh'])

    // Image capability follows the per-model flag.
    const modalities = new Map((await ctx.llm.listModels('loomy')).map(model => [model.id, model.inputModalities]))
    expect(modalities.get('spark-x')).toEqual(['text'])
    expect(modalities.get('GLM-5.3-Flash')).toContain('image')
  })
})
