import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyLoomyError,
  prepareLoomyChatBody,
  LoomyUpstreamClient,
} from '../../src/drivers/loomy/upstream.ts'
import type { LoomySession } from '../../src/drivers/loomy/auth.ts'

const session: LoomySession = { session: '0123456789abcdef0123456789abcdef' }

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Build a mocked Response and capture the outgoing request. */
function stubFetch(response: Response, capture: (init: RequestInit & { headers: Record<string, string> }, url: string) => void): void {
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    capture({ ...init, headers: (init?.headers ?? {}) as Record<string, string> }, String(url))
    return response
  })
}

describe('prepareLoomyChatBody', () => {
  it('passes the body through unchanged apart from tool_choice', () => {
    const body = JSON.parse(prepareLoomyChatBody(JSON.stringify({
      model: 'spark-x',
      messages: [{ role: 'developer', content: 'be brief' }, { role: 'user', content: 'hi' }],
      stream: false,
      tool_choice: { type: 'auto' },
    })))
    // developer role is natively accepted by imodel and must not be rewritten.
    expect(body.messages[0]).toMatchObject({ role: 'developer' })
    // Non-stream is accepted natively; the driver must not force stream:true.
    expect(body.stream).toBe(false)
    expect(body.tool_choice).toBe('auto')
  })

  it('flattens every object tool_choice spelling', () => {
    const cases: Array<[unknown, unknown]> = [
      [{ type: 'auto' }, 'auto'],
      [{ type: 'required' }, 'required'],
      [{ type: 'none' }, 'none'],
      [{ type: 'function', function: { name: 'get_weather' } }, 'get_weather'],
    ]
    for (const [input, expected] of cases) {
      const out = JSON.parse(prepareLoomyChatBody(JSON.stringify({ tool_choice: input })))
      expect(out.tool_choice).toBe(expected)
    }
  })

  it('leaves string tool_choice and tool-less bodies untouched', () => {
    expect(JSON.parse(prepareLoomyChatBody('{"tool_choice":"required"}'))['tool_choice']).toBe('required')
    expect(JSON.parse(prepareLoomyChatBody('{"model":"x"}'))['tool_choice']).toBeUndefined()
  })

  it('returns the source verbatim for non-JSON', () => {
    expect(prepareLoomyChatBody('not json')).toBe('not json')
  })
})

describe('classifyLoomyError', () => {
  it('maps statuses to the core error taxonomy', () => {
    expect(classifyLoomyError(401, '')).toBe('session_dead')
    expect(classifyLoomyError(402, '')).toBe('hard_credit')
    expect(classifyLoomyError(429, '')).toBe('soft_rate')
    expect(classifyLoomyError(404, '')).toBe('not_found')
    expect(classifyLoomyError(500, '')).toBe('server')
    expect(classifyLoomyError(400, 'bad request')).toBe('client')
  })

  it('treats quota-marker bodies as hard_credit', () => {
    expect(classifyLoomyError(400, 'out of points')).toBe('hard_credit')
    expect(classifyLoomyError(400, '点数不足')).toBe('hard_credit')
  })
})

describe('LoomyUpstreamClient.chatStream', () => {
  it('sends dual session auth and a W3C traceparent', async () => {
    let captured: { headers: Record<string, string>; url: string; body?: string } | undefined
    stubFetch(
      new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      (init, url) => { captured = { headers: init.headers, url, body: init.body as string } },
    )
    const client = new LoomyUpstreamClient()
    const result = await client.chatStream(session, JSON.stringify({ model: 'x' }))
    expect(result.ok).toBe(true)
    expect(captured!.url).toBe('https://loomyad.xunfei.cn/api/v1/chat/completions')
    expect(captured!.headers['Authorization']).toBe(`Bearer ${session.session}`)
    expect(captured!.headers['token']).toBe(session.session)
    // W3C traceparent: 00-32hex-16hex-01, unique per request.
    expect(captured!.headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(captured!.headers['ChatId']).toBeTruthy()
  })

  it('classifies a 401 as a dead session failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }))
    const result = await new LoomyUpstreamClient().chatStream(session, '{}')
    expect(result).toMatchObject({ ok: false, status: 401, kind: 'session_dead' })
  })
})

describe('LoomyUpstreamClient.fetchModels', () => {
  const catalogBody = {
    object: 'list',
    data: [
      {
        id: 'spark-x', name: 'Spark X', type: 'chat', context_length: 1000, max_output_tokens: 50,
        reasoning_efforts: ['none', 'low', 'high'], default_reasoning_effort: 'low',
        capabilities: { reasoning: true, vision: false, input_modalities: ['text'] },
      },
      {
        id: 'vision-one', name: 'Vision One', type: 'chat', context_length: 200, max_output_tokens: 80,
        capabilities: { reasoning: false, vision: true, input_modalities: ['text', 'image', 'video'] },
      },
      {
        id: 'image-gen', name: 'Image Gen', type: 'image', context_length: 100, max_output_tokens: 100,
        capabilities: { vision: true, input_modalities: ['text', 'image'] },
      },
      { id: 'zero-ctx', name: 'Zero', type: 'chat', context_length: 0, max_output_tokens: 0 },
    ],
  }

  it('keeps chat models, drops image-generation rows, and maps capabilities', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(catalogBody), { status: 200 }))
    const models = await new LoomyUpstreamClient().fetchModels(session)
    const ids = models.map(model => model.id)
    expect(ids).toEqual(['spark-x', 'vision-one'])

    const spark = models.find(model => model.id === 'spark-x')!
    expect(spark.reasoning?.supportedEfforts).toEqual(['none', 'low', 'high'])
    expect(spark.reasoning?.defaultEffort).toBe('low')
    expect(spark.supportsImages).toBe(false)

    const vision = models.find(model => model.id === 'vision-one')!
    expect(vision.supportsImages).toBe(true)
    // Audio/video entries exist upstream but are never advertised to DSH chat.
    expect(vision.reasoning).toBeUndefined()
  })

  it('throws on an empty catalog and on non-200', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    await expect(new LoomyUpstreamClient().fetchModels(session)).rejects.toThrow(/empty list/)
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }))
    await expect(new LoomyUpstreamClient().fetchModels(session)).rejects.toThrow(/session_dead|401/)
  })
})
