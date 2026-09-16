/**
 * Platform-agnostic credential lifecycle: demand-driven refresh with an
 * expiry margin, single-flight de-duplication, and a "keep serving a
 * not-yet-expired credential when the refresh fails" policy.
 *
 * The core deliberately knows NOTHING about storage. It does not assume a
 * JSON file, a keychain entry, or an environment variable: the driver reads
 * its freshest credential however its platform stores it and owns the
 * refresh protocol, response merging, and persistence. Only the credential
 * shape (`expiresAtMs`) is shared, because expiry is what the lifecycle
 * keys off.
 *
 * @module dsh-llm-bridge/core/credential
 */

/** The one credential fact the lifecycle needs: an absolute expiry time. */
export interface ExpiringCredential {
  /** Epoch milliseconds when the access credential expires. */
  expiresAtMs: number
}

/** Constructor options for {@link CredentialRefresher}. */
export interface CredentialRefresherOptions<C extends ExpiringCredential> {
  /**
   * Produce the refreshed credential (perform the platform refresh, merge
   * the outcome, persist it). Throws a platform-specific error when the
   * refresh cannot succeed; the refresher then falls back to the existing
   * credential while it is still valid.
   */
  refresh: (credential: C) => Promise<C>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/**
 * Demand-driven, single-flight credential refresh over an arbitrary storage
 * backend. One instance per credential source.
 */
export class CredentialRefresher<C extends ExpiringCredential> {
  private readonly refresh: (credential: C) => Promise<C>
  private readonly refreshMarginMs: number
  private inflight: Promise<C> | undefined

  constructor(options: CredentialRefresherOptions<C>) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
  }

  /** Whether the credential is inside the refresh margin (or already expired). */
  needsRefresh(credential: C): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  /**
   * Return the credential to put on the wire: the given one unchanged while
   * it is fresh, otherwise a refreshed one. Single-flight, so parallel
   * callers share one in-flight refresh; the driver owns the signed-out
   * case (it decides how a missing credential is discovered and reported).
   */
  async refreshIfNeeded(credential: C): Promise<C> {
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * A failed refresh still returns a credential valid for at least another
   * 30 seconds, so an unreachable refresh endpoint does not take down a
   * working session. Once the credential is effectively expired the
   * driver's own error is rethrown verbatim — diagnostics wording belongs to
   * the platform, never to the core.
   */
  private async refreshNow(credential: C): Promise<C> {
    try {
      return await this.refresh(credential)
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw error
    }
  }
}
