/**
 * Qoder upstream client: node discovery, signed inference, stream translation,
 * token refresh, and the model catalog.
 *
 * Everything in this file is Qoder-private: the two hosts, the COSY header
 * dialect, the sealed request body, the SSE envelope, the model row shape, and
 * the Chinese/English error markers.
 *
 * The shape of the traffic, all verified against the live endpoint:
 *
 * - **Request**: the wasm's `prepareInferRequest` returns an absolute URL (it
 *   appends `Encode=1` itself), the full COSY header set, and a *sealed* body.
 *   The model rides the `X-Model-Key` header; a `model` field in the body is
 *   echoed back decoratively and selects nothing.
 * - **Response**: `text/event-stream`, but not ordinary SSE. Each event's data
 *   is an *envelope* — `{headers, body: "<json string>", statusCodeValue,
 *   statusCode}` — and the OpenAI chunk lives inside the `body` string. The
 *   stream ends with an envelope whose `body` is the literal `"[DONE]"`,
 *   followed by an `event: finish` event carrying timings.
 * - Frames are **plain JSON**, not sealed, while `region/endpoints` and
 *   `model/list` *are* sealed. Every read therefore goes through
 *   {@link openServerPayload}'s try-then-fall-back, exactly as the app does.
 *
 * The wire is OpenAI-shaped, so the core's one-way forwarding contract holds:
 * the only work this driver does is unwrapping the envelope back into ordinary
 * `data: <chunk>` frames, which is what the shim pipes.
 *
 * @module dsh-llm-bridge/drivers/qoder/upstream
 */

import { randomUUID } from 'node:crypto'
import type { BridgeChatResult, BridgeErrorKind } from '../../core/types.ts'
import type { ShimLogger } from '../../core/shim.ts'
import { safeMessage } from '../../core/status-route.ts'
import {
  parseQoderRefreshResponse,
  qoderCredentialKey,
  runtimeAuthFieldsInput,
  signingUserInfo,
  type QoderCredential,
  type QoderRefreshOutcome,
} from './credential.ts'
import {
  QODER_AGENT_ID,
  QODER_AUTO_MODEL,
  QODER_CLIENT_METADATA,
  QODER_COSY_VERSION,
  QODER_GATEWAY_BASE,
  QODER_OPENAPI_BASE,
  QODER_SCENE,
} from './meta.ts'
import {
  loadQoderWasm,
  openServerPayload,
  type QoderContextHandle,
  type QoderRequestResult,
  type QoderWasmApi,
} from './wasm.ts'

/** Chat answer: either a live (translated) SSE response or a classified failure. */
export type QoderChatResult = BridgeChatResult

/** The concrete thinking-effort spellings Qoder declares on the wire. */
export type QoderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Effort spellings the catalog can declare, in ascending order. */
const EFFORT_VALUES: readonly QoderEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Default output ceiling; the catalog does not declare one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

/** Fallback context window when a row declares neither a tier nor a limit. */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Reasoning metadata the upstream catalog declares for one model. */
export interface QoderModelReasoning {
  supports: boolean
  /** Selectable effort values, from `thinking_config.enabled.efforts`. */
  supportedEfforts?: readonly QoderEffort[]
  /** The effort the catalog marks as default. */
  defaultEffort?: QoderEffort
  /**
   * Whether the catalog declares a disabled state (`thinking_config.disabled`).
   *
   * Carried faithfully but **not** turned into a switch by the adapter: the
   * inference endpoint accepts any string for `reasoning_effort` (verified —
   * including values that mean nothing), so sending a guessed "off" spelling
   * would produce a control that appears to work and silently does not.
   */
  canDisableThinking: boolean
}

/** Offer facts the upstream catalog declares for one model. */
export interface QoderModelBilling {
  /** Price multiplier in display form, e.g. `x0.8`. */
  credits?: string
  /** Promotional badges in the catalog's own spelling, e.g. `错峰 4 折`. */
  badges?: readonly string[]
  /** Whether the catalog marks the model free. */
  free: boolean
}

