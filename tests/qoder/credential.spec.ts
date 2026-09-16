import { describe, expect, it } from 'vitest'
import {
  credentialFromUserInfo,
  epochMsOf,
  isUsableMachineId,
  mergeRefreshOutcome,
  normalizeOrganizationTags,
  parseQoderRefreshResponse,
  qoderCredentialKey,
  runtimeAuthFieldsInput,
  signingUserInfo,
} from '../../src/drivers/qoder/credential.ts'

const MACHINE_ID = '4b394435-3735-432d-9751-436d4b39442d'

/** A credential document shaped like the one the app seals on disk. */
function userInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 'u-1',
    name: 'Some User',
    access_token: 'dt-abc',
    security_oauth_token: 'dt-abc',
    refresh_token: 'drt-abc',
    expire_time: 1_783_558_148_000,
    refresh_token_expire_time: 1_812_070_148_000,
    login_method: 'browser',
    user_type: 'personal_professional',
    user_tag: 'Pro',
    organization_id: '',
    organization_tags: null,
    data_policy_agreed: true,
    encrypt_user_info: '',
    key: '',
    allow_byok: 0,
    ...overrides,
  }
}

describe('Qoder credential derivation', () => {
  it('derives the sealing key from the first 16 characters of the machine id', () => {
    expect(qoderCredentialKey(MACHINE_ID)).toBe('4b394435-3735-43')
    // The key is ASCII, not binary: it is a slice of a UUID string.
    expect(qoderCredentialKey(MACHINE_ID)).toHaveLength(16)
    expect(qoderCredentialKey(` ${MACHINE_ID}\n`)).toBe('4b394435-3735-43')
  })

  it('rejects a machine id too short to yield a key', () => {
    expect(isUsableMachineId(MACHINE_ID)).toBe(true)
    expect(isUsableMachineId('short')).toBe(false)
  })

  it('coerces organization_tags to an array the wasm will accept', () => {
    expect(normalizeOrganizationTags(null)).toEqual([])
    expect(normalizeOrganizationTags(undefined)).toEqual([])
    expect(normalizeOrganizationTags('tag')).toEqual([])
    expect(normalizeOrganizationTags(['a', 2, 'b'])).toEqual(['a', 'b'])
  })

  it('reads epoch milliseconds from either spelling the app uses', () => {
    expect(epochMsOf(1_783_558_148_000)).toBe(1_783_558_148_000)
    // Seconds are promoted rather than mistaken for milliseconds.
    expect(epochMsOf(1_783_558_148)).toBe(1_783_558_148_000)
    expect(epochMsOf('2026-07-09T00:00:00.000Z')).toBe(Date.parse('2026-07-09T00:00:00.000Z'))
    expect(epochMsOf('')).toBeUndefined()
    expect(epochMsOf(0)).toBeUndefined()
    expect(epochMsOf(undefined)).toBeUndefined()
  })

  it('projects the document into a credential and keeps it for write-back', () => {
    const document = userInfo()
    const credential = credentialFromUserInfo(document, MACHINE_ID)
    expect(credential).toMatchObject({
      accessToken: 'dt-abc',
      refreshToken: 'drt-abc',
      expiresAtMs: 1_783_558_148_000,
      refreshExpiresAtMs: 1_812_070_148_000,
      machineId: MACHINE_ID,
      uid: 'u-1',
      displayName: 'Some User',
      userTag: 'Pro',
      organizationId: '',
      dataPolicyAgreed: true,
    })
    expect(credential.organizationTags).toEqual([])
    // The untouched document is carried so a rotation can be re-sealed whole.
    expect(credential.rawUserInfo).toBe(document)
  })

  it('survives a document with the optional fields absent', () => {
    const credential = credentialFromUserInfo({ uid: 'u-1' }, MACHINE_ID)
    expect(credential.accessToken).toBe('')
    expect(credential.refreshToken).toBe('')
    expect(credential.expiresAtMs).toBe(0)
    expect(credential.refreshExpiresAtMs).toBeUndefined()
    expect(credential.displayName).toBeUndefined()
    expect(credential.organizationTags).toEqual([])
    expect(credential.dataPolicyAgreed).toBe(false)
  })
})

