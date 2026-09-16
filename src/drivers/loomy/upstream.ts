/**
 * Loomy imodel upstream client. The imodel backend is itself OpenAI
 * compatible (`/models`, `/chat/completions`, standard SSE chunks with
 * `delta.reasoning_content`), so the wire protocol needs no translation —
 * only three Loomy-private facts:
 *
 * 1. Every request authenticates with BOTH `Authorization: Bearer <session>`
 *    and `token: <session>` (one alone is rejected).
 * 2. Every chat request must carry a freshly generated W3C `traceparent`
 *    header; without it the endpoint hangs until timeout instead of
 *    answering with an HTTP error.
 * 3. `tool_choice` must be the OpenAI *string* form; the object form
 *    (`{type:"auto"}`, which pi-ai emits) returns HTTP 400.
 *
 * @module dsh-llm-bridge/drivers/loomy/upstream
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { BridgeChatResult, BridgeErrorKind } from '../../core/types.ts'
import type { LoomySession } from './auth.ts'
import { LOOMY_BASE_URL, LOOMY_CLIENT_VERSION } from './meta.ts'

export type LoomyChatResult = BridgeChatResult

/** Wire effort spellings the Loomy catalog declares. */
export type LoomyEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

/** One chat model the Loomy catalog describes, normalized for the adapter. */
export interface LoomyModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  reasoning?: LoomyModelReasoning
}

/** Reasoning metadata declared for one model. */
export interface LoomyModelReasoning {
  supports: boolean
  /** Selectable wire effort values, e.g. `['none','low','medium','high','xhigh']`. */
  supportedEfforts: readonly LoomyEffort[]
  /** Default wire effort the platform applies. */
  defaultEffort?: LoomyEffort
}

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Quota/balance failure markers, ASCII lowercase plus the Chinese forms. */
const HARD_QUOTA_MARKERS: readonly string[] = [
  'insufficient', 'quota exceeded', 'quota exhaust', 'payment required',
  'out of points', 'no points', 'points not enough', 'not enough points',
  '积分不足', '额度不足', '余额不足', '点数不足', '积分用完', '额度用尽',
]

const EFFORT_VALUES: readonly LoomyEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']

/** Generate a W3C traceparent: `00-<32hex trace-id>-<16hex span-id>-01`. */
function traceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
}

/**
 * Headers shared by every request. `ChatId`/`MsgId`/`TurnId` are optional on
 * the wire but always sent by the official client, so they are regenerated
 * per request here as well.
 */
function commonHeaders(session: LoomySession): Record<string, string> {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'loomy-version': LOOMY_CLIENT_VERSION,
    'traceparent': traceparent(),
    'ChatId': randomUUID(),
    'MsgId': randomUUID(),
    'TurnId': randomUUID(),
    'token': session.session,
  }
}

/** Chat headers add the Bearer half of imodel's dual session auth. */
function chatHeaders(session: LoomySession): Record<string, string> {
  return {
    ...commonHeaders(session),
    'Authorization': `Bearer ${session.session}`,
  }
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyLoomyError(status: number, body: string): BridgeErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_QUOTA_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  if (status === 401) return 'session_dead'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * Normalize an OpenAI chat-completions body for the Loomy upstream: flatten
 * `tool_choice` to its string form (the object form returns 400). The
 * endpoint natively accepts `role: "developer"`, non-streaming requests, and
 * unknown fields, so nothing else is rewritten — the body otherwise passes
 * through unchanged.
 */
export function prepareLoomyChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/** Rewrite OpenAI `tool_choice` spellings into Loomy's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  if (!('tool_choice' in obj)) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') return
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none' || type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      obj['tool_choice'] = name.trim() !== '' ? name.trim() : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** One model row as the Loomy `/models` endpoint describes it. */
interface RawModel {
  id?: unknown
  name?: unknown
  type?: unknown
  context_length?: unknown
  max_output_tokens?: unknown
  reasoning_efforts?: unknown
  default_reasoning_effort?: unknown
  capabilities?: unknown
}

/** Map one raw catalog row; returns undefined for non-chat/unusable rows. */
function mapModel(raw: RawModel): LoomyModelInfo | undefined {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '') return undefined
  // Image-generation rows (`type: "image"`) do not serve chat completions;
  // the shim only speaks chat, so they are dropped here.
  if (raw.type !== undefined && raw.type !== 'chat') return undefined
  const contextWindow = typeof raw.context_length === 'number' ? raw.context_length : 0
  const maxTokens = typeof raw.max_output_tokens === 'number' ? raw.max_output_tokens : 0
  if (contextWindow <= 0 || maxTokens <= 0) return undefined
  const caps = (typeof raw.capabilities === 'object' && raw.capabilities !== null
    ? raw.capabilities
    : {}) as Record<string, unknown>
  const inputModalities = Array.isArray(caps['input_modalities']) ? caps['input_modalities'] : []
  const supportsImages = caps['vision'] === true
    || inputModalities.some(value => value === 'image')
  // Only text/image chat input is declared downstream: audio/video entries
  // exist in this catalog but DSH chat cannot send them, so they are not
  // advertised (over-claiming admits media the host then rejects).
  const reasoningSupported = caps['reasoning'] === true
  let reasoning: LoomyModelReasoning | undefined
  if (reasoningSupported) {
    const efforts = Array.isArray(raw.reasoning_efforts)
      ? raw.reasoning_efforts.filter((value): value is LoomyEffort =>
        typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value))
      : []
    const defaultEffort = typeof raw.default_reasoning_effort === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(raw.default_reasoning_effort)
      ? raw.default_reasoning_effort as LoomyEffort
      : undefined
    reasoning = {
      supports: true,
      supportedEfforts: efforts,
      ...defaultEffort === undefined ? {} : { defaultEffort },
    }
  }
  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    contextWindow,
    maxTokens,
    supportsImages,
    ...reasoning === undefined ? {} : { reasoning },
  }
}

/**
 * Upstream HTTP client for the Loomy imodel backend. One instance serves the
 * whole driver; requests take the session explicitly so a desktop-app
 * re-login applies on the next call.
 */
export class LoomyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw (SSE) response. */
  async chatStream(
    session: LoomySession,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<LoomyChatResult> {
    let response: Response
    try {
      response = await fetch(`${LOOMY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(session),
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyLoomyError(response.status, text),
      message: text,
    }
  }

  /** GET the model catalog; chat models only, normalized for the adapter. */
  async fetchModels(session: LoomySession): Promise<readonly LoomyModelInfo[]> {
    const response = await fetch(`${LOOMY_BASE_URL}/models`, {
      headers: commonHeaders(session),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`loomy models ${classifyLoomyError(response.status, text)} (http ${response.status}): ${text.slice(0, 160)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`loomy models returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`loomy models returned an unexpected document (http ${response.status})`)
    }
    const rawModels = (parsed as Record<string, unknown>)['data']
    if (!Array.isArray(rawModels)) throw new Error('loomy model catalog carries no data[] list')
    const models = rawModels
      .map(raw => (typeof raw === 'object' && raw !== null ? mapModel(raw as RawModel) : undefined))
      .filter((model): model is LoomyModelInfo => model !== undefined)
    if (models.length === 0) throw new Error('loomy model catalog resolved to an empty list')
    return models
  }
}
