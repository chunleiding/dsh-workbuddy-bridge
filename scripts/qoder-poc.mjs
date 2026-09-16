#!/usr/bin/env node
/**
 * QoderWork CN driver — live PoC.
 *
 * Proves the whole upstream path works end-to-end by reusing Qoder's own
 * credentials and its signed/binary protocol:
 *
 *   credential (encrypted on disk)  ->  plaintext userInfo
 *   userInfo + machine_id           ->  QoderContext (official wasm)
 *   QoderContext.prepareInferRequest->  signed url + encrypted body
 *   POST                            ->  encrypted SSE
 *   decrypt_server_response         ->  OpenAI chat.completion chunks
 *
 * Everything cryptographic is delegated to Qoder's own
 * `qoder_auth_wasm_bg.wasm`; nothing is reimplemented. The only piece lifted
 * from the app bundle is the *readable* wasm-bindgen glue (the app ships a
 * non-obfuscated copy inside `out/main/main.js`), extracted by anchor.
 *
 * Usage:
 *   node scripts/qoder-poc.mjs auth            # decrypt + describe credential
 *   node scripts/qoder-poc.mjs models          # list the model catalog
 *   node scripts/qoder-poc.mjs chat [model] [prompt]
 *   node scripts/qoder-poc.mjs refresh         # refresh + write credential back
 *
 * Secrets are never printed — only lengths and sha256 prefixes.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// ---------------------------------------------------------------- locations
const APP = '/Applications/QoderWork CN.app'
const ASAR = path.join(APP, 'Contents/Resources/app.asar')
const WASM = path.join(APP, 'Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm')
const HOME_Q = path.join(os.homedir(), '.qoderworkcn')
const AUTH_DIR = path.join(HOME_Q, '.auth-cn')
const CRED_FILE = path.join(AUTH_DIR, 'user')
const ID_FILE = path.join(AUTH_DIR, 'id')

const COSY_VERSION = '1.1.26'
const CENTER = 'https://gateway.qoder.com.cn'
const INFER_PATH = '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=common'

// ------------------------------------------------------- wasm glue assembly
const GLUE_START = 'function decrypt_server_response('
const GLUE_END = 'let initialized$1=!1;'

function extractGlue() {
  const buf = fs.readFileSync(ASAR)
  const a = Buffer.from(GLUE_START)
  const z = Buffer.from(GLUE_END)
  const s = buf.indexOf(a)
  if (s < 0) throw new Error(`glue anchor not found in ${ASAR}`)
  const e = buf.indexOf(z, s)
  if (e < 0) throw new Error('glue tail anchor not found')
  return buf.subarray(s, e + z.length).toString('utf8')
}

/** Ported verbatim from the SDK runtime, names remapped onto the glue helpers. */
const PORTED = `
function credential_storage_decrypt(A,e){let t,i;try{const l=wasm.__wbindgen_add_to_stack_pointer(-16),
B=passStringToWasm0(A,wasm.__wbindgen_export2,wasm.__wbindgen_export3),c=WASM_VECTOR_LEN,
Q=passStringToWasm0(e,wasm.__wbindgen_export2,wasm.__wbindgen_export3),E=WASM_VECTOR_LEN;
wasm.credential_storage_decrypt(l,B,c,Q,E);
var n=getDataViewMemory0().getInt32(l+0,!0),r=getDataViewMemory0().getInt32(l+4,!0),
o=getDataViewMemory0().getInt32(l+8,!0),s=getDataViewMemory0().getInt32(l+12,!0),a=n,g=r;
if(s)throw a=0,g=0,takeObject(o);return t=a,i=g,getStringFromWasm0(a,g)
}finally{wasm.__wbindgen_add_to_stack_pointer(16),wasm.__wbindgen_export4(t,i,1)}}
function credential_storage_encrypt(A,e){let t,i;try{const l=wasm.__wbindgen_add_to_stack_pointer(-16),
B=passStringToWasm0(A,wasm.__wbindgen_export2,wasm.__wbindgen_export3),c=WASM_VECTOR_LEN,
Q=passStringToWasm0(e,wasm.__wbindgen_export2,wasm.__wbindgen_export3),E=WASM_VECTOR_LEN;
wasm.credential_storage_encrypt(l,B,c,Q,E);
var n=getDataViewMemory0().getInt32(l+0,!0),r=getDataViewMemory0().getInt32(l+4,!0),
o=getDataViewMemory0().getInt32(l+8,!0),s=getDataViewMemory0().getInt32(l+12,!0),a=n,g=r;
if(s)throw a=0,g=0,takeObject(o);return t=a,i=g,getStringFromWasm0(a,g)
}finally{wasm.__wbindgen_add_to_stack_pointer(16),wasm.__wbindgen_export4(t,i,1)}}
function decrypt_server_response(A){let t,i;try{const l=wasm.__wbindgen_add_to_stack_pointer(-16),
B=passStringToWasm0(A,wasm.__wbindgen_export2,wasm.__wbindgen_export3),c=WASM_VECTOR_LEN;
wasm.decrypt_server_response(l,B,c);
var n=getDataViewMemory0().getInt32(l+0,!0),r=getDataViewMemory0().getInt32(l+4,!0),
o=getDataViewMemory0().getInt32(l+8,!0),s=getDataViewMemory0().getInt32(l+12,!0),a=n,g=r;
if(s)throw a=0,g=0,takeObject(o);return t=a,i=g,getStringFromWasm0(a,g)
}finally{wasm.__wbindgen_add_to_stack_pointer(16),wasm.__wbindgen_export4(t,i,1)}}
function generate_runtime_auth_fields(A){let t,i;try{const l=wasm.__wbindgen_add_to_stack_pointer(-16),
B=passStringToWasm0(A,wasm.__wbindgen_export2,wasm.__wbindgen_export3),c=WASM_VECTOR_LEN;
wasm.generate_runtime_auth_fields(l,B,c);
var n=getDataViewMemory0().getInt32(l+0,!0),r=getDataViewMemory0().getInt32(l+4,!0),
o=getDataViewMemory0().getInt32(l+8,!0),s=getDataViewMemory0().getInt32(l+12,!0),a=n,g=r;
if(s)throw a=0,g=0,takeObject(o);return t=a,i=g,getStringFromWasm0(a,g)
}finally{wasm.__wbindgen_add_to_stack_pointer(16),wasm.__wbindgen_export4(t,i,1)}}
function _opt(s){return isLikeNone(s)?0:passStringToWasm0(s,wasm.__wbindgen_export2,wasm.__wbindgen_export3)}
class RequestResult{
  constructor(p){this.__wbg_ptr=p>>>0}
  free(){const p=this.__wbg_ptr;this.__wbg_ptr=0;wasm.__wbg_requestresult_free(p,0)}
  get headers(){return takeObject(wasm.requestresult_headers(this.__wbg_ptr))}
  _s(fn){let a,b;try{const r=wasm.__wbindgen_add_to_stack_pointer(-16);fn(r,this.__wbg_ptr);
    return a=getDataViewMemory0().getInt32(r+0,!0),b=getDataViewMemory0().getInt32(r+4,!0),getStringFromWasm0(a,b)
  }finally{wasm.__wbindgen_add_to_stack_pointer(16),wasm.__wbindgen_export4(a,b,1)}}
  get url(){return this._s(wasm.requestresult_url)}
  get body(){return this._s(wasm.requestresult_body)}
}
class QoderContext{
  constructor(machineId,cosyVersion,userInfoJson,clientMetaJson){
    try{const r=wasm.__wbindgen_add_to_stack_pointer(-16),
      p1=passStringToWasm0(machineId,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l1=WASM_VECTOR_LEN,
      p2=passStringToWasm0(cosyVersion,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l2=WASM_VECTOR_LEN,
      p3=passStringToWasm0(userInfoJson,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l3=WASM_VECTOR_LEN;
    const p4=_opt(clientMetaJson),l4=WASM_VECTOR_LEN;
    wasm.qodercontext_new(r,p1,l1,p2,l2,p3,l3,p4,l4);
    const p=getDataViewMemory0().getInt32(r+0,!0),e=getDataViewMemory0().getInt32(r+4,!0);
    if(getDataViewMemory0().getInt32(r+8,!0))throw takeObject(e);
    this.__wbg_ptr=p>>>0}finally{wasm.__wbindgen_add_to_stack_pointer(16)}}
  free(){const p=this.__wbg_ptr;this.__wbg_ptr=0;wasm.__wbg_qodercontext_free(p,0)}
  prepareInferRequest(base,body,modelKey,modelSource){
    try{const r=wasm.__wbindgen_add_to_stack_pointer(-16),
      p1=passStringToWasm0(base,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l1=WASM_VECTOR_LEN,
      p2=passStringToWasm0(body,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l2=WASM_VECTOR_LEN;
    const p3=_opt(modelKey),l3=WASM_VECTOR_LEN,p4=_opt(modelSource),l4=WASM_VECTOR_LEN;
    wasm.qodercontext_prepareInferRequest(r,this.__wbg_ptr,p1,l1,p2,l2,p3,l3,p4,l4);
    const p=getDataViewMemory0().getInt32(r+0,!0),e=getDataViewMemory0().getInt32(r+4,!0);
    if(getDataViewMemory0().getInt32(r+8,!0))throw takeObject(e);
    return new RequestResult(p)}finally{wasm.__wbindgen_add_to_stack_pointer(16)}}
  prepareRequest(base,p,method,mode,body,extra){
    try{const r=wasm.__wbindgen_add_to_stack_pointer(-16),
      p1=passStringToWasm0(base,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l1=WASM_VECTOR_LEN,
      p2=passStringToWasm0(p,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l2=WASM_VECTOR_LEN,
      p3=passStringToWasm0(method,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l3=WASM_VECTOR_LEN,
      p4=passStringToWasm0(mode,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l4=WASM_VECTOR_LEN;
    const p5=_opt(body),l5=WASM_VECTOR_LEN,p6=_opt(extra),l6=WASM_VECTOR_LEN;
    wasm.qodercontext_prepareRequest(r,this.__wbg_ptr,p1,l1,p2,l2,p3,l3,p4,l4,p5,l5,p6,l6);
    const x=getDataViewMemory0().getInt32(r+0,!0),e=getDataViewMemory0().getInt32(r+4,!0);
    if(getDataViewMemory0().getInt32(r+8,!0))throw takeObject(e);
    return new RequestResult(x)}finally{wasm.__wbindgen_add_to_stack_pointer(16)}}
  refreshAuthFields(json){try{const r=wasm.__wbindgen_add_to_stack_pointer(-16),
    p=passStringToWasm0(json,wasm.__wbindgen_export2,wasm.__wbindgen_export3),l=WASM_VECTOR_LEN;
    wasm.qodercontext_refreshAuthFields(r,this.__wbg_ptr,p,l);
    const v=getDataViewMemory0().getInt32(r+0,!0);
    if(getDataViewMemory0().getInt32(r+4,!0))throw takeObject(v)
  }finally{wasm.__wbindgen_add_to_stack_pointer(16)}}
}`