/** One model as the catalog describes it. */
export interface QoderModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  reasoning?: QoderModelReasoning
  billing?: QoderModelBilling
  /** Catalog `source`; `system` is what this driver can serve. */
  source: string
  /**
   * Whether the live catalog marks the model enabled for this account.
   *
   * `enable` is an account-level entitlement flag, not a UI hint: a model with
   * `enable: false` is not usable on the calling account, and asking the
   * gateway for it silently falls back to its hard default model (observed as
   * "Qwen3.5") rather than erroring. The driver therefore drops `enable: false`
   * rows from the catalog it exposes, so the host never offers a model the
   * account cannot actually drive.
   */
  enabled: boolean
  /** Whether the live catalog marks this the account's default model. */
  isDefault: boolean
}

/** Nodes the region endpoint reports. */
export interface QoderEndpoints {
  centerNodes: readonly string[]
  inferNodes: readonly string[]
  openapiNodes: readonly string[]
}

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096
const DISCOVERY_TTL_MS = 10 * 60 * 1000

/** Inference path; the wasm appends `&Encode=1` itself. */
const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation'

/** Region/node discovery path (plain HTTP, no wasm signing involved). */
const ENDPOINTS_PATH = '/algo/api/v4/service/region/endpoints'

/** Model catalog path; `Encode=1` marks the response as sealed. */
const MODEL_LIST_PATH = '/api/v2/model/list?Encode=1'

/** Device-token refresh path on the openapi host. */
const REFRESH_PATH = '/api/v1/deviceToken/refresh'

/** Insufficient-quota markers, ASCII first and then the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'not enough credit',
  'free quota', 'credit not enough',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
  '额度已用完', '免费额度已用完', '超出额度',
]

/** Sign-in/credential rejection markers. */
const SESSION_DEAD_MARKERS: readonly string[] = [
  'signature invalid', 'unauthenticated', 'unauthorized', 'invalid token',
  'token expired', 'refresh token expired', 'not logged in',
  '未登录', '登录已过期', '请重新登录', '令牌已过期', '凭证已失效',
]

/**
 * Marker for a signature reused within the server's dedup window. This is a
 * bridge-side artifact (a context reused across calls), not a credential
 * problem, so it must not be reported as "sign in again".
 */
const DUPLICATE_MARKERS: readonly string[] = ['duplicate request']

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * `403` is overloaded here: the endpoint answers `Signature invalid` (the
 * credential or the auth fields are stale — re-signing in is the remedy) and
 * `Duplicate request` (the driver reused a signature) with the same status.
 * They are told apart by body before the status is considered.
 */
export function classifyQoderError(status: number, body: string): BridgeErrorKind {
  const lower = body.toLowerCase()
  const mentions = (markers: readonly string[]): boolean =>
    markers.some(marker => lower.includes(marker.toLowerCase()) || body.includes(marker))
  if (status === 402) return 'hard_credit'
  if (mentions(HARD_CREDIT_MARKERS)) return 'hard_credit'
  if (mentions(DUPLICATE_MARKERS)) return 'client'
  if (mentions(SESSION_DEAD_MARKERS)) return 'session_dead'
  if (status === 429) return 'soft_rate'
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/** Parse a catalog `context_config` into the default tier's token count. */
function contextWindowOf(row: Record<string, unknown>): number {
  // `context_config` carries the model's capacity tiers (e.g. `200K`,
  // `400K`, `1M`); the backend auto-selects the smallest tier that fits the
  // request, so the *largest* tier is the model's true ceiling. Reporting the
  // maximum lets the host size requests to the model's full reach instead of
  // understating it at the catalog's `is_default` tier.
  const config = row['context_config']
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const tiers = config as Record<string, unknown>
    let max = 0
    for (const tier of Object.values(tiers)) {
      if (typeof tier !== 'object' || tier === null) continue
      const wrapped = tier as Record<string, unknown>
      const count = wrapped['token_count']
      if (typeof count === 'number' && count > max) max = count
    }
    if (max > 0) return max
  }
  const declared = row['max_input_tokens']
  if (typeof declared === 'number' && declared > 0) return declared
  return DEFAULT_CONTEXT_WINDOW
}

