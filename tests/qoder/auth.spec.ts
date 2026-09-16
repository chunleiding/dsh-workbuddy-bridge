import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QoderCredentialStore, defaultAuthDirectoryCandidates } from '../../src/drivers/qoder/auth.ts'
import { qoderCredentialKey } from '../../src/drivers/qoder/credential.ts'
import { loadQoderWasm } from '../../src/drivers/qoder/wasm.ts'
import {
  FIXTURE_MACHINE_ID,
  fixtureUserInfo,
  mustNotRefresh,
  refreshOutcome,
  writeFixtureAuthDir,
} from './fixtures.ts'

const CLEANUP: (() => Promise<void>)[] = []
const api = loadQoderWasm()

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function track(directory: string): string {
  CLEANUP.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Read the sealed credential back off disk, exactly as the app would. */
async function readSealed(directory: string, machineId = FIXTURE_MACHINE_ID): Promise<Record<string, unknown>> {
  const blob = (await readFile(join(directory, 'user'), 'utf8')).trim()
  return JSON.parse(api.credential_storage_decrypt(blob, qoderCredentialKey(machineId))) as Record<string, unknown>
}

describe('defaultAuthDirectoryCandidates', () => {
  it('probes the shipped directory before the SDK one', () => {
    const candidates = defaultAuthDirectoryCandidates()
    expect(candidates.length).toBe(2)
    expect(candidates[0]).toContain(join('.qoderworkcn', '.auth-cn'))
    expect(candidates[1]).toContain(join('.qoderworkcn', '.auth'))
  })
})

describe('QoderCredentialStore discovery', () => {
  it('decrypts the sealed credential and maps the account fields', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    const store = new QoderCredentialStore({ authDir: auth.directory, refresh: mustNotRefresh })

    const credential = await store.current()
    expect(credential?.accessToken).toBe('dt-fixture-access')
    expect(credential?.refreshToken).toBe('drt-fixture-refresh')
    expect(credential?.machineId).toBe(FIXTURE_MACHINE_ID)
    expect(credential?.uid).toBe('uid-fixture')
    expect(credential?.displayName).toBe('Fixture User')
    expect(credential?.userTag).toBe('Pro')
    expect(credential?.organizationId).toBe('org-fixture')
    expect(credential?.organizationTags).toEqual([])
    expect(credential?.dataPolicyAgreed).toBe(true)
    expect(credential?.expiresAtMs).toBeGreaterThan(Date.now())
    // The app's document is carried verbatim so a rotation can be re-sealed.
    expect(credential?.rawUserInfo['security_oauth_token']).toBe('dt-fixture-access')
  })

  it('reports the machine id file it actually used', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    const store = new QoderCredentialStore({ authDir: auth.directory, refresh: mustNotRefresh })
    expect(await store.authDirPresent()).toBe(true)
    expect(store.authDirPath()).toBe(auth.directory)
    expect(store.credentialPath()).toBe(join(auth.directory, 'user'))
  })

  it('accepts the SDK machine-id filename too', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    await rm(join(auth.directory, 'id'))
    await writeFile(join(auth.directory, 'machine_id'), `${FIXTURE_MACHINE_ID}\n`)
    const store = new QoderCredentialStore({ authDir: auth.directory, refresh: mustNotRefresh })
    expect((await store.current())?.machineId).toBe(FIXTURE_MACHINE_ID)
  })

  it('never pairs a credential with a machine id from another directory', async () => {
    // The real install has `.auth` and `.auth-cn` side by side with different
    // machine ids, and only one of them decrypts. Taking a machine id from a
    // sibling directory would silently fail to open the credential, so a
    // half-present candidate is skipped instead.
    const withCredential = await writeFixtureAuthDir()
    track(withCredential.directory)
    await rm(join(withCredential.directory, 'id'))
    const store = new QoderCredentialStore({
      // Both layouts are probed, in order; neither holds both halves.
      authDir: withCredential.directory,
      refresh: mustNotRefresh,
    })
    expect(await store.authDirPresent()).toBe(false)
    expect(await store.current()).toBeUndefined()
  })

  it('returns undefined rather than throwing when nothing is signed in', async () => {
    const store = new QoderCredentialStore({ authDir: '/nonexistent/qoder-auth', refresh: mustNotRefresh })
    expect(await store.current()).toBeUndefined()
    expect(await store.authDirPresent()).toBe(false)
  })

  it('fails with an actionable message when there is no account', async () => {
    const store = new QoderCredentialStore({ authDir: '/nonexistent/qoder-auth', refresh: mustNotRefresh })
    await expect(store.resolve()).rejects.toThrow(/sign in once in the Qoder app/u)
    // The remedy has to be in the message, since this is what a user sees.
    await expect(store.resolve()).rejects.toThrow(/QODER_AUTH_DIR/u)
  })

  it('reads the auth directory from the environment when none is configured', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    process.env['QODER_AUTH_DIR'] = auth.directory
    try {
      const store = new QoderCredentialStore({ refresh: mustNotRefresh })
      expect((await store.current())?.machineId).toBe(FIXTURE_MACHINE_ID)
    } finally {
      delete process.env['QODER_AUTH_DIR']
    }
  })

  it('repoints the auth directory without restarting', async () => {
    const first = await writeFixtureAuthDir()
    track(first.directory)
    const second = await writeFixtureAuthDir(fixtureUserInfo({ uid: 'uid-second' }))
    track(second.directory)
    const store = new QoderCredentialStore({ authDir: first.directory, refresh: mustNotRefresh })
    expect((await store.current())?.uid).toBe('uid-fixture')
    store.setAuthDir(second.directory)
    expect((await store.current())?.uid).toBe('uid-second')
  })
})

