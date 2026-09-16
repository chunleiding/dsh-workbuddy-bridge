import { describe, expect, it } from 'vitest'
import { loadQoderWasm, openServerPayload, resetQoderWasmCache } from '../../src/drivers/qoder/wasm.ts'
import { qoderCredentialKey } from '../../src/drivers/qoder/credential.ts'

/**
 * The driver has no Qoder install to lean on: the wasm module and its glue are
 * committed as base64 inside the package. These tests are the guard on that
 * vendoring step — if the artifacts are regenerated badly, or the glue and the
 * wrappers stop agreeing, they fail here instead of at a user's first request.
 */
describe('Qoder embedded wasm', () => {
  const api = loadQoderWasm()

  it('instantiates and exposes every export the driver calls', () => {
    const names = Object.keys(api.exports)
    expect(names.length).toBeGreaterThan(20)
    for (const name of [
      'credential_storage_decrypt',
      'credential_storage_encrypt',
      'decrypt_server_response',
      'generate_runtime_auth_fields',
      'qodercontext_new',
      'qodercontext_prepareInferRequest',
      'qodercontext_prepareRequest',
      'qodercontext_refreshAuthFields',
      'requestresult_url',
      'requestresult_body',
      'requestresult_headers',
    ]) {
      expect(names, `missing wasm export ${name}`).toContain(name)
    }
  })

  it('seals and re-opens a credential deterministically, with no Qoder install', () => {
    const machineId = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'
    const key = qoderCredentialKey(machineId)
    expect(key).toHaveLength(16)
    const userInfo = { uid: 'u-1', access_token: 'dt-abc', refresh_token: 'drt-abc', expire_time: 1 }
    const sealed = api.credential_storage_encrypt(JSON.stringify(userInfo), key)
    // The app's own file is the store this driver writes back to, so sealing
    // has to be reproducible: same input, same ciphertext.
    expect(api.credential_storage_encrypt(JSON.stringify(userInfo), key)).toBe(sealed)
    expect(JSON.parse(api.credential_storage_decrypt(sealed, key))).toEqual(userInfo)
  })

  it('rejects a key of the wrong length, which is why the derivation is ASCII', () => {
    // The key is 16 ASCII characters, not 16 bytes of binary. A binary key
    // survives a UTF-8 round trip as a longer string and is refused.
    expect(() => api.credential_storage_encrypt('{}', 'é'.repeat(16))).toThrow(/16 bytes/u)
  })

  it('derives the runtime auth fields from the account identity alone', () => {
    const generated = JSON.parse(api.generate_runtime_auth_fields(JSON.stringify({
      uid: 'u-1',
      organization_id: '',
      organization_tags: [],
      data_policy_agreed: true,
    }))) as { encrypt_user_info: string; key: string }
    expect(generated.encrypt_user_info.length).toBeGreaterThan(0)
    expect(generated.key.length).toBeGreaterThan(0)
    // Empty on disk and regenerated per launch — the reason a stored credential
    // is not by itself enough to make an authenticated request.
    expect(generated.encrypt_user_info).not.toBe(generated.key)
  })

  it('refuses a null organization_tags when the signing context is built', () => {
    const machineId = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'
    const seed = { uid: 'u-1', organization_id: '', data_policy_agreed: true }
    const generated = JSON.parse(api.generate_runtime_auth_fields(JSON.stringify({
      ...seed, organization_tags: [],
    }))) as { encrypt_user_info: string; key: string }
    const userInfo = JSON.stringify({
      ...seed,
      encrypt_user_info: generated.encrypt_user_info,
      key: generated.key,
      organization_tags: null,
    })
    // The field-derivation call tolerates `null`; the context constructor does
    // not. So the coercion has to happen in the credential mapper, before the
    // value ever reaches here — the pitfall that produces a bare
    // `403 Signature invalid` when it is missed.
    expect(() => api.createContext(machineId, '1.1.26', userInfo, '{}')).toThrow(/sequence|invalid user info/iu)
    const accepted = JSON.stringify({ ...seed, encrypt_user_info: generated.encrypt_user_info, key: generated.key, organization_tags: [] })
    const context = api.createContext(machineId, '1.1.26', accepted, '{}')
    expect(context).toBeDefined()
    context.free()
  })

  it('treats a server payload that is not sealed as plain text', () => {
    // Inference SSE frames are plain JSON while region/endpoints and
    // model/list are sealed; without this fallback every stream reads empty.
    const plain = '{"choices":[{"delta":{"content":"hi"}}]}'
    expect(openServerPayload(api, plain)).toBe(plain)
  })

  it('caches the instance, so repeated loads do not re-instantiate', () => {
    expect(loadQoderWasm()).toBe(api)
    resetQoderWasmCache()
    const reloaded = loadQoderWasm()
    expect(reloaded).not.toBe(api)
    // Still functional after a rebuild.
    expect(JSON.parse(reloaded.credential_storage_decrypt(
      reloaded.credential_storage_encrypt('{"a":1}', 'aaaaaaaaaaaaaaaa'),
      'aaaaaaaaaaaaaaaa',
    ))).toEqual({ a: 1 })
  })
})
