/**
 * Qoder provider metadata shared across the driver's auth, upstream, adapter,
 * shim and plugin.
 *
 * Everything here is a Qoder-private fact: the provider route id, the two
 * hosts the app talks to, the on-disk auth directory layout, and the client
 * metadata string the wasm's signing context is seeded with.
 *
 * @module dsh-llm-bridge/drivers/qoder/meta
 */

/** Provider route this driver owns. */
export const QODER_PROVIDER = 'qoder'

/** Human-facing provider name in the DSH model pickers. */
export const QODER_DISPLAY_NAME = 'Qoder'

/** Provider idle ceiling while one stream read is outstanding. */
export const QODER_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * The COSY protocol version the wasm signs with. It is a field of the signed
 * payload, so it tracks the app release rather than this package: re-vendor
 * the wasm (`scripts/vendor-qoder-wasm.mjs`) and bump this together.
 */
export const QODER_COSY_VERSION = '1.1.26'

/** Host serving token refresh (`/api/v1/deviceToken/refresh`). */
export const QODER_OPENAPI_BASE = 'https://openapi.qoder.com.cn'

/**
 * Default host for node discovery and inference. The app resolves this
 * dynamically through `/algo/api/v4/service/region/endpoints`; the driver
 * tries that first and falls back to this constant, which is what the
 * endpoint currently answers with.
 */
export const QODER_GATEWAY_BASE = 'https://gateway.qoder.com.cn'

/** Scene the driver declares, and the catalogs it reads (`models[scene]`). */
export const QODER_SCENE = 'assistant'

/**
 * Client metadata the wasm signing context is seeded with.
 *
 * `client_type: 5` is the CLI surface. The scene has to match the catalog
 * scene the model keys were read from, and `agent_common` in the inference
 * path is the agent those keys are valid for.
 */
export const QODER_CLIENT_METADATA = {
  client_type: 5,
  business_product: 'cli',
  business_type: 'agent',
  scene: QODER_SCENE,
} as const

/** Agent id the inference endpoint is scoped to. */
export const QODER_AGENT_ID = 'agent_common'

/** Model key standing in for "let Qoder pick", valid for every scene. */
export const QODER_AUTO_MODEL = 'auto'

/** Directory under the user's home holding Qoder's client state. */
export const QODER_HOME_DIRNAME = '.qoderworkcn'

/**
 * Subdirectories that may hold the signed-in account, in probe order.
 *
 * The shipped CN build signs in under `.auth-cn` while the SDK's own path
 * constants say `.auth` — on a real install both exist, with *different*
 * machine ids, and only the `.auth-cn` pair decrypts the credential. A
 * candidate is therefore accepted only when it holds both files, so the
 * machine id and the credential are always taken from the same directory.
 */
export const QODER_AUTH_SUBDIRECTORIES = ['.auth-cn', '.auth'] as const

/** Env variable overriding the auth directory (used by tests and diagnostics). */
export const QODER_AUTH_DIR_ENV = 'QODER_AUTH_DIR'

/**
 * Filenames the machine id is stored under, in probe order. The SDK's own
 * path constant says `machine_id`, but the shipped CN build writes `id`; both
 * are probed so a layout change does not silently break credential decryption.
 */
export const QODER_MACHINE_ID_FILENAMES = ['id', 'machine_id'] as const

/** Filename of the sealed credential document. */
export const QODER_CREDENTIAL_FILENAME = 'user'
