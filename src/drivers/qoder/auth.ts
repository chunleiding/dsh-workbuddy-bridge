/**
 * Qoder credential discovery, rotation, and write-back.
 *
 * Unlike the WorkBuddy and Loomy drivers, this one owns **no** credential copy
 * of its own. Qoder's refresh token rotates on every use, which means the
 * app's own file is not a read-only source of truth that can be left alone:
 * after a refresh, only the rotated token works, and a bridge that kept the
 * new one to itself would leave the user's Qoder app holding a dead token the
 * next time it starts. So the file the app reads *is* the store, and a
 * rotation is re-sealed and written back to it.
 *
 * That write is deliberately conservative:
 *
 * 1. the freshly sealed document is decrypted again and compared before
 *    anything touches the disk, so an encryption mistake can never destroy a
 *    working credential;
 * 2. the current file is copied to a timestamped `.bak-…` sibling first;
 * 3. the write itself is a `write temp + rename`, so a crash mid-write cannot
 *    leave a half-written credential;
 * 4. if the file changed since this rotation started (the app refreshed
 *    concurrently), the write is abandoned and the file's newer credential
 *    wins, rather than clobbering a fresher token with an older one.
 *
 * The refresh lifecycle (expiry margin, single-flight, keep-serving-on-failure)
 * is the core's {@link CredentialRefresher}; what is Qoder-specific is where
 * the credential lives, how it is sealed, and the rotation merge.
 *
 * @module dsh-llm-bridge/drivers/qoder/auth
 */

import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CredentialRefresher } from '../../core/credential.ts'
import {
  credentialFromUserInfo,
  isUsableMachineId,
  mergeRefreshOutcome,
  qoderCredentialKey,
  type QoderAuthStatus,
  type QoderCredential,
  type QoderRefreshOutcome,
  type QoderUserInfo,
} from './credential.ts'
import {
  QODER_AUTH_DIR_ENV,
  QODER_AUTH_SUBDIRECTORIES,
  QODER_CREDENTIAL_FILENAME,
  QODER_HOME_DIRNAME,
  QODER_MACHINE_ID_FILENAMES,
} from './meta.ts'
import { loadQoderWasm, type QoderWasmApi } from './wasm.ts'

/** Constructor options; only {@link refresh} is required. */
export interface QoderStoreOptions {
  /** Explicit auth directory, overriding env and platform defaults. */
  authDir?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: QoderCredential) => Promise<QoderRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /**
   * Re-seal and write the rotated credential back into the app's own file.
   * Default `true`; turning it off leaves the Qoder app to sign in again after
   * the token it holds is rotated away.
   */
  writeBack?: boolean
  /** Injected wasm module; defaults to the embedded one. */
  api?: QoderWasmApi
}

/** What one completed rotation did with the app's file. */
export type QoderWriteBackOutcome =
  | { kind: 'written'; path: string; backupPath: string }
  | { kind: 'skipped-disabled' }
  | { kind: 'superseded' }

/** One resolved auth directory and the two files it holds. */
interface AuthLocation {
  directory: string
  machineIdPath: string
  credentialPath: string
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Platform-default auth directories, in probe order, as
 * `<home>/.qoderworkcn/<sub>` for each candidate subdirectory.
 */
export function defaultAuthDirectoryCandidates(): string[] {
  const home = homedir()
  return QODER_AUTH_SUBDIRECTORIES.map(subdirectory => join(home, QODER_HOME_DIRNAME, subdirectory))
}

/**
 * Read-only credential store with demand-driven refresh and rotation
 * write-back.
 *
 * The credential itself is never cached: each read decrypts the current file,
 * so a rotation performed by the Qoder app itself is picked up immediately.
 */
export class QoderCredentialStore {
  private readonly refresh: QoderStoreOptions['refresh']
  private readonly refresher: CredentialRefresher<QoderCredential>
  private readonly writeBack: boolean
  private readonly injectedApi: QoderWasmApi | undefined
  private authDirOverride: string | undefined
  /** Last directory that yielded a credential; the write-back target. */
  private lastLocation: AuthLocation | undefined
  /** Raw credential file text at the moment it was decrypted, for the
   *  optimistic concurrency check before a write-back. */
  private lastBlob: string | undefined

  constructor(options: QoderStoreOptions) {
    this.refresh = options.refresh
    this.writeBack = options.writeBack ?? true
    this.injectedApi = options.api
    this.authDirOverride = options.authDir
    this.refresher = new CredentialRefresher<QoderCredential>({
      refresh: credential => this.refreshCredential(credential),
      ...options.refreshMarginMs === undefined ? {} : { refreshMarginMs: options.refreshMarginMs },
    })
  }

  /** The wasm module, loaded on first use. */
  private api(): QoderWasmApi {
    return this.injectedApi ?? loadQoderWasm()
  }

  /**
   * Auth directories to probe. Precedence: an explicit directory (plugin
   * configuration), then the environment variable, then the platform defaults.
   * An explicit value is used verbatim; the defaults are a probe order.
   */
  private candidates(): AuthLocation[] {
    const fromEnv = process.env[QODER_AUTH_DIR_ENV]
    const explicit = this.authDirOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    const directories = explicit !== undefined ? [explicit] : defaultAuthDirectoryCandidates()
    const locations: AuthLocation[] = []
    for (const directory of directories) {
      for (const machineIdName of QODER_MACHINE_ID_FILENAMES) {
        locations.push({
          directory,
          machineIdPath: join(directory, machineIdName),
          credentialPath: join(directory, QODER_CREDENTIAL_FILENAME),
        })
      }
    }
    return locations
  }

