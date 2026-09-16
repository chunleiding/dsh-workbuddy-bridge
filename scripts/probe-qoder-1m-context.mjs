/**
 * Live end-to-end probe for Qoder / Qwen3.8-Max 1M context window.
 *
 * Sends synthetic long inputs through the real driver path
 * (adapter -> pi-ai -> loopback shim -> Qoder gateway) and reports whether the
 * gateway accepts them. Because the gateway auto-selects the smallest context
 * tier that fits the request, an input over 200K forces the 400K tier and an
 * input over 400K forces the 1M tier — so the staged sizes below are a direct
 * test of the real ceiling.
 *
 *   node scripts/probe-qoder-1m-context.mjs [tokens...]
 *     e.g. node scripts/probe-qoder-1m-context.mjs 260000 450000
 *
 * This is a LIVE check with a live side effect (token refresh rotates, as in
 * live-e2e-qoder.mjs). It also spends real upstream tokens proportional to the
 * input sizes — that is the point of the probe.
 */

import { createQoderAdapter, createQoderShim, QoderCatalog, QoderCredentialStore, QoderUpstreamClient } from '../lib/index.js'

const targets = (process.argv.slice(2).length ? process.argv.slice(2) : ['260000', '450000']).map((n) => Number(n))
if (targets.some((n) => !Number.isFinite(n) || n <= 0)) {
  console.error('usage: node scripts/probe-qoder-1m-context.mjs [tokens...]')
  process.exit(2)
}

const model = 'qmodel_38max'
const logger = {
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
}

const client = new QoderUpstreamClient({ logger })
const store = new QoderCredentialStore({ refresh: (c) => client.refreshToken(c) })
const catalog = new QoderCatalog()
const shim = createQoderShim({ store, client, catalog, logger })
await shim.ready

const { adapter, invalidate } = createQoderAdapter({ shim, store, catalog })

const status = await store.status()
console.log('sign-in:', status.state, status.nickname ?? '', status.userTag ?? '')
if (status.state !== 'signed-in') {
  console.error('not signed in: open the Qoder app once, then re-run this script')
  await shim.close()
  process.exit(1)
}

// Pull the live catalog so the reported context window reflects the real tier table.
const credential = await store.resolve()
const upstream = await client.fetchModels(credential)
catalog.set([...upstream])
invalidate()
const resolved = await adapter.resolveModel('qoder', model)
console.log(`resolved model: ${resolved.name}`)
console.log(`REPORTED contextWindow (what DSH tells the host): ${resolved.context?.contextWindow} tokens`)

const line = 'The quick brown fox jumps over the lazy dog near the riverbank at midnight. '
/** Build a synthetic filler block of approximately `tokens` tokens (≈4 chars/token for English). */
function filler(tokens) {
  const chars = Math.round(tokens * 4)
  let s = ''
  while (s.length < chars) s += line
  return s.slice(0, chars)
}

console.log('\n=== staged long-input probe ===')
let allOk = true
for (const target of targets) {
  const text = filler(target)
  const approxTokens = Math.round(text.length / 4)
  const userMsg =
    text +
    '\n\n[END OF FILLER — do not repeat or analyze any of it. Just reply with the two characters: 收到]'
  console.log(`\n--- stage: ~${approxTokens.toLocaleString()} input tokens (${text.length.toLocaleString()} chars) ---`)
  const started = Date.now()
  let firstTokenMs = -1
  let reply = ''
  let chunkTypes = new Map()
  let errored = null
  try {
    for await (const chunk of adapter.stream({
      provider: 'qoder',
      model,
      system: '你只需回复两个字：收到。不要复述、不要分析、不要总结用户消息里的任何内容。',
      messages: [
        {
          id: 'probe-1',
          role: 'user',
          content: [{ type: 'text', text: userMsg }],
          source: { kind: 'user' },
        },
      ],
    })) {
      chunkTypes.set(chunk.type, (chunkTypes.get(chunk.type) ?? 0) + 1)
      if (chunk.type === 'text-delta' || chunk.type === 'text') {
        if (firstTokenMs < 0) firstTokenMs = Date.now() - started
        reply += chunk.text ?? chunk.delta ?? ''
      }
    }
  } catch (e) {
    errored = e
  }
  const elapsed = Date.now() - started
  if (errored) {
    allOk = false
    const msg = String(errored?.message ?? errored)
    const kind = /context|token|length|too long|exceed|maximum|413|429|budget/i.test(msg)
      ? (/\b429\b|budget|rate/i.test(msg) ? 'RATE/BUDGET-LIMIT' : 'CONTEXT-LENGTH')
      : 'OTHER'
    console.log(`RESULT: REJECTED (${kind})`)
    console.log(`  error: ${msg.slice(0, 600)}`)
    console.log(`  firstTokenMs: ${firstTokenMs < 0 ? 'n/a' : firstTokenMs} | elapsed: ${elapsed}ms`)
  } else {
    console.log(`RESULT: ACCEPTED`)
    console.log(`  firstTokenMs: ${firstTokenMs < 0 ? 'n/a' : firstTokenMs} | elapsed: ${elapsed}ms`)
    console.log(`  chunk types: ${[...chunkTypes].map(([t, c]) => `${t}=${c}`).join(' ') || '(none)'}`)
    console.log(`  reply: ${JSON.stringify(reply.trim().slice(0, 40))}`)
  }
}

await shim.close()
console.log(`\nPROBE ${allOk ? 'ALL STAGES ACCEPTED' : 'AT LEAST ONE STAGE REJECTED'}`)
