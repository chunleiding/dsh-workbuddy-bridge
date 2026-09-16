#!/usr/bin/env node
/**
 * Re-vendor the Qoder driver's embedded WebAssembly assets.
 *
 * The Qoder driver drives Qoder's *own* `qoder_auth_wasm_bg.wasm` — request
 * signing, body sealing and server-payload decryption are all wasm exports,
 * and none of it is reimplemented here. Two artifacts are needed and both are
 * committed into `src/drivers/qoder/vendor/artifacts.ts` as base64 so the
 * driver is self-contained (no dependency on an installed Qoder app at
 * runtime, in tests, or in the published bundle):
 *
 *   1. the wasm module — `Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm`
 *   2. the wasm-bindgen glue — lifted from `Contents/Resources/app.asar`
 *
 * The glue needs no reverse engineering: the app ships an *unobfuscated* copy
 * of it inside its own `out/main/main.js` bundle, delimited by stable anchors.
 * Only the exports that are not part of that copy (the `QoderContext` /
 * `RequestResult` classes and the credential helpers) are ported separately,
 * by hand, in `src/drivers/qoder/wasm.ts`.
 *
 * Re-run this after a Qoder upgrade and commit the regenerated file:
 *
 *   node scripts/vendor-qoder-wasm.mjs [--app "/Applications/QoderWork CN.app"]
 *
 * The script fails loudly (non-zero exit) when an anchor is missing or when
 * the extracted module does not export what the driver calls, so a Qoder
 * release that reshapes its bundle cannot silently produce a broken driver.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(REPO, 'src/drivers/qoder/vendor/artifacts.ts')

/** Default install location; override with `--app <path>`. */
const DEFAULT_APP = '/Applications/QoderWork CN.app'

/**
 * Glue boundaries inside the app's `out/main/main.js`.
 *
 * `START` is the first glue function the app calls; `END` is the line that
 * immediately follows the wasm-bindgen initializer block, so the slice ends
 * exactly at the end of the generated glue.
 */
const GLUE_START = 'function decrypt_server_response('
const GLUE_END = 'let initialized$1=!1;'

/** Exports the driver calls; a rename upstream must break this script, not the driver. */
const REQUIRED_WASM_EXPORTS = [
  'credential_storage_decrypt',
  'credential_storage_encrypt',
  'decrypt_server_response',
  'generate_runtime_auth_fields',
  'qodercontext_new',
  'qodercontext_prepareInferRequest',
  'qodercontext_prepareRequest',
  'qodercontext_refreshAuthFields',
  'requestresult_body',
  'requestresult_headers',
  'requestresult_url',
]

/** Imports the ported wrappers call through the glue's local `wasm` binding. */
const REQUIRED_WASM_INTERNALS = [
  '__wbindgen_add_to_stack_pointer',
  '__wbindgen_export2',
  '__wbindgen_export3',
  '__wbindgen_export4',
]

function fail(message) {
  process.stderr.write(`vendor-qoder-wasm: ${message}\n`)
  process.exit(1)
}

function parseApp(argv) {
  const index = argv.indexOf('--app')
  if (index < 0) return DEFAULT_APP
  const value = argv[index + 1]
  if (value === undefined || value === '') fail('--app needs a path')
  return value
}

const app = parseApp(process.argv.slice(2))
const asar = path.join(app, 'Contents/Resources/app.asar')
const wasmPath = path.join(app, 'Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm')

if (!fs.existsSync(wasmPath)) fail(`wasm not found at ${wasmPath} (is Qoder installed?)`)
if (!fs.existsSync(asar)) fail(`app.asar not found at ${asar}`)

/** Slice the readable wasm-bindgen glue out of the packed app bundle. */
function extractGlue(asarPath) {
  const buffer = fs.readFileSync(asarPath)
  const start = buffer.indexOf(Buffer.from(GLUE_START))
  if (start < 0) fail(`glue start anchor ${JSON.stringify(GLUE_START)} missing from app.asar`)
  const end = buffer.indexOf(Buffer.from(GLUE_END), start)
  if (end < 0) fail(`glue end anchor ${JSON.stringify(GLUE_END)} missing from app.asar`)
  return buffer.subarray(start, end + GLUE_END.length).toString('utf8')
}

/** Assert the module really exports what the driver and the wrappers call. */
function assertExports(wasmBytes, glue) {
  const module = new WebAssembly.Module(wasmBytes)
  const exported = new Set(WebAssembly.Module.exports(module).map(entry => entry.name))
  const missing = REQUIRED_WASM_EXPORTS.filter(name => !exported.has(name))
  if (missing.length > 0) fail(`wasm is missing required exports: ${missing.join(', ')}`)
  const absentInternals = REQUIRED_WASM_INTERNALS.filter(name => !exported.has(name))
  if (absentInternals.length > 0) fail(`wasm is missing required internals: ${absentInternals.join(', ')}`)
  for (const symbol of ['__wbg_get_imports', 'initSync', 'getDataViewMemory0', 'getStringFromWasm0', 'takeObject', 'passStringToWasm0', 'isLikeNone', 'WASM_VECTOR_LEN']) {
    if (!glue.includes(symbol)) fail(`glue is missing ${symbol}`)
  }
  return { exportCount: exported.size, bytes: wasmBytes.byteLength, glueBytes: Buffer.byteLength(glue) }
}

const wasmBytes = fs.readFileSync(wasmPath)
const glue = extractGlue(asar)
const info = assertExports(wasmBytes, glue)

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with \`node scripts/vendor-qoder-wasm.mjs\` after a Qoder upgrade.
 *
 * Both payloads are base64 so the driver needs no filesystem, no installed
 * Qoder app, and no packaging step for binary assets: the wasm module and the
 * wasm-bindgen glue travel inside the published JavaScript bundle.
 *
 * Source: ${app}
 *   wasm: Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm (${info.bytes} bytes)
 *   glue: Contents/Resources/app.asar, anchors ${JSON.stringify(GLUE_START)} .. ${JSON.stringify(GLUE_END)} (${info.glueBytes} bytes)
 *
 * @module dsh-llm-bridge/drivers/qoder/vendor/artifacts
 */

/** Qoder's \`qoder_auth_wasm_bg.wasm\`, as shipped by the app. */
export const QODER_AUTH_WASM_BASE64 = '${wasmBytes.toString('base64')}'

/**
 * The wasm-bindgen glue for that module, taken verbatim from the app's
 * unobfuscated copy. It provides the memory helpers, the import table and
 * \`initSync\`; the driver adds the class wrappers on top.
 */
export const QODER_AUTH_GLUE_BASE64 = '${Buffer.from(glue, 'utf8').toString('base64')}'
`

fs.writeFileSync(OUT, header)
process.stdout.write(
  `vendor-qoder-wasm: wrote ${path.relative(REPO, OUT)}\n`
  + `  wasm ${info.bytes} bytes, ${info.exportCount} exports\n`
  + `  glue ${info.glueBytes} bytes\n`
  + `  base64 module ~${Math.round(Buffer.byteLength(header) / 1024)} KiB\n`,
)
