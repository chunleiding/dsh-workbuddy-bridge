/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

/**
 * The client entry degrades a slot-API breaking change (the rc.6→rc.7
 * `id`→`key` rename that caused the red "Failed to load plugins" banner)
 * to console.error calls, so the host providers keep working without a
 * banner.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages); instead we replicate the exact guarded shape from
 * `src/client/index.tsx` + each driver's `register*Card` and assert both
 * registrations swallow a simulated throw independently.
 *
 * DRIFT WARNING: the functions below are manual mirrors of the real ones
 * in `src/client/index.tsx`,
 * `src/drivers/workbuddy/client/index.tsx`, and
 * `src/drivers/loomy/client/index.tsx`. They are NOT product code, so this
 * test only proves the fallback idea — it cannot detect a regression in the
 * real entries. Keep the guarded bodies and console.error messages in sync.
 */
describe('client card fallback', () => {
  it('swallows slot registration failures from both drivers instead of throwing', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })

    // Simulate a DSH loader that throws on ctx.slots.inject for every driver.
    const fakeCtx: any = {
      effect: () => {},
      locale: { register: () => () => {}, bind: () => () => '' },
      slots: {
        inject: () => { throw new Error('keyed slot "settings.plugin.item" requires options.key') },
      },
    }

    // Mirrors of drivers/workbuddy/client/index.tsx and drivers/loomy/client/index.tsx.
    function registerWorkBuddyCard(ctx: any): void {
      try {
        const namespace = 'settings.workbuddy'
        ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-llm-bridge: workbuddy settings copy')
        const t = ctx.locale.bind(namespace)
        ctx.slots.inject('settings.plugin.item', () => { throw new Error('not reached') })
        void t
      } catch (error: unknown) {
        console.error('[dsh-llm-bridge] workbuddy client card failed to load (host provider unaffected):', error)
      }
    }
    function registerLoomyCard(ctx: any): void {
      try {
        const namespace = 'settings.loomy'
        ctx.effect(() => ctx.locale.register(namespace, { zh: {}, en: {} }), 'dsh-llm-bridge: loomy settings copy')
        const t = ctx.locale.bind(namespace)
        ctx.slots.inject('settings.plugin.item', () => { throw new Error('not reached') })
        void t
      } catch (error: unknown) {
        console.error('[dsh-llm-bridge] loomy client card failed to load (host provider unaffected):', error)
      }
    }

    // Mirror of src/client/index.tsx apply().
    function apply(ctx: any): void {
      registerWorkBuddyCard(ctx)
      registerLoomyCard(ctx)
    }

    // Must not throw — the whole point of the fallback.
    expect(() => apply(fakeCtx)).not.toThrow()

    // Both failures are visible in the console, and neither aborts the other.
    expect(errors).toHaveLength(2)
    expect(String(errors[0])).toContain('workbuddy client card failed to load')
    expect(String(errors[1])).toContain('loomy client card failed to load')
    for (const error of errors) expect(String(error)).toContain('requires options.key')

    spy.mockRestore()
  })

  it('keeps registering the second card when only one driver throws', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    let loomyRegistered = false
    const fakeCtx: any = {
      effect: () => {},
      locale: { register: () => () => {}, bind: () => () => '' },
      slots: {
        inject: (name: string) => {
          if (name !== 'settings.plugin.item') return
          // WorkBuddy (first) throws; Loomy (second) must still register.
          if (!loomyRegistered && errors.length === 0) {
            loomyRegistered = false
            throw new Error('workbuddy slot boom')
          }
          loomyRegistered = true
        },
      },
    }

    function guarded(label: string, ctx: any): void {
      try {
        ctx.slots.inject('settings.plugin.item', () => {})
      } catch (error: unknown) {
        console.error(`[dsh-llm-bridge] ${label} client card failed:`, error)
      }
    }
    expect(() => { guarded('workbuddy', fakeCtx); guarded('loomy', fakeCtx) }).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(loomyRegistered).toBe(true)

    spy.mockRestore()
  })
})
