import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LoomySessionStore,
  parseLoomySession,
  LOOMY_SESSION_FILE_ENV,
} from '../../src/drivers/loomy/auth.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

async function makeFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-auth-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, name)
  await writeFile(file, content, 'utf8')
  return file
}

describe('parseLoomySession', () => {
  it('reads session and updatedAt but never the phone PII field', () => {
    const parsed = parseLoomySession(JSON.stringify({
      session: 'abc123',
      userid: 'u-1',
      phone: '13800000000',
      updatedAt: 1_700_000_000_000,
    }))
    expect(parsed).toEqual({ session: 'abc123', updatedAtMs: 1_700_000_000_000 })
    expect(JSON.stringify(parsed)).not.toContain('13800000000')
  })

  it('trims the session and accepts seconds-era timestamps', () => {
    expect(parseLoomySession(JSON.stringify({ session: '  abc  ', updatedAt: 1_700_000_000 })))
      .toEqual({ session: 'abc', updatedAtMs: 1_700_000_000_000 })
  })

  it('returns undefined for empty, malformed, or non-object documents', () => {
    expect(parseLoomySession('{ bad')).toBeUndefined()
    expect(parseLoomySession(JSON.stringify({ session: '' }))).toBeUndefined()
    expect(parseLoomySession(JSON.stringify({ updatedAt: 1 }))).toBeUndefined()
    expect(parseLoomySession(JSON.stringify([1, 2]))).toBeUndefined()
    expect(parseLoomySession(JSON.stringify('session'))).toBeUndefined()
  })
})

describe('LoomySessionStore', () => {
  it('resolves the session from an explicit file and reports signed-in status', async () => {
    const file = await makeFile('auth-session.json', JSON.stringify({ session: 'sess-1', phone: '138', updatedAt: 1_700_000_000_000 }))
    const store = new LoomySessionStore({ sessionFile: file })
    const session = await store.resolve()
    expect(session.session).toBe('sess-1')
    expect((await store.status()).state).toBe('signed-in')
    expect(await store.sessionFilePresent()).toBe(true)
  })

  it('honors the environment override', async () => {
    const file = await makeFile('auth-session.json', JSON.stringify({ session: 'env-sess' }))
    const saved = process.env[LOOMY_SESSION_FILE_ENV]
    process.env[LOOMY_SESSION_FILE_ENV] = file
    try {
      const store = new LoomySessionStore()
      expect(store.sessionFilePath()).toBe(file)
      expect((await store.resolve()).session).toBe('env-sess')
    } finally {
      if (saved === undefined) delete process.env[LOOMY_SESSION_FILE_ENV]
      else process.env[LOOMY_SESSION_FILE_ENV] = saved
    }
  })

  it('throws a signed-out error when no session file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loomy-empty-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new LoomySessionStore({ sessionFile: join(dir, 'missing.json') })
    await expect(store.resolve()).rejects.toThrow(/loomy: no signed-in Loomy session/)
    expect((await store.status()).state).toBe('signed-out')
    expect(await store.sessionFilePresent()).toBe(false)
  })

  it('re-reads on every resolve so a desktop re-login is followed', async () => {
    const file = await makeFile('auth-session.json', JSON.stringify({ session: 'first' }))
    const store = new LoomySessionStore({ sessionFile: file })
    expect((await store.resolve()).session).toBe('first')
    await writeFile(file, JSON.stringify({ session: 'second' }), 'utf8')
    expect((await store.resolve()).session).toBe('second')
  })

  it('logout is a no-op that never touches the desktop file', async () => {
    const file = await makeFile('auth-session.json', JSON.stringify({ session: 'keep' }))
    const store = new LoomySessionStore({ sessionFile: file })
    await store.logout()
    expect((await store.resolve()).session).toBe('keep')
  })
})