describe('Qoder refresh answers', () => {
  it('normalizes the documented response shape', () => {
    const outcome = parseQoderRefreshResponse({
      device_token: 'dt-new',
      refresh_token: 'drt-new',
      token_type: 'Bearer',
      expires_at: '2026-10-01T00:00:00.000Z',
      refresh_token_expires_at: '2027-06-04T00:00:00.000Z',
    })
    expect(outcome.deviceToken).toBe('dt-new')
    expect(outcome.refreshToken).toBe('drt-new')
    expect(outcome.expiresAtMs).toBe(Date.parse('2026-10-01T00:00:00.000Z'))
    expect(outcome.refreshExpiresAtMs).toBe(Date.parse('2027-06-04T00:00:00.000Z'))
  })

  it('accepts the alternative refresh-expiry spellings', () => {
    const spelling = (key: string): number | undefined => parseQoderRefreshResponse({
      device_token: 'dt-new',
      refresh_token: 'drt-new',
      expires_at: '2026-10-01T00:00:00.000Z',
      [key]: '2027-06-04T00:00:00.000Z',
    }).refreshExpiresAtMs
    expect(spelling('refresh_token_expire_at')).toBe(Date.parse('2027-06-04T00:00:00.000Z'))
    expect(spelling('refresh_token_expire_time')).toBe(Date.parse('2027-06-04T00:00:00.000Z'))
  })

  it('refuses an answer without the fields the driver must have', () => {
    const base = { device_token: 'dt-new', refresh_token: 'drt-new', expires_at: '2026-10-01T00:00:00.000Z' }
    expect(() => parseQoderRefreshResponse(null)).toThrow(/unexpected document/u)
    expect(() => parseQoderRefreshResponse({ ...base, device_token: '' })).toThrow(/no device_token/u)
    expect(() => parseQoderRefreshResponse({ ...base, refresh_token: undefined })).toThrow(/no refresh_token/u)
    expect(() => parseQoderRefreshResponse({ ...base, expires_at: 'soon' })).toThrow(/no usable expires_at/u)
  })

  it('moves the device token and the refresh token together, preserving everything else', () => {
    const document = userInfo()
    const merged = mergeRefreshOutcome(document, {
      deviceToken: 'dt-new',
      refreshToken: 'drt-new',
      expiresAtMs: 1_800_000_000_000,
      refreshExpiresAtMs: 1_900_000_000_000,
    })
    expect(merged['access_token']).toBe('dt-new')
    // Two views of one token; leaving one behind produced a 403 in testing.
    expect(merged['security_oauth_token']).toBe('dt-new')
    expect(merged['refresh_token']).toBe('drt-new')
    expect(merged['expire_time']).toBe(1_800_000_000_000)
    expect(merged['refresh_token_expire_time']).toBe(1_900_000_000_000)
    // Unrelated fields — including ones this driver does not model — survive,
    // because the result is re-sealed into the file the app reads.
    expect(merged['user_tag']).toBe('Pro')
    expect(merged['allow_byok']).toBe(0)
    expect(document['access_token']).toBe('dt-abc')
  })

  it('leaves the refresh expiry alone when the answer omits it', () => {
    const merged = mergeRefreshOutcome(userInfo(), {
      deviceToken: 'dt-new', refreshToken: 'drt-new', expiresAtMs: 1_800_000_000_000,
    })
    expect(merged['refresh_token_expire_time']).toBe(1_812_070_148_000)
  })
})

describe('Qoder signing input', () => {
  const credential = {
    uid: 'u-1',
    organizationId: 'org-1',
    organizationTags: ['a'],
    dataPolicyAgreed: true,
  }

  it('seeds field derivation with identity and consent only', () => {
    expect(JSON.parse(runtimeAuthFieldsInput(credential))).toEqual({
      uid: 'u-1',
      organization_id: 'org-1',
      organization_tags: ['a'],
      data_policy_agreed: true,
    })
  })

  it('builds the signing userInfo around the derived fields', () => {
    const parsed = JSON.parse(signingUserInfo(credential, { encrypt_user_info: 'enc', key: 'k' })) as Record<string, unknown>
    expect(parsed).toEqual({
      uid: 'u-1',
      encrypt_user_info: 'enc',
      key: 'k',
      organization_id: 'org-1',
      organization_tags: ['a'],
      data_policy_agreed: true,
    })
    // Never the raw refresh token: the signing context has no use for it.
    expect(JSON.stringify(parsed)).not.toContain('drt-')
  })
})
