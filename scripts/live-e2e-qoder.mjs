/**
 * Live end-to-end check for the Qoder driver (NOT part of the offline suite):
 * adapter -> pi-ai -> loopback shim -> real Qoder gateway, using the Qoder
 * desktop app's own sign-in.
 *
 *   node scripts/live-e2e-qoder.mjs [model]
 *
 * This is the regression harness for everything the offline specs cannot
 * reach: the wasm's request signing, the COSY header set, the SSE envelope,
 * and the refresh-token rotation.
 *
 * It is a *live* check with a live side effect. The Qoder refresh token
 * rotates on every use, so if this run needs a token refresh it re-seals the
 * rotated credential back into `~/.qoderworkcn/.auth-cn/user` — that is the
 * driver's normal behaviour, it is what keeps the user's own Qoder app signed
 * in, and the previous file is left behind as a `.bak-…` sibling.
 */

import { createQoderAdapter, createQoderShim, QoderCatalog, QoderCredentialStore, QoderUpstreamClient } from '../lib/index.js'

const model = process.argv[2] ?? 'auto'

/** Surface the driver's own diagnostics instead of swallowing them. */
const logger = {
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
}

const client = new QoderUpstreamClient({ logger })
const store = new QoderCredentialStore({ refresh: credential => client.refreshToken(credential) })
const catalog = new QoderCatalog()
const shim = createQoderShim({ store, client, catalog, logger })
await shim.ready
console.log('shim listening:', shim.baseUrl())

const { adapter, invalidate } = createQoderAdapter({ shim, store, catalog })

const staticList = await adapter.listModels('qoder')
console.log('static catalog:', staticList.length, 'models —', staticList.map(entry => entry.id).join(', '))

const status = await store.status()
console.log('sign-in:', status.state, status.nickname ?? '', status.userTag ?? '')
if (status.state !== 'signed-in') {
  console.error('not signed in: open the Qoder app once, then re-run this script')
  await shim.close()
  process.exit(1)
}

// `current()` is the on-disk state; `resolve()` is what the shim puts on the
// wire, and it is where a rotation happens if one is due.
const before = await store.current()
console.log('auth dir:', store.authDirPath())
console.log('token expires:', new Date(before.expiresAtMs).toISOString())

const credential = await store.resolve()
if (credential.refreshToken !== before.refreshToken) {
  console.log('refresh token rotated and written back during resolve()')
} else {
  console.log('no rotation was needed (token still fresh)')
}

const endpoints = await client.discoverEndpoints(credential)
console.log('region nodes:', endpoints === undefined ? '(using the cached/default gateway)' : endpoints.inferNodes.join(', '))

const upstream = await client.fetchModels(credential)
catalog.set([...upstream])
invalidate()
const liveList = await adapter.listModels('qoder')
console.log('upstream catalog:', liveList.length, 'models —', liveList.map(entry => entry.id).join(', '))

const resolved = await adapter.resolveModel('qoder', model)
console.log('resolved', model, '->', resolved.name, '| efforts:',
  resolved.reasoning?.efforts?.map(effort => effort.id).join('/') ?? '(none)',
  '| context:', resolved.context?.contextWindow)

console.log('streaming one reply …')
let text = ''
const chunkTypes = new Map()
const started = Date.now()
for await (const chunk of adapter.stream({
  provider: 'qoder',
  model,
  system: '你是简洁的中文助手。',
  messages: [{
    id: 'e2e-1',
    role: 'user',
    content: [{ type: 'text', text: '只回复八个字以内：链路验证成功' }],
    source: { kind: 'user' },
  }],
})) {
  chunkTypes.set(chunk.type, (chunkTypes.get(chunk.type) ?? 0) + 1)
  if (chunk.type === 'text-delta' || chunk.type === 'text') {
    text += chunk.text ?? chunk.delta ?? ''
  }
}
console.log('reply:', JSON.stringify(text))
console.log('chunk types:', [...chunkTypes].map(([type, count]) => `${type}=${count}`).join(' '))
console.log('elapsed:', `${Date.now() - started}ms`)

if (text.trim() === '') {
  console.error('FAIL: the upstream answered with no text')
  await shim.close()
  process.exit(1)
}

// A rotation is silent by design, so report the on-disk outcome explicitly.
const after = await store.current()
if (after.refreshToken !== before.refreshToken) {
  console.log('on-disk refresh token differs from the one this run started with — the app stays signed in')
} else {
  console.log('on-disk credential unchanged')
}
console.log('token now expires:', new Date(after.expiresAtMs).toISOString())

await shim.close()
console.log('QODER E2E OK')
