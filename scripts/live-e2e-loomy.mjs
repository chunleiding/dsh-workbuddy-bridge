/**
 * Live end-to-end check for the Loomy driver (NOT part of the offline suite):
 * adapter -> pi-ai -> loopback shim -> real Loomy imodel upstream, using the
 * Loomy desktop app's session.
 *
 *   node scripts/live-e2e-loomy.mjs
 */

import {
  createLoomyAdapter,
  createLoomyShim,
  LoomyCatalog,
  LoomySessionStore,
  LoomyUpstreamClient,
} from '../lib/index.js'

const client = new LoomyUpstreamClient()
const store = new LoomySessionStore()
const catalog = new LoomyCatalog()
const shim = createLoomyShim({ store, client, catalog })
await shim.ready
console.log('shim listening:', shim.baseUrl())

const { adapter, invalidate } = createLoomyAdapter({ shim, store, catalog })

const staticList = await adapter.listModels('loomy')
console.log('static catalog:', staticList.map(model => model.id).join(', '))

const session = await store.resolve().catch(() => undefined)
if (session === undefined) {
  console.error('not signed in: open the Loomy desktop app once')
  process.exit(1)
}
const refreshed = await client.fetchModels(session)
catalog.set([...refreshed])
invalidate()
const liveList = await adapter.listModels('loomy')
console.log('upstream catalog:', liveList.map(model => model.id).join(', '))

await adapter.resolveModel('loomy', 'qwen3.5-flash')
console.log('resolved qwen3.5-flash ok')

console.log('streaming one reply …')
let text = ''
for await (const chunk of adapter.stream({
  provider: 'loomy',
  model: 'qwen3.5-flash',
  system: '你是简洁的中文助手。',
  messages: [{
    id: 'e2e-1',
    role: 'user',
    content: [{ type: 'text', text: '只回复八个字以内：链路验证成功' }],
    source: { kind: 'user' },
  }],
})) {
  if (chunk.type === 'text-delta' || chunk.type === 'text') {
    text += chunk.text ?? chunk.delta ?? ''
  }
}
console.log('reply:', JSON.stringify(text))
await shim.close()
console.log('LOOMY E2E OK')