export function loadWasm() {
  const stub = 'var createCategoryLogger=()=>({info(){},warn(){},error(){},debug(){},trace(){}});'
  const exports_ = ['decrypt_server_response', 'credential_storage_decrypt', 'credential_storage_encrypt',
    'generate_runtime_auth_fields', 'QoderContext', 'RequestResult']
  const factory = new Function(stub + extractGlue() + PORTED +
    `;return {__wbg_get_imports,__setWasm:m=>{wasm=m},${exports_.join(',')}};`)
  const api = factory()
  api.__setWasm(new WebAssembly.Instance(
    new WebAssembly.Module(fs.readFileSync(WASM)), api.__wbg_get_imports()).exports)
  return api
}

// ------------------------------------------------------------------- helpers
const fp = (s) => crypto.createHash('sha256').update(s ?? '').digest('hex').slice(0, 12)

/**
 * Credential key derivation (reverse-engineered):
 *   key = machine_id[0:16]
 * `machine_id` lives next to the credential; older builds name it `machine_id`,
 * this one ships `id`. The key is passed to the wasm as a 16-char ASCII string,
 * and the wasm base64-decodes the credential blob itself.
 */
function readCredential(api) {
  const machineId = fs.readFileSync(ID_FILE, 'utf8').trim()
  const key = machineId.slice(0, 16)
  const blob = fs.readFileSync(CRED_FILE, 'utf8').trim()
  const userInfo = JSON.parse(api.credential_storage_decrypt(blob, key))
  return { machineId, key, blob, userInfo }
}