/** Parse `thinking_config` into the declared effort ladder. */
function reasoningOf(row: Record<string, unknown>): QoderModelReasoning | undefined {
  if (row['is_reasoning'] !== true) return undefined
  const config = row['thinking_config']
  const reasoning: QoderModelReasoning = {
    supports: true,
    canDisableThinking: typeof config === 'object' && config !== null
      && 'disabled' in (config as Record<string, unknown>),
  }
  if (typeof config !== 'object' || config === null) return reasoning
  const enabled = (config as Record<string, unknown>)['enabled']
  if (typeof enabled !== 'object' || enabled === null) return reasoning
  const efforts = (enabled as Record<string, unknown>)['efforts']
  if (typeof efforts !== 'object' || efforts === null) return reasoning
  const declared: QoderEffort[] = []
  let defaultEffort: QoderEffort | undefined
  for (const [name, value] of Object.entries(efforts as Record<string, unknown>)) {
    if (!(EFFORT_VALUES as readonly string[]).includes(name)) continue
    declared.push(name as QoderEffort)
    if (typeof value === 'object' && value !== null && (value as Record<string, unknown>)['is_default'] === true) {
      defaultEffort = name as QoderEffort
    }
  }
  if (declared.length > 0) {
    const ordered = EFFORT_VALUES.filter(effort => declared.includes(effort))
    return {
      ...reasoning,
      supportedEfforts: ordered,
      ...defaultEffort === undefined ? {} : { defaultEffort },
    }
  }
  return reasoning
}

/** Parse `price_factor` / `is_free` / `promotion` into offer facts. */
function billingOf(row: Record<string, unknown>): QoderModelBilling | undefined {
  const factor = row['price_factor']
  const credits = typeof factor === 'number' && Number.isFinite(factor) ? `x${factor}` : undefined
  const badges: string[] = []
  const promotion = row['promotion']
  if (typeof promotion === 'object' && promotion !== null) {
    const badge = (promotion as Record<string, unknown>)['badge']
    if (typeof badge === 'object' && badge !== null) {
      const wrapped = badge as Record<string, unknown>
      // The card seam has no locale service, so one spelling has to be chosen;
      // the catalog's own Chinese label is used, matching the WorkBuddy driver.
      const label = wrapped['zh'] ?? wrapped['en']
      if (typeof label === 'string' && label !== '') badges.push(label)
    }
  }
  const free = row['is_free'] === true
  if (credits === undefined && badges.length === 0 && !free) return undefined
  return {
    ...credits === undefined ? {} : { credits },
    ...badges.length === 0 ? {} : { badges },
    free,
  }
}

/** Project one catalog row into a model record, or undefined when unusable. */
export function mapQoderModel(row: unknown): QoderModelInfo | undefined {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined
  const wrapped = row as Record<string, unknown>
  const id = typeof wrapped['key'] === 'string' ? wrapped['key'] : ''
  if (id === '') return undefined
  const source = typeof wrapped['source'] === 'string' ? wrapped['source'] : ''
  const displayName = typeof wrapped['display_name'] === 'string' && wrapped['display_name'] !== ''
    ? wrapped['display_name']
    : id
  const reasoning = reasoningOf(wrapped)
  const billing = billingOf(wrapped)
  return {
    id,
    name: displayName,
    contextWindow: contextWindowOf(wrapped),
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    supportsImages: wrapped['is_vl'] === true,
    ...reasoning === undefined ? {} : { reasoning },
    ...billing === undefined ? {} : { billing },
    source: source === '' ? 'system' : source,
    // `enable` is an account-entitlement flag. The live catalog always carries
    // it, but a row that omits it (older/partial payloads, fixtures) is treated
    // as enabled rather than silently dropped — only an explicit `false` is a
    // capability limit.
    enabled: wrapped['enable'] !== false,
    isDefault: wrapped['is_default'] === true,
  }
}