describe('QoderCredentialStore status and logout', () => {
  it('summarizes the sign-in without exposing the uid', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    const store = new QoderCredentialStore({ authDir: auth.directory, refresh: mustNotRefresh })
    const status = await store.status()
    expect(status.state).toBe('signed-in')
    expect(status.nickname).toBe('Fixture User')
    expect(status.userTag).toBe('Pro')
    expect(status.expiresAtMs).toBeGreaterThan(Date.now())
    expect(JSON.stringify(status)).not.toContain('uid-fixture')
  })

  it('never throws when signed out', async () => {
    const store = new QoderCredentialStore({ authDir: '/nonexistent/qoder-auth', refresh: mustNotRefresh })
    expect(await store.status()).toEqual({ state: 'signed-out' })
  })

  it('leaves the app own credential file alone on logout', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    const store = new QoderCredentialStore({ authDir: auth.directory, refresh: mustNotRefresh })
    await store.logout()
    // The driver owns no credential copy to remove; signing out is the app's job.
    expect(await readdir(auth.directory)).toContain('user')
    expect(await store.current()).toBeDefined()
  })
})

describe('QoderCredentialStore refresh', () => {

  it('leaves a fresh credential untouched', async () => {
    const auth = await writeFixtureAuthDir()
    track(auth.directory)
    let refreshes = 0
    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refresh: async () => {
        refreshes += 1
        return refreshOutcome('dt-unused', 'drt-unused')
      },
    })
    const resolved = await store.resolve()
    expect(resolved.accessToken).toBe('dt-fixture-access')
    expect(refreshes).toBe(0)
  })

  it('re-seals a rotation back into the app own credential file', async () => {
    const auth = await writeFixtureAuthDir(fixtureUserInfo({ expire_time: Date.now() - 60_000 }))
    track(auth.directory)
    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refreshMarginMs: 0,
      refresh: async () => refreshOutcome('dt-rotated', 'drt-rotated'),
    })

    const resolved = await store.resolve()
    expect(resolved.accessToken).toBe('dt-rotated')
    expect(resolved.refreshToken).toBe('drt-rotated')
    expect(resolved.expiresAtMs).toBeGreaterThan(Date.now())

    // The rotation has to land in the file the *app* reads: the refresh token
    // sent upstream is dead the moment it is used, so a bridge that kept the
    // new one to itself would leave the user's Qoder app signed out.
    const sealed = await readSealed(auth.directory)
    expect(sealed['refresh_token']).toBe('drt-rotated')
    // Both views of the device token move together; leaving one behind is a 403.
    expect(sealed['access_token']).toBe('dt-rotated')
    expect(sealed['security_oauth_token']).toBe('dt-rotated')
    expect(sealed['refresh_token_expire_time']).toBeGreaterThan(Date.now())
    // Fields the driver does not understand survive the re-seal untouched.
    expect(sealed['uid']).toBe('uid-fixture')
    expect(sealed['encrypt_user_info']).toBe('')
    expect(sealed['key']).toBe('')

    const entries = await readdir(auth.directory)
    const backups = entries.filter(name => name.includes('.bak-'))
    expect(backups.length).toBe(1)
    expect(api.credential_storage_decrypt(
      (await readFile(join(auth.directory, backups[0]!), 'utf8')).trim(),
      qoderCredentialKey(auth.machineId),
    )).toContain('drt-fixture-refresh')
    // A crash mid-write must not be able to leave a stray temp file behind.
    expect(entries.some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('abandons the write when the app rotated first, and keeps the newer token', async () => {
    const auth = await writeFixtureAuthDir(fixtureUserInfo({ expire_time: Date.now() - 60_000 }))
    track(auth.directory)
    // The app's own newer credential, produced while our refresh was in flight.
    const appSide = await writeFixtureAuthDir(fixtureUserInfo({
      access_token: 'dt-app',
      security_oauth_token: 'dt-app',
      refresh_token: 'drt-app',
      expire_time: Date.now() - 30_000,
    }))
    track(appSide.directory)

    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refreshMarginMs: 0,
      refresh: async () => {
        await writeFile(join(auth.directory, 'user'), appSide.sealed)
        return refreshOutcome('dt-bridge', 'drt-bridge')
      },
    })

    const resolved = await store.resolve()
    // Clobbering the app's fresher credential with an older one would sign the
    // user out of their own app, so the app's file wins.
    expect(resolved.refreshToken).toBe('drt-app')
    expect((await readSealed(auth.directory))['refresh_token']).toBe('drt-app')
    const entries = await readdir(auth.directory)
    expect(entries.some(name => name.includes('.bak-'))).toBe(false)
    expect(entries.some(name => name.includes('.tmp-'))).toBe(false)
  })

  it('leaves the file alone when write-back is turned off', async () => {
    const auth = await writeFixtureAuthDir(fixtureUserInfo({ expire_time: Date.now() - 60_000 }))
    track(auth.directory)
    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refreshMarginMs: 0,
      writeBack: false,
      refresh: async () => refreshOutcome('dt-rotated', 'drt-rotated'),
    })
    const resolved = await store.resolve()
    expect(resolved.refreshToken).toBe('drt-rotated')
    expect((await readSealed(auth.directory))['refresh_token']).toBe('drt-fixture-refresh')
    expect((await readdir(auth.directory)).some(name => name.includes('.bak-'))).toBe(false)
  })

  it('keeps serving a still-valid token when the refresh endpoint fails', async () => {
    // Inside the margin, so a refresh is attempted, but not close enough to
    // expiry for the failure to be fatal.
    const auth = await writeFixtureAuthDir(fixtureUserInfo({ expire_time: Date.now() + 120_000 }))
    track(auth.directory)
    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refresh: async () => {
        throw new Error('network down')
      },
    })
    const resolved = await store.resolve()
    expect(resolved.accessToken).toBe('dt-fixture-access')
  })

  it('surfaces the driver wording once the token is genuinely expired', async () => {
    const auth = await writeFixtureAuthDir(fixtureUserInfo({ expire_time: Date.now() - 60_000 }))
    track(auth.directory)
    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refreshMarginMs: 0,
      refresh: async () => {
        throw new Error('refresh rejected')
      },
    })
    await expect(store.resolve()).rejects.toThrow(/token refresh failed/u)
    await expect(store.resolve()).rejects.toThrow(/open the Qoder app once/u)
  })

  it('reports a missing refresh token as a re-sign-in, not a network problem', async () => {
    const auth = await writeFixtureAuthDir(fixtureUserInfo({
      refresh_token: '',
      expire_time: Date.now() - 60_000,
    }))
    track(auth.directory)
    const store = new QoderCredentialStore({
      authDir: auth.directory,
      refreshMarginMs: 0,
      refresh: async () => refreshOutcome('dt-unused', 'drt-unused'),
    })
    await expect(store.resolve()).rejects.toThrow(/no refresh token is stored/u)
  })
})