/**
 * Mirrors the SDK's `regenerateRuntimeFields()` + `createWasmContext()`:
 * `encrypt_user_info` / `key` are *derived*, not stored — the wasm generates
 * them from uid + organization + data-policy. Without them every authenticated
 * request fails with `{"code":"101","message":"Signature invalid"}`.
 */
export function buildContext(api, cred) {
  const u = cred.userInfo
  const organization_tags = Array.isArray(u.organization_tags) ? u.organization_tags : []
  const generated = JSON.parse(api.generate_runtime_auth_fields(JSON.stringify({
    uid: u.uid,
    organization_id: u.organization_id ?? '',
    organization_tags,
    data_policy_agreed: u.data_policy_agreed === true,
  })))
  const authInfo = JSON.stringify({
    uid: u.uid,
    encrypt_user_info: generated.encrypt_user_info,
    key: generated.key,
    organization_id: u.organization_id ?? '',
    organization_tags,
    data_policy_agreed: u.data_policy_agreed === true,
  })
  const ctx = new api.QoderContext(cred.machineId, COSY_VERSION, authInfo, JSON.stringify({
    client_type: 5, business_product: 'cli', business_type: 'agent', scene: 'assistant',
  }))
  ctx.refreshAuthFields(authInfo)
  return { ctx, authInfo, generated }
}