/**
 * Normalize an OpenAI chat body for Qoder.
 *
 * Verified against the live endpoint: the deserializer is permissive — unknown
 * fields, `tool_choice`, `tools`, `max_completion_tokens` and a `developer`
 * role are all accepted with HTTP 200 — so the body is passed through almost
 * untouched rather than reduced to a whitelist, which would silently drop
 * capabilities the platform does support.
 *
 * Three changes are made:
 *
 * 1. `stream` is forced true; the endpoint only answers in SSE.
 * 2. `request_id` and `task_id` are stamped fresh. The wasm already gives every
 *    signature its own nonce (which is what the server's duplicate detection
 *    keys on), but carrying a caller-supplied constant here reuses a request
 *    identity across calls and buys nothing. `session_id` is preserved when
 *    present, because grouping is a real semantic, and generated otherwise.
 * 3. `role: "developer"` is rewritten to `"system"`. The endpoint accepts
 *    `developer` without complaining, which is exactly why this matters: an
 *    unrecognized role could be dropped silently, and the dropped message would
 *    be the system prompt. `system` is the spelling that is certainly honored.
 */
export function prepareQoderChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const document = body as Record<string, unknown>
  document['stream'] = true
  document['request_id'] = randomUUID()
  document['task_id'] = randomUUID()
  if (typeof document['session_id'] !== 'string' || document['session_id'] === '') {
    document['session_id'] = randomUUID()
  }
  const messages = document['messages']
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
      const wrapped = message as Record<string, unknown>
      if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
    }
  }
  return JSON.stringify(document)
}

/** The catalog key a chat body selects. */
export function modelKeyOf(bodyJson: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyJson)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>)['model']
      if (typeof model === 'string' && model !== '') return model
    }
  } catch {
    // An unparsable body cannot name a model; fall through to auto.
  }
  return QODER_AUTO_MODEL
}

/** One `data:` payload extracted from an SSE event block. */
function dataPayloadsOf(event: string): string[] {
  const payloads: string[] = []
  for (const line of event.split('\n')) {
    // The endpoint writes `data:` with no space; a space is tolerated too.
    if (!line.startsWith('data:')) continue
    payloads.push(line.slice('data:'.length).replace(/^ /u, ''))
  }
  return payloads
}

/** Render one OpenAI SSE frame. */
function sseFrame(payload: string): string {
  return `data: ${payload}\n\n`
}

/**
 * Translate Qoder's enveloped SSE into ordinary OpenAI SSE.
 *
 * The core pipes a driver's response body verbatim, so the unwrapping has to
 * happen here: the DSH client parses `data: <chunk>` frames, and Qoder's
 * frames carry the chunk one level down inside an envelope's `body` string.
 *
 * Frames that are not chat chunks are dropped rather than forwarded — the
 * trailing `event: finish` carries timings, and forwarding a shapeless object
 * to the client would end the turn with a parse error.
 *
 * A server-side error arriving mid-stream is surfaced as an OpenAI-style
 * `{"error": …}` frame followed by `[DONE]`, because by then the HTTP status
 * is long since committed and silence would look like a successful empty
 * answer.
 */
