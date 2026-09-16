/**
 * Minimal seams shared by the bridge core and every platform driver.
 *
 * These are the only types a driver has to satisfy to plug a closed agent's
 * native protocol into the loopback shim. They are deliberately tiny: the
 * core owns the mechanisms (credential lifecycle, catalog, loopback, SSE
 * pipe, DSH adapter, heartbeat, status route); every platform fact lives in
 * the driver.
 *
 * @module dsh-llm-bridge/core/types
 */

/**
 * Upstream failure classes the shim maps onto distinct HTTP answers.
 *
 * The class set is core because the shim needs one stable
 * kind-to-HTTP-status mapping; deciding *which* class a platform response
 * belongs to is the driver's job (each platform speaks its own error
 * dialect).
 */
export type BridgeErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/**
 * One chat round either carries the platform's raw successful response
 * stream (the shim pipes it verbatim — a driver whose platform already
 * speaks OpenAI SSE needs no translation) or a classified failure.
 *
 * Only the response body is read by the core, so any fetch-shaped
 * `Response` satisfies the success variant structurally.
 */
export type BridgeChatResult =
  | { ok: true; response: { body: ReadableStream<Uint8Array> | null } }
  | { ok: false; status: number; kind: BridgeErrorKind; message: string }

/**
 * The smallest upstream seam: turn one OpenAI-shaped chat request into the
 * platform's native call and answer with either its stream or a classified
 * failure.
 *
 * Outbound protocol conversion (forced streaming, header dialects, body
 * reshaping) happens *inside* the driver's implementation — the core shim
 * hands it the raw request body and never inspects platform wire shapes.
 */
export interface BridgeUpstream<C> {
  chat(credential: C, bodyJson: string, signal?: AbortSignal): Promise<BridgeChatResult>
}

/** Anything the generic catalog and adapter need to key a model by. */
export interface IdentifiedModel {
  id: string
}
