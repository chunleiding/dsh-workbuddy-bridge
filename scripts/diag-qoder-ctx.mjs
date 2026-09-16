import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadQoderWasm, openServerPayload } from '../src/drivers/qoder/wasm.ts'
import {
  qoderCredentialKey,
  credentialFromUserInfo,
  runtimeAuthFieldsInput,
  signingUserInfo,
} from '../src/drivers/qoder/credential.ts'
import {
  QODER_COSY_VERSION,
  QODER_CLIENT_METADATA,
  QODER_GATEWAY_BASE,
  QODER_SCENE,
} from '../src/drivers/qoder/meta.ts'

const api = loadQoderWasm()
const base = join(homedir(), '.qoderworkcn', '.auth-cn')
const machineId = readFileSync(join(base, 'id'), 'utf8').trim()
const blob = readFileSync(join(base, 'user'), 'utf8').trim()
const doc = JSON.parse(api.credential_storage_decrypt(blob, qoderCredentialKey(machineId)))

const credential = credentialFromUserInfo(doc, machineId)
const generated = JSON.parse(api.generate_runtime_auth_fields(runtimeAuthFieldsInput(credential)))
const userInfo = signingUserInfo(credential, generated)

const ctx = api.createContext(machineId, QODER_COSY_VERSION, userInfo, JSON.stringify(QODER_CLIENT_METADATA))
ctx.refreshAuthFields(userInfo)
try {
  const prepared = ctx.prepareRequest(QODER_GATEWAY_BASE, '/api/v2/model/list?Encode=1', 'GET', 'auth')
  const res = await fetch(prepared.url, { method: 'GET', headers: Object.fromEntries(prepared.headers) })
  const text = await res.text()
  const opened = openServerPayload(api, text)
  const parsed = JSON.parse(opened)
  const rows = parsed[QODER_SCENE] ?? parsed['chat'] ?? []
  console.log('scene used:', parsed[QODER_SCENE] ? QODER_SCENE : 'chat', '| total rows:', rows.length)
  for (const row of rows) {
    if (row.key !== 'qmodel_38max') continue
    console.log('\n===== qmodel_38max (RAW) =====')
    console.log(JSON.stringify(row, null, 2))
    console.log('\n--- context_config / max_input_tokens only ---')
    console.log('context_config =', JSON.stringify(row.context_config))
    console.log('max_input_tokens =', row.max_input_tokens)
  }
} finally {
  ctx.free()
}