/**
 * Mirrors the SDK's `AaA()`: server payloads are *usually* encrypted, but some
 * request classes (notably the infer SSE frames) come back as plain JSON.
 * Try the wasm first, fall back to the raw string.
 */
function safeDecrypt(api, text) {
  try { return api.decrypt_server_response(text) } catch { return text }
}

/** Left-pad for column output (console.log has no printf width specifiers). */
const pad = (v, n) => String(v).padEnd(n)

/** SSE frames arrive wrapped as {headers, body:"<json>", statusCode}. */
function unwrap(plain) {
  const j = JSON.parse(plain)
  if (typeof j.body === 'string') {
    try { return { env: j, inner: JSON.parse(j.body) } } catch { return { env: j, inner: null } }
  }
  return { env: null, inner: j }
}

async function readSSE(api, res, onChunk) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const m = /^(?:event|data|id|retry):\s?(.*)$/.exec(line)
      const payload = m ? m[1] : line
      if (!payload || payload === '[DONE]') continue
      if (await onChunk(safeDecrypt(api, payload)) === false) return
    }
  }
}
const withTimeout = (ms) => { const ac = new AbortController(); setTimeout(() => ac.abort(), ms).unref?.(); return ac.signal }

// ---------------------------------------------------------------- subcommands
async function cmdAuth() {
  const api = loadWasm()
  const cred = readCredential(api)
  const u = cred.userInfo
  console.log('machine_id       = %s   (credential key = first 16 chars)', cred.machineId)
  console.log('credential blob  = %d chars (base64)', cred.blob.length)
  console.log('uid              = %s', u.uid)
  console.log('name             = %s', u.name)
  console.log('user_type        = %s   user_tag=%s   allow_byok=%s', u.user_type, u.user_tag, u.allow_byok)
  console.log('login_method     = %s   data_policy_agreed=%s', u.login_method, u.data_policy_agreed)
  console.log('access_token     = <len=%d fp=%s>', u.access_token.length, fp(u.access_token))
  console.log('refresh_token    = <len=%d fp=%s prefix=%j>', u.refresh_token.length, fp(u.refresh_token), u.refresh_token.slice(0, 4))
  console.log('expire_time      = %s  %s', new Date(u.expire_time).toISOString(), u.expire_time < Date.now() ? '(EXPIRED)' : '(valid)')
  console.log('refresh_expire   = %s', new Date(u.refresh_token_expire_time).toISOString())
  const { generated } = buildContext(api, cred)
  console.log('regenerated      = encrypt_user_info len=%d, key len=%d', generated.encrypt_user_info.length, generated.key.length)
  // integrity check: re-encrypting must reproduce the on-disk ciphertext byte for byte
  const again = api.credential_storage_encrypt(JSON.stringify(u), cred.key)
  console.log('round-trip       = re-encrypt(decrypt(disk)) === disk ? %s', again === cred.blob)
}

