/**
 * Generic same-origin status route mounting for a driver's plugin card.
 *
 * The core owns the HTTP mechanism shared by every driver: GET-only
 * handling, the loopback trust gate, JSON envelopes, token-redacting error
 * text, and registration on the optional webServer service. The driver
 * supplies only `build()` — whatever platform-specific status document its
 * card renders. The route answers loopback browser requests only and must
 * never carry token material.
 *
 * @module dsh-llm-bridge/core/status-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'

/** Redact token-like content before it crosses to the browser. */
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. The Host check drops
 * DNS-rebinding pages (their Host is the attacker's domain, not loopback);
 * the card's same-origin fetches carry no Origin and pass on Host alone.
 */
function trustedLoopback(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/**
 * Build a standalone request handler for one status document. Extracted as
 * a factory (rather than mounting directly) so tests can mount it on a bare
 * HTTP server.
 */
export function createStatusHandler(
  build: () => Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!trustedLoopback(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await build())
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerStatusRoute(ctx: Context, path: string, build: () => Promise<unknown>): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: createStatusHandler(build),
    })
    return () => {
      dispose()
    }
  }, 'dsh-llm-bridge: Web status route')
}
