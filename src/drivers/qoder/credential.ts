/**
 * Qoder's credential shape, its on-disk document, and the pure derivations
 * between them.
 *
 * The interesting facts, all established by reversing the app (see
 * `docs/qoder-driver-research.md`):
 *
 * - The credential document is **sealed** with a 16-character key that is
 *   *not* stored anywhere: `key = machine_id.trim().slice(0, 16)`. The machine
 *   id sits next to the credential and is itself a plain-text UUID, so the key
 *   is ASCII, not binary — the detail that kept an earlier attempt stuck.
 * - `encrypt_user_info` and `key` look like credential fields but are **empty
 *   on disk**. They are regenerated at every launch by the wasm from the
 *   account identity (`uid` + organization + data-policy) and must be present
 *   on every authenticated request; omitting them is a `403 Signature invalid`
 *   with no other symptom.
 * - `expire_time` is epoch **milliseconds**, not seconds.
 * - The refresh token **rotates** on every refresh, so a refreshed credential
 *   has to be written back or the user's app is left holding a dead token.
 *
 * Nothing here performs I/O: the file layout lives in `auth.ts`, the wasm
 * calls in `wasm.ts`. Keeping the derivations pure is what lets them be tested
 * without a Qoder install.
 *
 * @module dsh-llm-bridge/drivers/qoder/credential
 */

/** Length of the credential key; AES-128, so 16 bytes' worth of ASCII. */
export const QODER_CREDENTIAL_KEY_LENGTH = 16

/** The app's own credential document, kept opaque. */
export type QoderUserInfo = Record<string, unknown>

/** One refresh answer, normalized. */
export interface QoderRefreshOutcome {
  /** New device token (`dt-…`); becomes both `access_token` and `security_oauth_token`. */
  deviceToken: string
  /** Rotated refresh token (`drt-…`); the app's stored one is dead without it. */
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
}

/** Normalized Qoder credential, timestamps in epoch milliseconds. */
export interface QoderCredential {
  /** Raw access credential put on the wire by the wasm. */
  accessToken: string
  /** Rotating refresh token; a single use invalidates it. */
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  /**
   * The machine id. It is both the pairing half of the credential files and
   * the source of the sealing key ({@link qoderCredentialKey}).
   */
  machineId: string
  uid: string
  /** Account label for diagnostics; the app shows a display name, never the uid. */
  displayName?: string
  userType?: string
  userTag?: string
  organizationId: string
  /** Always an array: the wasm rejects `null` for this field. */
  organizationTags: readonly string[]
  dataPolicyAgreed: boolean
  /**
   * The app's own document, carried so a rotation can be re-sealed with every
   * untouched field intact. Never logged, never sent anywhere, and never
   * exposed through {@link QoderAuthStatus}.
   */
  rawUserInfo: QoderUserInfo
}

/** Read-only sign-in summary for status, doctor, and the plugin card. */
export interface QoderAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  /** Display name only — never the uid. */
  nickname?: string
  /** Plan tag the app reports, e.g. `Pro`. */
  userTag?: string
}

/**
 * Derive the credential sealing key from the machine id.
 *
 * `machine_id` is a 36-character UUID; the key is its first 16 characters,
 * verbatim. The SDK also computes `sha256(machine_id)` at one point, which is
 * a *liveness fingerprint* for a different guard — it is not part of the key
 * derivation, and treating it as one is what made this look unreachable.
 */
export function qoderCredentialKey(machineId: string): string {
  return machineId.trim().slice(0, QODER_CREDENTIAL_KEY_LENGTH)
}

/** Whether a machine id can produce a usable key. */
export function isUsableMachineId(machineId: string): boolean {
  return machineId.trim().length >= QODER_CREDENTIAL_KEY_LENGTH
}

/** Coerce the app's `organization_tags` into the array the wasm demands. */
export function normalizeOrganizationTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((tag): tag is string => typeof tag === 'string')
}

/**
 * Resolve an epoch-millisecond timestamp from either spelling the app uses:
 * a number (seconds or milliseconds) or an ISO-8601 string.
 */