async function cmdRefresh({ writeBack }) {
  const api = loadWasm()
  const cred = readCredential(api)
  const res = await fetch('https://openapi.qoder.com.cn/api/v1/deviceToken/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer' },
    body: JSON.stringify({ refresh_token: cred.userInfo.refresh_token }),
  })
  const d = await res.json()
  console.log('http %d  device_token=<len=%d fp=%s>  expires_at=%s', res.status, d.device_token.length, fp(d.device_token), d.expires_at)
  const rotated = fp(d.refresh_token) !== fp(cred.userInfo.refresh_token)
  console.log('refresh_token rotated? %s', rotated)
  if (!writeBack) { console.log('(dry) not writing back — pass --write to persist'); return }
  const u = cred.userInfo
  u.access_token = d.device_token
  u.security_oauth_token = d.device_token
  u.refresh_token = d.refresh_token
  u.expire_time = Date.parse(d.expires_at)
  u.refresh_token_expire_time = Date.parse(d.refresh_token_expire_at ?? d.refresh_token_expires_at)
  const sealed = api.credential_storage_encrypt(JSON.stringify(u), cred.key)
  const check = JSON.parse(api.credential_storage_decrypt(sealed, cred.key))
  if (check.refresh_token !== d.refresh_token) throw new Error('verification failed — refusing to write')
  const bak = `${CRED_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(CRED_FILE, bak)
  const tmp = `${CRED_FILE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, sealed, { mode: 0o644 })
  fs.renameSync(tmp, CRED_FILE)
  console.log('wrote %s (backup: %s)', CRED_FILE, path.basename(bak))
}

async function cmdModels() {
  const api = loadWasm()
  const { ctx } = buildContext(api, readCredential(api))
  const r = ctx.prepareRequest(CENTER, '/api/v2/model/list?Encode=1', 'GET', 'auth', undefined, undefined)
  const res = await fetch(r.url, { method: 'GET', headers: Object.fromEntries(r.headers), signal: withTimeout(15000) })
  const text = await res.text()
  const plain = safeDecrypt(api, text)
  console.log('http %d (%d bytes)', res.status, plain.length)
  const cat = JSON.parse(plain)
  for (const [scene, arr] of Object.entries(cat)) {
    if (!Array.isArray(arr)) continue
    console.log('\n== scene=%s (%d) ==', scene, arr.length)
    for (const m of arr) {
      console.log('  %s %s format=%s source=%s enable=%s',
        pad(m.key, 15), pad(m.display_name, 20), pad(m.format, 7), pad(m.source, 7), m.enable)
    }
  }
}

async function cmdChat(model, prompt) {
  const api = loadWasm()
  const { ctx } = buildContext(api, readCredential(api))
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    request_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    task_id: crypto.randomUUID(),
  }
  const r = ctx.prepareInferRequest(CENTER, JSON.stringify(body), model, 'system')
  const res = await fetch(r.url, { method: 'POST', headers: Object.fromEntries(r.headers), body: r.body, signal: withTimeout(60000) })
  console.log('POST %s\nhttp %d %s\n', r.url, res.status, res.headers.get('content-type'))
  if (!res.ok) { console.log(await res.text()); return }

  let out = '', frames = 0, done = false
  await readSSE(api, res, (plain) => {
    frames++
    if (plain.includes('"[DONE]"') || plain === '[DONE]') return false
    let inner
    try { inner = unwrap(plain).inner } catch { return }
    if (!inner) return
    const c = inner.choices?.[0]
    const t = c?.delta?.content ?? c?.message?.content
    if (typeof t === 'string' && t) { out += t; process.stdout.write(t) }
    if (c?.finish_reason && c.finish_reason !== 'null') done = true
    if (inner.code && inner.message) console.log('\n[server] %s %s', inner.code, inner.message)
  })
  console.log('\n\n[frames=%d finish=%s]\n--- assembled ---\n%s', frames, done, out)
}

// --------------------------------------------------------------------- entry
const [cmd = 'auth', ...rest] = process.argv.slice(2)
const run = {
  auth: () => cmdAuth(),
  models: () => cmdModels(),
  chat: () => cmdChat(rest[0] ?? 'auto', rest.slice(1).join(' ') || 'Reply with exactly: PONG'),
  refresh: () => cmdRefresh({ writeBack: rest.includes('--write') }),
}[cmd]
if (!run) { console.error('usage: qoder-poc.mjs [auth|models|chat|refresh [--write]]'); process.exit(1) }
run().catch((e) => { console.error('[error]', e.message ?? e); process.exit(1) })