  /** Repoint the auth directory; a settings change applies on the next read. */
  setAuthDir(directory: string | undefined): void {
    this.authDirOverride = directory
  }

  /** The directory probed first, for diagnostics. */
  authDirPath(): string | undefined {
    return this.candidates()[0]?.directory
  }

  /** The credential file probed first, for diagnostics. */
  credentialPath(): string | undefined {
    return this.candidates()[0]?.credentialPath
  }

  /** Whether any candidate holds both halves of the credential. */
  async authDirPresent(): Promise<boolean> {
    for (const location of this.candidates()) {
      try {
        await Promise.all([stat(location.credentialPath), stat(location.machineIdPath)])
        return true
      } catch {
        // absent half — try the next candidate
      }
    }
    return false
  }

  /**
   * Read the stored credential without refreshing anything.
   *
   * A candidate must hold both the machine id and the credential; a half
   * present directory is skipped rather than paired with a machine id from a
   * different directory, which would silently fail to decrypt.
   */
  async current(): Promise<QoderCredential | undefined> {
    for (const location of this.candidates()) {
      let machineId: string
      let blob: string
      try {
        machineId = (await readFile(location.machineIdPath, 'utf8')).trim()
        blob = (await readFile(location.credentialPath, 'utf8')).trim()
      } catch (error: unknown) {
        if (isENOENT(error)) continue
        throw error
      }
      if (!isUsableMachineId(machineId) || blob === '') continue
      const plaintext = this.api().credential_storage_decrypt(blob, qoderCredentialKey(machineId))
      const userInfo = JSON.parse(plaintext) as QoderUserInfo
      this.lastLocation = location
      this.lastBlob = blob
      return credentialFromUserInfo(userInfo, machineId)
    }
    return undefined
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<QoderCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.candidates()
        .map(location => location.credentialPath)
        .join(' or ')
      throw new Error(
        'qoder: no signed-in Qoder account found; sign in once in the Qoder app'
        + ` (expected ${candidates} with a machine id beside it, or ${QODER_AUTH_DIR_ENV}),`
        + ' or refresh an existing session',
      )
    }
    return this.refresher.refreshIfNeeded(credential)
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<QoderAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.displayName === undefined ? {} : { nickname: credential.displayName },
        ...credential.userTag === undefined ? {} : { userTag: credential.userTag },
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /**
   * No-op: this driver owns no credential copy.
   *
   * The credential lives in the Qoder app's own file, and the driver must keep
   * writing rotations back to it, so there is nothing separable to remove. A
   * user who wants the bridge to stop using their account signs out in Qoder.
   */
  async logout(): Promise<void> {}

  /**
   * Perform the Qoder refresh, then re-seal the result into the app's file.
   *
   * The no-refresh-token short-circuit and the error wording are what the
   * pre-refactor shape produced; the core refresher wraps this with the
   * still-valid fallback.
   */
  private async refreshCredential(credential: QoderCredential): Promise<QoderCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('qoder: the device token expired and no refresh token is stored; sign in again in the Qoder app')
    }
    try {
      const outcome = await this.refresh(credential)
      const nextUserInfo = mergeRefreshOutcome(credential.rawUserInfo, outcome)
      const refreshed = credentialFromUserInfo(nextUserInfo, credential.machineId)
      const write = await this.writeBackCredential(nextUserInfo, credential)
      if (write.kind === 'superseded') {
        // The app (or another bridge process) rotated first. Its credential is
        // newer than ours, so re-read instead of returning what we computed.
        return await this.current() ?? refreshed
      }
      return refreshed
    } catch (error: unknown) {
      throw new Error(
        `qoder: token refresh failed and the device token is expired (${String(error)});`
        + ' open the Qoder app once to sign in again',
      )
    }
  }

  /**
   * Re-seal `userInfo` and replace the app's credential file with it.
   *
   * Verification happens *before* the backup and the write: the sealed text is
   * decrypted and checked, so a sealing mistake aborts with the original file
   * still intact.
   */
  private async writeBackCredential(
    userInfo: QoderUserInfo,
    credential: QoderCredential,
  ): Promise<QoderWriteBackOutcome> {
    const location = this.lastLocation
    const baseline = this.lastBlob
    if (!this.writeBack || location === undefined || baseline === undefined) {
      return { kind: 'skipped-disabled' }
    }
    const api = this.api()
    const key = qoderCredentialKey(credential.machineId)
    const sealed = api.credential_storage_encrypt(JSON.stringify(userInfo), key)

    // Pre-flight: the file we are about to overwrite must still be the one this
    // rotation started from, and the sealed text must read back.
    const onDisk = (await readFile(location.credentialPath, 'utf8')).trim()
    if (onDisk !== baseline) return { kind: 'superseded' }
    const reopened = JSON.parse(api.credential_storage_decrypt(sealed, key)) as QoderUserInfo
    if (reopened['refresh_token'] !== userInfo['refresh_token']) {
      throw new Error('qoder: refusing to write back a credential that does not round-trip')
    }

    const backupPath = `${location.credentialPath}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    await copyFile(location.credentialPath, backupPath)
    const temporaryPath = `${location.credentialPath}.tmp-${process.pid}`
    const mode = await stat(location.credentialPath).then(info => info.mode & 0o777).catch(() => 0o600)
    try {
      await writeFile(temporaryPath, sealed, { mode })
      await rename(temporaryPath, location.credentialPath)
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    this.lastBlob = sealed
    return { kind: 'written', path: location.credentialPath, backupPath }
  }
}
