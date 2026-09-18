import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyQoderError,
  mapQoderModel,
  modelKeyOf,
  prepareQoderChatBody,
  QoderUpstreamClient,
  translateQoderStream,
} from '../../src/drivers/qoder/upstream.ts'
import { credentialFromUserInfo } from '../../src/drivers/qoder/credential.ts'
import { QODER_GATEWAY_BASE } from '../../src/drivers/qoder/meta.ts'
import { loadQoderWasm } from '../../src/drivers/qoder/wasm.ts'
import {
  drain,
  envelopeFrame,
  fakeWasmApi,
  FIXTURE_MACHINE_ID,
  fixtureUserInfo,
  recordingLogger,
  streamOf,
} from './fixtures.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('prepareQoderChatBody', () => {
  it('forces streaming and stamps a fresh request identity per call', () => {
    const source = JSON.stringify({
      model: 'dmodel',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const first = JSON.parse(prepareQoderChatBody(source))
    const second = JSON.parse(prepareQoderChatBody(source))
    // The endpoint answers only in SSE; a non-stream request is normalized.
    expect(first.stream).toBe(true)
    expect(typeof first.request_id).toBe('string')
    expect(typeof first.task_id).toBe('string')
    expect(typeof first.session_id).toBe('string')
    // A reused request identity is what the server's dedup window rejects.
    expect(first.request_id).not.toBe(second.request_id)
    expect(first.task_id).not.toBe(second.task_id)
    expect(first.model).toBe('dmodel')
  })

  it('keeps a caller-supplied session id, because grouping is a real semantic', () => {
    const out = JSON.parse(prepareQoderChatBody(JSON.stringify({ session_id: 'sess-keep', messages: [] })))
    expect(out.session_id).toBe('sess-keep')
  })

  it('rewrites the developer role to system', () => {
    const out = JSON.parse(prepareQoderChatBody(JSON.stringify({
      messages: [
        { role: 'developer', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    })))
    expect(out.messages[0].role).toBe('system')
    expect(out.messages[1].role).toBe('user')
  })

  it('passes unknown fields and tool surface through untouched', () => {
    const body = {
      model: 'auto',
      messages: [],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      tool_choice: 'auto',
      max_completion_tokens: 512,
      temperature: 0.2,
      something_qoder_may_not_know: { nested: true },
    }
    const out = JSON.parse(prepareQoderChatBody(JSON.stringify(body)))
    expect(out.tools).toEqual(body.tools)
    expect(out.tool_choice).toBe('auto')
    expect(out.max_completion_tokens).toBe(512)
    expect(out.temperature).toBe(0.2)
    expect(out.something_qoder_may_not_know).toEqual({ nested: true })
  })

  it('returns anything unparsable or non-object verbatim', () => {
    expect(prepareQoderChatBody('not json')).toBe('not json')
    expect(prepareQoderChatBody('[1,2]')).toBe('[1,2]')
    expect(prepareQoderChatBody('"a string"')).toBe('"a string"')
  })
})

describe('modelKeyOf', () => {
  it('reads the selected model and falls back to auto', () => {
    expect(modelKeyOf('{"model":"mmodel"}')).toBe('mmodel')
    expect(modelKeyOf('{"model":""}')).toBe('auto')
    expect(modelKeyOf('{"messages":[]}')).toBe('auto')
    expect(modelKeyOf('not json')).toBe('auto')
  })
})

describe('classifyQoderError', () => {
  it('maps the unambiguous statuses', () => {
    expect(classifyQoderError(402, '')).toBe('hard_credit')
    expect(classifyQoderError(429, '')).toBe('soft_rate')
    expect(classifyQoderError(404, '')).toBe('not_found')
    expect(classifyQoderError(500, '')).toBe('server')
    expect(classifyQoderError(400, 'bad request')).toBe('client')
  })

  it('separates the two 403 meanings, which is the whole point of this function', () => {
    // A stale credential or missing auth fields — the remedy is to sign in.
    expect(classifyQoderError(403, '{"code":"101","message":"Signature invalid"}')).toBe('session_dead')
    // A reused signature — a bridge-side bug, and reporting it as "sign in
    // again" would send the user chasing a credential that is fine.
    expect(classifyQoderError(403, '{"code":"102","message":"Duplicate request"}')).toBe('client')
  })

  it('recognises quota exhaustion in either language', () => {
    expect(classifyQoderError(200, 'insufficient credit')).toBe('hard_credit')
    expect(classifyQoderError(400, '免费额度已用完')).toBe('hard_credit')
    expect(classifyQoderError(400, '积分不足，请充值')).toBe('hard_credit')
  })

  it('recognises a dead session in either language', () => {
    expect(classifyQoderError(200, 'token expired')).toBe('session_dead')
    expect(classifyQoderError(400, '请重新登录')).toBe('session_dead')
  })
})

describe('mapQoderModel', () => {
  it('reads the context window from the default tier, not the first one', () => {
    const mapped = mapQoderModel({
      key: 'qmodel_38max',
      display_name: 'Qwen3.8-Max',
      source: 'system',
      is_vl: true,
      context_config: {
        small: { token_count: 100_000, is_default: false },
        large: { token_count: 200_000, is_default: true },
        max: { token_count: 1_000_000 },
      },
    })
    // The largest tier is the model's true ceiling; the backend auto-selects
    // the smallest tier that fits, so report the maximum, not `is_default`.
    expect(mapped?.contextWindow).toBe(1_000_000)
    expect(mapped?.supportsImages).toBe(true)
    expect(mapped?.maxTokens).toBe(32_000)
  })

  it('falls back through the declared limits to the driver default', () => {
    expect(mapQoderModel({ key: 'a', max_input_tokens: 32_768 })?.contextWindow).toBe(32_768)
    expect(mapQoderModel({ key: 'a' })?.contextWindow).toBe(128_000)
  })

  it('orders the declared effort ladder and picks up the default', () => {
    const mapped = mapQoderModel({
      key: 'gmodel',
      is_reasoning: true,
      thinking_config: {
        enabled: { efforts: { max: { is_default: true }, low: {}, high: {}, bogus: {} } },
        disabled: {},
      },
    })
    // Declared order is normalized to the driver's ascending vocabulary, and an
    // effort spelling the driver does not know is dropped rather than sent.
    expect(mapped?.reasoning?.supportedEfforts).toEqual(['low', 'high', 'max'])
    expect(mapped?.reasoning?.defaultEffort).toBe('max')
    expect(mapped?.reasoning?.canDisableThinking).toBe(true)
  })

  it('reports a reasoning model with no ladder as such, rather than inventing one', () => {
    const mapped = mapQoderModel({ key: 'qmodel_latest', is_reasoning: true })
    expect(mapped?.reasoning).toEqual({ supports: true, canDisableThinking: false })
    expect(mapped?.reasoning?.supportedEfforts).toBeUndefined()
  })

  it('reports a non-reasoning model as non-reasoning', () => {
    const mapped = mapQoderModel({ key: 'kmodel', is_reasoning: false })
    expect(mapped?.reasoning).toBeUndefined()
  })

  it('carries the offer facts, preferring the catalog own badge spelling', () => {
    const mapped = mapQoderModel({
      key: 'qfmodel',
      price_factor: 0.1,
      is_free: false,
      promotion: { badge: { zh: '错峰 4 折', en: 'off-peak 60% off' } },
    })
    expect(mapped?.billing).toEqual({ credits: 'x0.1', badges: ['错峰 4 折'], free: false })
    expect(mapQoderModel({ key: 'x', promotion: { badge: { en: 'free' } } })?.billing?.badges).toEqual(['free'])
  })

  it('omits billing entirely when the row declares no offer', () => {
    expect(mapQoderModel({ key: 'plain' })?.billing).toBeUndefined()
    expect(mapQoderModel({ key: 'free', is_free: true })?.billing).toEqual({ free: true })
  })

  it('falls back to the id for a nameless row and defaults the source', () => {
    const mapped = mapQoderModel({ key: 'kmodel', display_name: '' })
    expect(mapped?.name).toBe('kmodel')
    expect(mapped?.source).toBe('system')
    expect(mapQoderModel({ key: 'k', source: 'byok' })?.source).toBe('byok')
  })

  it('rejects anything that is not a keyed row', () => {
    expect(mapQoderModel(null)).toBeUndefined()
    expect(mapQoderModel([])).toBeUndefined()
    expect(mapQoderModel('qmodel')).toBeUndefined()
    expect(mapQoderModel({})).toBeUndefined()
    expect(mapQoderModel({ key: 42 })).toBeUndefined()
  })
})

describe('translateQoderStream', () => {
  const api = fakeWasmApi()

  it('unwraps the envelope into an ordinary OpenAI frame', async () => {
    const stream = translateQoderStream(api, streamOf(
      envelopeFrame('{"choices":[{"delta":{"content":"hi"}}]}'),
    ))
    expect(await drain(stream)).toBe(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('ends the stream on the [DONE] envelope and drops the trailing finish event', async () => {
    const stream = translateQoderStream(api, streamOf(
      envelopeFrame('{"choices":[{"delta":{"content":"hi"}}]}'),
      envelopeFrame('[DONE]'),
      'event:finish\ndata:{"total":1}\n\n',
    ))
    const text = await drain(stream)
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    // The finish event carries timings, not a chunk; forwarding it would end
    // the turn with a parse error on the client.
    expect(text).not.toContain('finish')
    expect(text).not.toContain('"total"')
  })

  it('drops a frame whose payload carries neither choices nor an error', async () => {
    const stream = translateQoderStream(api, streamOf('event:finish\ndata:{"total":1}\n\n'))
    expect(await drain(stream)).toBe('data: [DONE]\n\n')
  })

  it('surfaces an envelope-level failure as an error frame, then terminates', async () => {
    const stream = translateQoderStream(api, streamOf(
      envelopeFrame('{}', 500, 'INTERNAL_ERROR'),
    ))
    const text = await drain(stream)
    expect(text).toContain('"error"')
    expect(text).toContain('frame status 500')
    expect(text).toContain('INTERNAL_ERROR')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('surfaces the server wording carried inside an error envelope body', async () => {
    const stream = translateQoderStream(api, streamOf(
      envelopeFrame(
        JSON.stringify({ code: '400', message: '[FAIL]node:oa_qwen-plus-main msg:Execution failed: null' }),
        400,
        'BAD_REQUEST',
      ),
    ))
    const text = await drain(stream)
    expect(text).toContain('frame status 400 BAD_REQUEST')
    expect(text).toContain('[FAIL]node:oa_qwen-plus-main msg:Execution failed: null')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('converts a mid-stream error chunk, because the status is already committed', async () => {
    const stream = translateQoderStream(api, streamOf(
      envelopeFrame('{"code":"101","message":"Signature invalid"}'),
    ))
    const text = await drain(stream)
    expect(text).toContain('"error"')
    expect(text).toContain('101')
    expect(text).toContain('Signature invalid')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('forwards a bare chunk that is not wrapped in an envelope', async () => {
    const stream = translateQoderStream(api, streamOf(
      'data:{"choices":[{"delta":{"content":"plain"}}]}\n\n',
    ))
    expect(await drain(stream)).toBe(
      'data: {"choices":[{"delta":{"content":"plain"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('reassembles a frame split across reads', async () => {
    const frame = envelopeFrame('{"choices":[{"delta":{"content":"split"}}]}')
    const stream = translateQoderStream(api, streamOf(
      frame.slice(0, 12),
      frame.slice(12, 45),
      frame.slice(45),
    ))
    expect(await drain(stream)).toBe(
      'data: {"choices":[{"delta":{"content":"split"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('reads a final frame that arrives without its blank-line separator', async () => {
    const tail = `data:${JSON.stringify({
      body: '{"choices":[{"delta":{"content":"tail"}}]}',
      statusCodeValue: 200,
    })}`
    const stream = translateQoderStream(api, streamOf(tail))
    expect(await drain(stream)).toBe(
      'data: {"choices":[{"delta":{"content":"tail"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('tolerates CRLF separators', async () => {
    const stream = translateQoderStream(api, streamOf(
      `${envelopeFrame('{"choices":[{"delta":{"content":"crlf"}}]}').replace(/\n/gu, '\r\n')}`,
    ))
    expect(await drain(stream)).toBe(
      'data: {"choices":[{"delta":{"content":"crlf"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('opens a sealed payload before parsing it', async () => {
    // The decryptor is what turns the frame into JSON here, proving the
    // translator goes through openServerPayload rather than parsing raw text.
    const sealed = fakeWasmApi(() => '{"choices":[{"delta":{"content":"sealed"}}]}')
    const stream = translateQoderStream(sealed, streamOf('data:QUJDREVGRw==\n\n'))
    expect(await drain(stream)).toBe(
      'data: {"choices":[{"delta":{"content":"sealed"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('warns and drops an unparsable frame instead of failing the turn', async () => {
    const logger = recordingLogger()
    const stream = translateQoderStream(api, streamOf('data:{"broken\n\n'), logger)
    expect(await drain(stream)).toBe('data: [DONE]\n\n')
    expect(logger.warnings.length).toBe(1)
    expect(logger.warnings[0]?.[0]).toContain('unparsable SSE frame')
  })

  it('answers [DONE] alone when the upstream sent no body', async () => {
    expect(await drain(translateQoderStream(api, null))).toBe('data: [DONE]\n\n')
  })

  it('terminates the stream when the upstream dies mid-flight', async () => {
    const encoder = new TextEncoder()
    // One good frame, then the socket dies — the shape a real truncation has.
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(envelopeFrame('{"choices":[{"delta":{"content":"a"}}]}')))
      },
      pull(controller) {
        controller.error(new Error('socket reset'))
      },
    })
    const logger = recordingLogger()
    const text = await drain(translateQoderStream(api, failing, logger))
    expect(text).toContain('"content":"a"')
    // A truncated stream that never says [DONE] looks like an empty answer.
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    expect(logger.warnings.some(args => String(args[0]).includes('mid-flight'))).toBe(true)
  })
})

describe('QoderUpstreamClient', () => {
  const credential = credentialFromUserInfo(fixtureUserInfo(), FIXTURE_MACHINE_ID)

  it('signs with the embedded wasm and translates the reply', async () => {
    const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: String(init?.body ?? ''),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response(
        envelopeFrame('{"choices":[{"delta":{"content":"hi"}}]}') + envelopeFrame('[DONE]'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    })

    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const prepared = prepareQoderChatBody('{"model":"dmodel","messages":[{"role":"user","content":"hi"}]}')
    const result = await client.chatStream(credential, prepared)

    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toContain('/algo/api/v2/service/pro/sse/agent_chat_generation')
    // The wasm seals the body, so what leaves the process is not the caller's JSON.
    expect(calls[0]?.body).not.toBe(prepared)
    expect(calls[0]?.body.length).toBeGreaterThan(0)
    // The model rides a header; the body's `model` field selects nothing.
    const modelHeader = Object.entries(calls[0]?.headers ?? {})
      .find(([name]) => name.toLowerCase() === 'x-model-key')
    expect(modelHeader?.[1]).toBe('dmodel')

    if (!result.ok) throw new Error('expected a successful result')
    const body = result.response.body
    if (body === null) throw new Error('expected a translated response body')
    expect(await drain(body)).toBe(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: [DONE]\n\n',
    )
  })

  it('classifies a failed inference response', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '{"code":"101","message":"Signature invalid"}',
      { status: 403 },
    ))
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const result = await client.chatStream(credential, '{"model":"auto","messages":[]}')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(403)
    expect(result.kind).toBe('session_dead')
    expect(result.message).toContain('Signature invalid')
  })

  it('reports a signing failure instead of throwing at the caller', async () => {
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const broken = {
      ...credential,
      organizationTags: null as unknown as readonly string[],
    }
    const result = await client.chatStream(broken, '{"model":"auto","messages":[]}')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('server')
    expect(result.message).toContain('qoder signing failed')
  })

  it('reports a transport failure as a retryable server error', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ENOTFOUND gateway.qoder.com.cn') })
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const result = await client.chatStream(credential, '{"model":"auto","messages":[]}')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('transport error')
  })

  it('discovers the region nodes once and signs against them', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      urls.push(String(url))
      if (urls.length === 1) {
        return new Response(JSON.stringify({
          centerNodes: ['https://center.example'],
          inferNodes: ['https://infer.example'],
          openapiNodes: ['https://openapi.example'],
        }), { status: 200 })
      }
      return new Response(envelopeFrame('{"choices":[{"delta":{"content":"ok"}}]}'), { status: 200 })
    })

    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const endpoints = await client.discoverEndpoints(credential)
    expect(endpoints?.inferNodes).toEqual(['https://infer.example'])
    expect(urls[0]).toBe(`${QODER_GATEWAY_BASE}/algo/api/v4/service/region/endpoints`)

    // A second call inside the TTL is answered from the cache, not the network.
    expect(await client.discoverEndpoints(credential)).toBeUndefined()
    expect(urls.length).toBe(1)

    await client.chatStream(credential, '{"model":"auto","messages":[]}')
    expect(urls[1]?.startsWith('https://infer.example')).toBe(true)
  })

  it('falls back to the default gateway when discovery fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const logger = recordingLogger()
    const client = new QoderUpstreamClient({ api: loadQoderWasm(), logger })
    expect(await client.discoverEndpoints(credential)).toBeUndefined()
    expect(logger.warnings.some(args => String(args[0]).includes('node discovery failed'))).toBe(true)
  })

  it('keeps only the models a chat shim can actually serve', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      assistant: [
        { key: 'keep', source: 'system', format: 'openai', display_name: 'Keep me' },
        { key: 'byok', source: 'byok', format: 'openai' },
        { key: 'other-format', source: 'system', format: 'anthropic' },
        // `format` is optional; a missing one is not a reason to drop a row.
        { key: 'no-format', source: 'system' },
        // `enable:false` is an account-entitlement flag, not a UI hint: a model
        // the account cannot drive is dropped so the host never offers it, and
        // a request for it would silently downgrade to the gateway default.
        { key: 'disabled-flag', source: 'system', format: 'openai', enable: false },
      ],
    }), { status: 200 }))

    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const models = await client.fetchModels(credential)
    expect(models.map(model => model.id)).toEqual(['keep', 'no-format'])
  })

  it('refuses a catalog that resolves to nothing', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ assistant: [] }), { status: 200 }))
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    await expect(client.fetchModels(credential)).rejects.toThrow(/empty list/u)
  })

  it('reports a rejected catalog request', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"101"}', { status: 401 }))
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    await expect(client.fetchModels(credential)).rejects.toThrow(/model catalog request failed/u)
  })

  it('refreshes the device token against the openapi host', async () => {
    const calls: { url: string; body: string }[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return new Response(JSON.stringify({
        device_token: 'dt-rotated',
        refresh_token: 'drt-rotated',
        expires_at: Date.now() + 3_600_000,
        refresh_token_expires_at: Date.now() + 86_400_000,
      }), { status: 200 })
    })
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    const outcome = await client.refreshToken(credential)
    expect(calls[0]?.url).toContain('/api/v1/deviceToken/refresh')
    expect(calls[0]?.body).toContain(credential.refreshToken)
    expect(outcome.deviceToken).toBe('dt-rotated')
    expect(outcome.refreshToken).toBe('drt-rotated')
    expect(outcome.refreshExpiresAtMs).toBeGreaterThan(Date.now())
  })

  it('reports a rejected refresh', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"101"}', { status: 400 }))
    const client = new QoderUpstreamClient({ api: loadQoderWasm() })
    await expect(client.refreshToken(credential)).rejects.toThrow(/token refresh rejected/u)
  })
})