export function translateQoderStream(
  api: QoderWasmApi,
  body: ReadableStream<Uint8Array> | null,
  logger?: ShimLogger,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let finished = false

  /** Translate one SSE event block into the bytes to forward, or undefined. */
  const renderEvent = (event: string): string | undefined => {
    const payloads = dataPayloadsOf(event)
    if (payloads.length === 0) return undefined
    const plain = openServerPayload(api, payloads.join('\n')).trim()
    if (plain === '') return undefined
    if (plain === '[DONE]' || plain === '"[DONE]"') {
      finished = true
      return sseFrame('[DONE]')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(plain)
    } catch (error: unknown) {
      logger?.warn('dsh-llm-bridge: qoder sent an unparsable SSE frame', safeMessage(error))
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const document = parsed as Record<string, unknown>

    // The envelope: the chunk is the JSON *string* in `body`.
    if (typeof document['body'] === 'string') {
      const status = document['statusCodeValue']
      if (typeof status === 'number' && status !== 200) {
        finished = true
        const message = document['statusCode']
        return sseFrame(JSON.stringify({
          error: { message: `qoder upstream: frame status ${status} ${String(message ?? '')}`.trim(), type: 'server' },
        })) + sseFrame('[DONE]')
      }
      const inner = document['body'].trim()
      if (inner === '[DONE]') {
        finished = true
        return sseFrame('[DONE]')
      }
      let chunk: unknown
      try {
        chunk = JSON.parse(inner)
      } catch {
        logger?.warn('dsh-llm-bridge: qoder envelope body was not JSON; dropping the frame')
        return undefined
      }
      if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) return undefined
      const wrapped = chunk as Record<string, unknown>
      if (!Array.isArray(wrapped['choices']) && wrapped['error'] === undefined && !('code' in wrapped)) return undefined
      return renderChunk(wrapped)
    }

    if (!Array.isArray(document['choices']) && document['error'] === undefined && !('code' in document)) {
      return undefined
    }
    return renderChunk(document)
  }

  /** Forward a chunk, converting a server error into an error frame. */
  const renderChunk = (chunk: Record<string, unknown>): string => {
    const code = chunk['code']
    const message = chunk['message']
    if (chunk['choices'] === undefined && (typeof code !== 'undefined' || typeof message === 'string')) {
      finished = true
      return sseFrame(JSON.stringify({
        error: { message: `qoder upstream: ${String(code ?? '')} ${String(message ?? '')}`.trim(), type: 'server' },
      })) + sseFrame('[DONE]')
    }
    return sseFrame(JSON.stringify(chunk))
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (body === null) {
        finished = true
        controller.enqueue(encoder.encode(sseFrame('[DONE]')))
        controller.close()
        return
      }
      const reader = body.getReader()
      try {
        while (!finished) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, '\n')
          for (;;) {
            const index = buffer.indexOf('\n\n')
            if (index < 0) break
            const event = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const rendered = renderEvent(event)
            if (rendered !== undefined) controller.enqueue(encoder.encode(rendered))
            if (finished) break
          }
        }
        if (!finished) {
          // A final event without a trailing blank line still has to be read.
          const rendered = renderEvent(buffer)
          if (rendered !== undefined) controller.enqueue(encoder.encode(rendered))
        }
      } catch (error: unknown) {
        logger?.warn('dsh-llm-bridge: qoder stream failed mid-flight', safeMessage(error))
      } finally {
        try {
          await reader.cancel()
        } catch {
          // The connection is already gone; nothing to release.
        }
      }
      if (!finished) controller.enqueue(encoder.encode(sseFrame('[DONE]')))
      controller.close()
    },
  })
}

/** What one signed inference request needs to be sent. */
interface SignedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** Constructor dependencies. */
export interface QoderUpstreamOptions {
  /** Injected wasm module; defaults to the embedded one. */
  api?: QoderWasmApi
  /** Injected logger for stream anomalies and discovery failures. */
  logger?: ShimLogger
  /** Override the inference host (diagnostics and tests). */
  gatewayBase?: string
}

/**
 * Upstream client. One instance serves the whole plugin; requests take the
 * credential explicitly so a rotation applies on the next call.
 */
export class QoderUpstreamClient {
  private readonly injectedApi: QoderWasmApi | undefined
  private readonly logger: ShimLogger | undefined
  private readonly gatewayOverride: string | undefined
  private endpointsCache: { at: number; inferBase: string } | undefined

  constructor(options: QoderUpstreamOptions = {}) {
    this.injectedApi = options.api
    this.logger = options.logger
    this.gatewayOverride = options.gatewayBase
  }

