/**
 * Shared fixtures for the Qoder driver specs.
 *
 * The credential fixtures are sealed with the *same embedded wasm* the driver
 * uses, so every spec exercises the real decryption path; nothing here fakes
 * the credential format. That matters because the format (a 16-character ASCII
 * key derived from the machine id, base64 text on disk) is the single fact that
 * took the longest to establish — a fixture that bypassed it would let the
 * driver regress silently.
 *
 * @module tests/qoder/fixtures
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qoderCredentialKey, type QoderRefreshOutcome } from '../../src/drivers/qoder/credential.ts'
import { loadQoderWasm, type QoderWasmApi } from '../../src/drivers/qoder/wasm.ts'

/** A machine id with the UUID shape the app writes. */
export const FIXTURE_MACHINE_ID = '0f8c1a52-3b47-4a9e-9d21-7c5e0b6f4a10'

/** A second machine id, used to prove a key belongs to one machine only. */
export const FIXTURE_OTHER_MACHINE_ID = 'a1b2c3d4-1111-2222-3333-444455556666'

/**
 * A credential document shaped like the app's own file.
 *
 * The expiry is six hours out so the core refresher treats it as fresh and the
 * specs never touch the network. `encrypt_user_info` and `key` are empty here
 * on purpose: that is what the app stores, and their absence is exactly what
 * makes the per-request derivation necessary.
 */
export function fixtureUserInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now()
  return {
    access_token: 'dt-fixture-access',
    security_oauth_token: 'dt-fixture-access',
    refresh_token: 'drt-fixture-refresh',
    expire_time: now + 6 * 60 * 60 * 1000,
    refresh_token_expire_time: now + 30 * 24 * 60 * 60 * 1000,
    uid: 'uid-fixture',
    name: 'Fixture User',
    user_tag: 'Pro',
    user_type: 'personal_pro',
    organization_id: 'org-fixture',
    organization_tags: [],
    data_policy_agreed: true,
    encrypt_user_info: '',
    key: '',
    ...overrides,
  }
}

/** One fixture auth directory and the sealed text it holds. */
export interface FixtureAuthDir {
  directory: string
  machineId: string
  /** The sealed credential text exactly as it sits on disk. */
  sealed: string
  userInfo: Record<string, unknown>
}

/**
 * Seal a credential into a fresh temp directory the store can probe.
 *
 * The machine id is written with a trailing newline, matching the app, so the
 * fixtures also cover the `trim()` in {@link qoderCredentialKey}.
 */
export async function writeFixtureAuthDir(
  userInfo: Record<string, unknown> = fixtureUserInfo(),
  machineId: string = FIXTURE_MACHINE_ID,
  api: QoderWasmApi = loadQoderWasm(),
): Promise<FixtureAuthDir> {
  const directory = await mkdtemp(join(tmpdir(), 'qoder-auth-'))
  const sealed = api.credential_storage_encrypt(
    JSON.stringify(userInfo),
    qoderCredentialKey(machineId),
  )
  await writeFile(join(directory, 'id'), `${machineId}\n`)
  await writeFile(join(directory, 'user'), sealed)
  return { directory, machineId, sealed, userInfo }
}

/**
 * A wasm surface that never seals anything.
 *
 * `decrypt_server_response` throws by default, which is the real situation for
 * inference SSE frames — Qoder seals `region/endpoints` and `model/list` but
 * sends chat chunks as plain JSON, and the driver's try-then-fall-back has to
 * handle both.
 */
export function fakeWasmApi(open: (payload: string) => string = () => {
  throw new Error('payload is not sealed')
}): QoderWasmApi {
  return {
    credential_storage_decrypt: blob => blob,
    credential_storage_encrypt: plaintext => plaintext,
    decrypt_server_response: open,
    generate_runtime_auth_fields: () => '{"encrypt_user_info":"","key":""}',
    createContext: () => {
      throw new Error('createContext is not part of this fixture')
    },
    exports: {},
  }
}

/**
 * A refresh answer in the endpoint's own vocabulary.
 *
 * `QoderCredentialStore`'s `refresh` seam is deliberately typed as the
 * *endpoint's* answer rather than a credential: the store owns the merge into
 * the app's document, so a stub that returned a credential would bypass the
 * code under test.
 */
export function refreshOutcome(
  deviceToken = 'dt-rotated',
  refreshToken = 'drt-rotated',
): QoderRefreshOutcome {
  return {
    deviceToken,
    refreshToken,
    expiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
  }
}

/**
 * A refresh seam that must never be reached.
 *
 * Used wherever the fixture credential is fresh or no account exists at all:
 * a spec that reaches this has a bug, and an unhandled rejection would be
 * swallowed by the core refresher's keep-serving policy.
 */
export async function mustNotRefresh(): Promise<QoderRefreshOutcome> {
  throw new Error('this fixture must never need a token refresh')
}

/** One OpenAI chunk as Qoder wraps it: the chunk is the JSON *string* in `body`. */
export function envelopeFrame(body: string, statusCodeValue = 200, statusCode = 'OK'): string {
  return `data:${JSON.stringify({ headers: {}, body, statusCodeValue, statusCode })}\n\n`
}

/** A stream over the given text pieces, so fragmentation can be exercised. */
export function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Drain a byte stream into one string. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

/** A logger that records everything, for the drop-and-warn paths. */
export function recordingLogger(): { warnings: string[][]; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } {
  const warnings: string[][] = []
  return {
    warnings,
    warn: (...args: unknown[]) => void warnings.push(args.map(String)),
    error: (...args: unknown[]) => void warnings.push(args.map(String)),
  }
}
