import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LoomySessionStore } from '../../src/drivers/loomy/auth.ts'
import { LoomyCatalog } from '../../src/drivers/loomy/catalog.ts'
import { createLoomyShim, type LoomyShim } from '../../src/drivers/loomy/shim.ts'
import type { LoomyChatResult } from '../../src/drivers/loomy/upstream.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

async function startShim(upstreamResponse: () => LoomyChatResult, onBody?: (body: string) => void): Promise<LoomyShim> {
  const dir = await mkdtemp(join(tmpdir(), 'loomy-shim-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const sessionFile = join(dir, 'auth-session.json')
  await writeFile(sessionFile, JSON.stringify({ session: 'sess-1', phone: '13800000000' }))
  const store = new LoomySessionStore({ sessionFile })
  const shim = createLoomyShim({
    store,
    catalog: new LoomyCatalog(),
    client: {
      async chatStream(_session, bodyJson): Promise<LoomyChatResult> {
        onBody?.(bodyJson)
        return upstreamResponse()
      },
    },
  })
  await shim.ready
  CLEANUP.push(() => shim.close())
  return shim
}

describe('Loomy shim', () => {
  it('lists the ten fallback chat models on /v1/models', async () => {
    const shim = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'x' }))
    const response = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string; owned_by: string }[] }
    const ids = body.data.map(model => model.id)
    expect(ids.length).toBe(10)
    expect(ids).toContain('spark-x')
    expect(ids).toContain('qwen3.5-flash')
    // Image-generation rows are never exposed through the chat shim.
    expect(ids).not.toContain('doubao-seedream-5-lite')
    expect(body.data.every(model => model.owned_by === 'loomy')).toBe(true)
  })

  it('flattens object tool_choice before forwarding and streams the reply', async () => {
    const bodies: string[] = []
    const shim = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }), body => bodies.push(body))
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'spark-x',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    const forwarded = JSON.parse(bodies[0]!)
    expect(forwarded.tool_choice).toBe('get_weather')
    // The Loomy endpoint accepts non-stream natively; the driver does not force it.
    expect(forwarded.stream).toBe(false)
  })

  it('maps a session failure onto HTTP 401', async () => {
    const shim = await startShim(() => ({
      ok: false, status: 401, kind: 'session_dead', message: 'unauthorized',
    }))
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'spark-x', messages: [] }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('session_dead')
  })

  it('answers 401 when the desktop session is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loomy-shim-nosess-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new LoomySessionStore({ sessionFile: join(dir, 'missing.json') })
    const shim = createLoomyShim({
      store,
      catalog: new LoomyCatalog(),
      client: { async chatStream() { throw new Error('must not reach upstream') } },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'spark-x', messages: [] }),
    })
    expect(response.status).toBe(401)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('Loomy')
  })
})
