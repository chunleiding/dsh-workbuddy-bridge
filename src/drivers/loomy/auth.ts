/**
 * Loomy session discovery. The Loomy desktop app stores a plaintext session
 * string (32-hex) in `auth-session.json`; there is no refresh protocol and
 * no owned copy — the file is re-read on every request so an account
 * re-login in the desktop app is followed automatically.
 *
 * PII guard: the session file also carries `phone`, which this module never
 * parses, keeps in memory, logs, or surfaces to the status card.
 *
 * @module dsh-llm-bridge/drivers/loomy/auth
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, join } from 'node:path'
import { LOOMY_SESSION_FILE_ENV, LOOMY_SESSION_FILENAME } from './meta.ts'

export { LOOMY_SESSION_FILE_ENV }

/** Normalized Loomy credential; only the session string and its refresh time. */
export interface LoomySession {
  /** The bearer/token session value (32-hex in current builds). */
  session: string
  /** Epoch milliseconds the desktop app last refreshed the sign-in. */
  updatedAtMs?: number
}

/** Read-only sign-in summary for status and doctor output. */
export interface LoomyAuthStatus {
  state: 'signed-in' | 'signed-out'
  updatedAtMs?: number
}

const SESSION_RELATIVE_PATH = ['loomy', LOOMY_SESSION_FILENAME] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows session-file candidates visible from a WSL process. */
function wslSessionCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...SESSION_RELATIVE_PATH),
    join(roamingAppData, ...SESSION_RELATIVE_PATH),
  ]
}

/**
 * Platform-default candidates for the Loomy desktop app's session file, in
 * probe order. Windows probes Local then Roaming AppData; WSL probes the
 * mounted Windows profile first.
 */
export function defaultSessionCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...SESSION_RELATIVE_PATH)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...SESSION_RELATIVE_PATH),
      join(home, 'AppData', 'Roaming', ...SESSION_RELATIVE_PATH),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...SESSION_RELATIVE_PATH)
    return isWsl() ? [...wslSessionCandidates(home), linux] : [linux]
  }
  return []
}

/** First platform-default candidate; see {@link defaultSessionCandidates}. */
export function defaultSessionPath(): string | undefined {
  return defaultSessionCandidates()[0]
}

/** Normalize an epoch time that may arrive in seconds or milliseconds. */
function epochToMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || value <= 0) return undefined
  return value > 1e12 ? value : value * 1000
}

/**
 * Parse a Loomy session document. Only `session` and `updatedAt` are read;
 * `phone` and any other PII are deliberately ignored.
 */
export function parseLoomySession(text: string): LoomySession | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const session = typeof document['session'] === 'string' ? document['session'].trim() : ''
  if (session === '') return undefined
  const updatedAtMs = epochToMs(document['updatedAt'])
  return {
    session,
    ...updatedAtMs === undefined ? {} : { updatedAtMs },
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read-only Loomy session store. The session is long-lived and refreshed by
 * the desktop app itself, so this store only resolves the configured file —
 * no refresh lifecycle, no plugin-owned copy, no writes.
 */
export class LoomySessionStore {
  private pathOverride: string | undefined

  constructor(options?: { sessionFile?: string }) {
    this.pathOverride = options?.sessionFile
  }

  /**
   * Configuration precedence for the session file: the plugin's configured
   * path, then the environment variable, then platform defaults.
   */
  private resolveCandidates(): string[] {
    const fromEnv = process.env[LOOMY_SESSION_FILE_ENV]
    const explicit = this.pathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultSessionCandidates()
  }

  private resolvePath(): string | undefined {
    return this.resolveCandidates()[0]
  }

  /** Repoint the session file; a settings change applies on the next read. */
  setSessionPath(path: string | undefined): void {
    this.pathOverride = path
  }

  /** The resolved session-file path, for diagnostics. */
  sessionFilePath(): string | undefined {
    return this.resolvePath()
  }

  /** Read and parse the first session-file candidate that exists. */
  private async readSessionFile(): Promise<LoomySession | undefined> {
    for (const sessionPath of this.resolveCandidates()) {
      try {
        const parsed = parseLoomySession(await readFile(sessionPath, 'utf8'))
        if (parsed !== undefined) return parsed
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
  }

  /** The credential to put on the wire; re-reads the file on every call. */
  async resolve(): Promise<LoomySession> {
    const session = await this.readSessionFile()
    if (session === undefined) {
      const candidates = this.resolveCandidates()
      const expected = candidates.length > 0 ? candidates.join(' or ') : '(no platform default on this platform)'
      throw new Error(
        `loomy: no signed-in Loomy session found; sign in once in the Loomy desktop app`
        + ` (expected ${expected} or ${LOOMY_SESSION_FILE_ENV})`,
      )
    }
    return session
  }

  /** Read-only sign-in summary; never throws. */
  async status(): Promise<LoomyAuthStatus> {
    try {
      const session = await this.readSessionFile()
      if (session === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        ...session.updatedAtMs === undefined ? {} : { updatedAtMs: session.updatedAtMs },
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /** Loomy owns no plugin-side credential file, so logout is a no-op. */
  async logout(): Promise<void> {
    // The desktop app's session file is never written or removed.
  }

  /** Whether any session-file candidate exists as a regular file; diagnostics only. */
  async sessionFilePresent(): Promise<boolean> {
    for (const sessionPath of this.resolveCandidates()) {
      try {
        if ((await stat(sessionPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}