export function epochMsOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Project the app's document plus the machine id into a credential. */
export function credentialFromUserInfo(userInfo: QoderUserInfo, machineId: string): QoderCredential {
  const organizationId = optionalString(userInfo['organization_id']) ?? ''
  const refreshExpiresAtMs = epochMsOf(userInfo['refresh_token_expire_time'])
  const displayName = optionalString(userInfo['name'])
  const userType = optionalString(userInfo['user_type'])
  const userTag = optionalString(userInfo['user_tag'])
  return {
    accessToken: optionalString(userInfo['access_token']) ?? '',
    refreshToken: optionalString(userInfo['refresh_token']) ?? '',
    expiresAtMs: epochMsOf(userInfo['expire_time']) ?? 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    machineId,
    uid: optionalString(userInfo['uid']) ?? '',
    ...displayName === undefined ? {} : { displayName },
    ...userType === undefined ? {} : { userType },
    ...userTag === undefined ? {} : { userTag },
    organizationId,
    organizationTags: normalizeOrganizationTags(userInfo['organization_tags']),
    dataPolicyAgreed: userInfo['data_policy_agreed'] === true,
    rawUserInfo: userInfo,
  }
}

/**
 * Normalize a `POST /api/v1/deviceToken/refresh` answer.
 *
 * The endpoint's field names have moved around between builds, so both the
 * `refresh_token_expires_at` and `refresh_token_expire_at` spellings are
 * accepted. A missing new refresh token is not an error worth inventing a
 * value for: the driver keeps the old one only when the server omits the
 * field, because a silently blanked token would sign the user out.
 */
export function parseQoderRefreshResponse(payload: unknown): QoderRefreshOutcome {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('qoder: token refresh returned an unexpected document')
  }
  const document = payload as Record<string, unknown>
  const deviceToken = optionalString(document['device_token'])
  if (deviceToken === undefined) {
    throw new Error('qoder: token refresh returned no device_token; sign in again in the Qoder app')
  }
  const refreshToken = optionalString(document['refresh_token'])
  if (refreshToken === undefined) {
    throw new Error('qoder: token refresh returned no refresh_token; sign in again in the Qoder app')
  }
  const expiresAtMs = epochMsOf(document['expires_at'])
  if (expiresAtMs === undefined) {
    throw new Error('qoder: token refresh returned no usable expires_at')
  }
  const refreshExpiresAtMs = epochMsOf(
    document['refresh_token_expires_at'] ?? document['refresh_token_expire_at'] ?? document['refresh_token_expire_time'],
  )
  return {
    deviceToken,
    refreshToken,
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
  }
}

/**
 * Fold a refresh answer into the app's document.
 *
 * Every other field — including ones this driver does not understand — is
 * preserved, because the result is re-sealed and written back to the file the
 * app reads. `access_token` and `security_oauth_token` are two views of the
 * same device token and must move together; leaving one behind produced a 403
 * in testing.
 */
export function mergeRefreshOutcome(userInfo: QoderUserInfo, outcome: QoderRefreshOutcome): QoderUserInfo {
  return {
    ...userInfo,
    access_token: outcome.deviceToken,
    security_oauth_token: outcome.deviceToken,
    refresh_token: outcome.refreshToken,
    expire_time: outcome.expiresAtMs,
    ...outcome.refreshExpiresAtMs === undefined
      ? {}
      : { refresh_token_expire_time: outcome.refreshExpiresAtMs },
  }
}

/**
 * The input `generate_runtime_auth_fields` is seeded with: account identity
 * plus data-policy consent, and nothing else.
 */
export function runtimeAuthFieldsInput(credential: {
  uid: string
  organizationId: string
  organizationTags: readonly string[]
  dataPolicyAgreed: boolean
}): string {
  return JSON.stringify({
    uid: credential.uid,
    organization_id: credential.organizationId,
    organization_tags: [...credential.organizationTags],
    data_policy_agreed: credential.dataPolicyAgreed,
  })
}

/**
 * The `userInfo` JSON the signing context is constructed with.
 *
 * The two derived fields are the load-bearing part: `encrypt_user_info` and
 * `key` are empty in the stored document, so the caller must pass what
 * `generate_runtime_auth_fields` produced. This is exactly the SDK's
 * `regenerateRuntimeFields()` + `getUserInfoForAuth()` pair.
 */
export function signingUserInfo(
  credential: {
    uid: string
    organizationId: string
    organizationTags: readonly string[]
    dataPolicyAgreed: boolean
  },
  generated: { encrypt_user_info: string; key: string },
): string {
  return JSON.stringify({
    uid: credential.uid,
    encrypt_user_info: generated.encrypt_user_info,
    key: generated.key,
    organization_id: credential.organizationId,
    organization_tags: [...credential.organizationTags],
    data_policy_agreed: credential.dataPolicyAgreed,
  })
}
