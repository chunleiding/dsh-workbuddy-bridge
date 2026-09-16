import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { QoderCredentialStore } from '../../src/drivers/qoder/auth.ts'
import { FALLBACK_QODER_MODELS, QoderCatalog } from '../../src/drivers/qoder/catalog.ts'
import { createQoderShim, type QoderShim } from '../../src/drivers/qoder/shim.ts'
import type { QoderChatResult } from '../../src/drivers/qoder/upstream.ts'
import { mustNotRefresh, writeFixtureAuthDir } from './fixtures.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** A store backed by a real sealed credential, with a refresh that must never fire. */
async function fixtureStore(): Promise<QoderCredentialStore> {
  const auth = await writeFixtureAuthDir()
  CLEANUP.push(() => rm(auth.directory, { recursive: true, force: true }))
  return new QoderCredentialStore({
    authDir: auth.directory,
    refresh: mustNotRefresh,
  })
}

async function startShim(
  upstreamResponse: () => QoderChatResult,
  onBody?: (body: string) => void,
): Promise<QoderShim> {
  const shim = createQoderShim({
    store: await fixtureStore(),
    catalog: new QoderCatalog(),
    client: {
      async chatStream(_credential, bodyJson): Promise<QoderChatResult> {
        onBody?.(bodyJson)
        return upstreamResponse()
      },
    },
  })
  await shim.ready
  CLEANUP.push(() => shim.close())
  return shim
}

function post(shim: QoderShim, body: unknown, token: string = shim.token()): Promise<Response> {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

describe('Qoder shim', () => {
  it('lists the fallback roster on /v1/models', async () => {
    const shim = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'x' }))
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string; owned_by: string }[] }
    expect(body.data.map(model => model.id)).toEqual(FALLBACK_QODER_MODELS.map(model => model.id))
    expect(body.data.length).toBe(14)
    expect(body.data.every(model => model.owned_by === 'qoder')).toBe(true)
  })

  it('normalizes the outbound body and pipes the translated reply verbatim', async () => {
    const bodies: string[] = []
    const upstream = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const shim = await startShim(() => ({
      ok: true,
      response: new Response(upstream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }), body => bodies.push(body))

    const response = await post(shim, {
      model: 'dmodel',
      stream: false,
      messages: [{ role: 'developer', content: 'be brief' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
    })

    expect(response.status).toBe(200)
    // The core pipes a driver's stream body untouched, so what the client sees
    // is exactly what the translator produced.
    expect(await response.text()).toBe(upstream)

    const forwarded = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(forwarded['stream']).toBe(true)
    expect(forwarded['model']).toBe('dmodel')
    expect(typeof forwarded['request_id']).toBe('string')
    expect((forwarded['messages'] as { role: string }[])[0]?.role).toBe('system')
    expect(forwarded['tools']).toEqual([{ type: 'function', function: { name: 'f' } }])
  })

  it('maps a dead session onto HTTP 401', async () => {
    const shim = await startShim(() => ({
      ok: false, status: 403, kind: 'session_dead', message: 'Signature invalid',
    }))
    const response = await post(shim, { model: 'auto', messages: [] })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe('session_dead')
    // The label comes from the shim's driver-owned upstream name, which is how
    // a log reader tells a Qoder failure from a WorkBuddy one.
    expect(body.error.message).toContain('qoder upstream')
  })

  it('maps quota exhaustion onto HTTP 402', async () => {
    const shim = await startShim(() => ({
      ok: false, status: 200, kind: 'hard_credit', message: '积分不足',
    }))
    const response = await post(shim, { model: 'auto', messages: [] })
    expect(response.status).toBe(402)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('hard_credit')
  })

  it('answers 401 when no signed-in account exists', async () => {
    const shim = createQoderShim({
      store: new QoderCredentialStore({
        // A directory with no credential in it.
        authDir: '/nonexistent/qoder-auth-dir',
        refresh: mustNotRefresh,
      }),
      catalog: new QoderCatalog(),
      client: {
        async chatStream() { throw new Error('must not reach upstream') },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())

    const response = await post(shim, { model: 'auto', messages: [] })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('Qoder')
  })

  it('refuses a request that does not carry the shared secret', async () => {
    const shim = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'x' }))
    const response = await post(shim, { model: 'auto', messages: [] }, 'not-the-secret')
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('unauthorized')
  })
})
