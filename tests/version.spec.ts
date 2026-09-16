import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRIDGE_VERSION } from '../src/core/version.ts'

/**
 * Guard the single-source-of-truth version contract:
 * - the build-time define injects package.json's version into
 *   src/core/version.ts;
 * - if that define is ever dropped, version.ts falls back to '0.0.0-dev' and
 *   this test goes red, flagging the regression (and the drift it would cause
 *   in heartbeat / CLI output).
 */
describe('package version sync', () => {
  it('BRIDGE_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(BRIDGE_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(BRIDGE_VERSION).not.toBe('0.0.0-dev')
  })

  /**
   * The define reads package.json at BUILD time, so a release that bumps the
   * version after building ships artifacts reporting the old one (issue #1:
   * v0.2.2 bundles said 0.2.1). The version literal lands in the built
   * chunks (heartbeat and CLI report it); when lib/ artifacts are present,
   * at least one of them must carry the current version. The scan is chunk
   * name independent so a core/driver reshuffle does not break the guard.
   * Skipped on a fresh clone before the first build.
   */
  it('built lib/ artifacts carry the current version when present', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const chunks = readdirSync(libDir).filter(f => f.endsWith('.js'))
    expect(chunks.length, 'no JS chunks found in lib/ — run the build first').toBeGreaterThan(0)
    const carriers = chunks.filter(chunk =>
      readFileSync(new URL(`../lib/${chunk}`, import.meta.url), 'utf8').includes(`"${pkg.version}"`),
    )
    expect(carriers.join(', '), 'no lib/ chunk carries the current version — rebuild before committing or publishing').not.toBe('')
  })
})