  private api(): QoderWasmApi {
    return this.injectedApi ?? loadQoderWasm()
  }

  /**
   * Build a signing context.
   *
   * A fresh context per request is mandatory, not tidiness: the wasm stamps
   * each one with its own request nonce, and reusing a context reuses the
   * nonce, which the server rejects with `Duplicate request`. The auth fields
   * are derived here because the stored credential leaves them empty.
   */
  private buildContext(credential: QoderCredential): QoderContextHandle {
    const api = this.api()
    const generated = JSON.parse(api.generate_runtime_auth_fields(runtimeAuthFieldsInput(credential))) as {
      encrypt_user_info: string
      key: string
    }
    const userInfo = signingUserInfo(credential, generated)
    const context = api.createContext(
      credential.machineId,
      QODER_COSY_VERSION,
      userInfo,
      JSON.stringify(QODER_CLIENT_METADATA),
    )
    context.refreshAuthFields(userInfo)
    return context
  }

  /** Build a signed inference request and copy it out of wasm memory. */
  private signInferRequest(credential: QoderCredential, bodyJson: string): SignedRequest {
    const context = this.buildContext(credential)
    let prepared: QoderRequestResult | undefined
    try {
      prepared = context.prepareInferRequest(this.inferBase(), bodyJson, modelKeyOf(bodyJson), 'system')
      return { url: prepared.url, headers: Object.fromEntries(prepared.headers), body: prepared.body }
    } finally {
      // Every wasm allocation is released as soon as its contents are plain JS.
      prepared?.free()
      context.free()
    }
  }

  /**
   * The inference host, from the cached discovery answer.
   *
   * Discovery is a plain HTTP call whose response is sealed; it is not needed
   * for signing, so {@link signInferRequest} cannot await it. The cache is
   * primed by {@link discoverEndpoints} (called at plugin start and before the
   * catalog fetch) and otherwise falls back to the constant the endpoint
   * currently answers with.
   */
  private inferBase(): string {
    return this.endpointsCache?.inferBase ?? this.gatewayOverride ?? QODER_GATEWAY_BASE
  }

