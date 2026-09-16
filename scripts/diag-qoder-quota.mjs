import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadQoderWasm } from '../src/drivers/qoder/wasm.ts'
import { qoderCredentialKey } from '../src/drivers/qoder/credential.ts'

const api = loadQoderWasm()
const base = join(homedir(), '.qoderworkcn', '.auth-cn')
const machineId = readFileSync(join(base, 'id'), 'utf8').trim()
const blob = readFileSync(join(base, 'user'), 'utf8').trim()

const key = qoderCredentialKey(machineId)
const plaintext = api.credential_storage_decrypt(blob, key)
const doc = JSON.parse(plaintext)
const accessToken = doc['access_token']
console.log('uid        =', doc['uid'])
console.log('user_type  =', doc['user_type'])
console.log('user_tag   =', doc['user_tag'])
console.log('expire_time=', doc['expire_time'], '->', new Date(Number(doc['expire_time']) > 1e12 ? Number(doc['expire_time']) : Number(doc['expire_time']) * 1000).toISOString())
console.log('token len  =', accessToken?.length, 'prefix=', accessToken?.slice(0, 6))

const headers = { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
for (const path of ['/api/v2/user/plan', '/api/v2/quota/usage']) {
  const url = `https://openapi.qoder.com.cn${path}`
  console.log(`\n===== GET ${url} =====`)
  try {
    const res = await fetch(url, { method: 'GET', headers })
    const text = await res.text()
    console.log('HTTP', res.status)
    let json
    try { json = JSON.parse(text) } catch { console.log(text.slice(0, 800)); continue }
    console.log(JSON.stringify(json, null, 2).slice(0, 1600))
  } catch (e) {
    console.log('FETCH ERROR', String(e).slice(0, 300))
  }
}