  /**
   * Resolve the region's node list and cache the inference host.
   *
   * Verified to need no wasm signing at all: a bearer device token plus the
   * machine id headers is enough, and the answer comes back sealed.
   */
  async discoverEndpoints(credential: QoderCredential): Promise<QoderEndpoints | undefined> {
    const cached = this.endpointsCache
    if (cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return undefined
    const base = this.gatewayOverride ?? QODER_GATEWAY_BASE
    try {
      const response = await fetch(`${base}${ENDPOINTS_PATH}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Cosy-MachineId': credential.machineId,
          'Cosy-MachineToken': credential.machineId,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`http ${response.status}: ${safeMessage(text.slice(0, 200))}`)
      const opened = openServerPayload(this.api(), text)
      const parsed: unknown = JSON.parse(opened)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('unexpected document')
      const document = parsed as Record<string, unknown>
      const read = (key: string): string[] => Array.isArray(document[key])
        ? (document[key] as unknown[]).filter((value): value is string => typeof value === 'string')
        : []
      const endpoints: QoderEndpoints = {
        centerNodes: read('centerNodes'),
        inferNodes: read('inferNodes'),
        openapiNodes: read('openapiNodes'),
      }
      const inferBase = endpoints.inferNodes[0]
      this.endpointsCache = { at: Date.now(), inferBase: inferBase ?? this.gatewayOverride ?? QODER_GATEWAY_BASE }
      return endpoints
    } catch (error: unknown) {
      this.logger?.warn(
        'dsh-llm-bridge: qoder node discovery failed; using the default gateway',
        safeMessage(error),
      )
      this.endpointsCache = { at: Date.now(), inferBase: this.gatewayOverride ?? QODER_GATEWAY_BASE }
      return undefined
    }
  }

  /**
   * POST the inference endpoint; a successful answer is an SSE stream already
   * translated into ordinary OpenAI frames.
   */
  async chatStream(
    credential: QoderCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<QoderChatResult> {
    let signed: SignedRequest
    try {
      signed = this.signInferRequest(credential, bodyJson)
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `qoder signing failed: ${safeMessage(error)}` }
    }
    let response: Response
    try {
      response = await fetch(signed.url, {
        method: 'POST',
        headers: { ...signed.headers, 'Accept': 'text/event-stream' },
        body: signed.body,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${safeMessage(error)}` }
    }
    if (response.ok) {
      return {
        ok: true,
        response: { body: translateQoderStream(this.api(), response.body, this.logger) },
      }
    }
    const text = safeMessage((await response.text()).slice(0, ERROR_BODY_LIMIT))
    return {
      ok: false,
      status: response.status,
      kind: classifyQoderError(response.status, text),
      message: text,
    }
  }

  /**
   * POST the device-token refresh.
   *
   * The answer's refresh token is a *rotation*: the one sent here stops
   * working, so the caller must persist the result (the store writes it back).
   */
  async refreshToken(credential: QoderCredential): Promise<QoderRefreshOutcome> {
    const response = await fetch(`${QODER_OPENAPI_BASE}${REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer' },
      body: JSON.stringify({ refresh_token: credential.refreshToken }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `qoder: token refresh rejected (http ${response.status}): ${safeMessage(text.slice(0, ERROR_BODY_LIMIT))}`
        + ` [machine ${qoderCredentialKey(credential.machineId).length}-char key]`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('qoder: token refresh returned a non-JSON document')
    }
    return parseQoderRefreshResponse(parsed)
  }

  /**
   * GET the model catalog and keep the rows this driver can serve.
   *
   * Only `source: system` rows are kept — a BYOK row would need the user's own
   * key — only `format: openai` rows are meaningful through a chat-completions
   * shim, and only `enable: true` rows are exposed. `enable` is an
   * account-level entitlement flag, not a UI default: a model with
   * `enable: false` is not drivable on this account, and requesting it makes
   * the gateway silently fall back to its hard default model (observed answering
   * as "Qwen3.5") instead of erroring. Dropping those rows keeps the host's
   * model picker honest, so a user can only select a model the account can use.
   */
  async fetchModels(credential: QoderCredential): Promise<readonly QoderModelInfo[]> {
    const context = this.buildContext(credential)
    let signed: SignedRequest
    try {
      const prepared = context.prepareRequest(this.inferBase(), MODEL_LIST_PATH, 'GET', 'auth')
      signed = { url: prepared.url, headers: Object.fromEntries(prepared.headers), body: prepared.body }
      prepared.free()
    } finally {
      context.free()
    }
    const response = await fetch(signed.url, {
      method: 'GET',
      headers: signed.headers,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `qoder: model catalog request failed (http ${response.status}): ${safeMessage(text.slice(0, ERROR_BODY_LIMIT))}`,
      )
    }
    const opened = openServerPayload(this.api(), text)
    let parsed: unknown
    try {
      parsed = JSON.parse(opened)
    } catch {
      throw new Error('qoder: model catalog was not JSON')
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('qoder: model catalog had an unexpected shape')
    const document = parsed as Record<string, unknown>
    // `chat`, `developer`, `assistant` and `app` currently carry an identical
    // roster; the declared scene is read first so a divergence follows the
    // surface this driver actually declares itself as.
    const rows = document[QODER_SCENE] ?? document['chat']
    if (!Array.isArray(rows)) throw new Error('qoder: model catalog carried no model list')
    const models: QoderModelInfo[] = []
    for (const row of rows) {
      const mapped = mapQoderModel(row)
      if (mapped === undefined) continue
      if (mapped.source !== 'system') continue
      const format = typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['format'] : undefined
      if (format !== undefined && format !== 'openai') continue
      if (!mapped.enabled) continue
      models.push(mapped)
    }
    if (models.length === 0) throw new Error('qoder: model catalog resolved to an empty list')
    return models
  }
}
