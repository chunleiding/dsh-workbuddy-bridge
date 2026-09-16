/**
 * Loomy provider metadata shared across the driver's adapter, shim,
 * upstream, and DSH plugin registration.
 *
 * @module dsh-llm-bridge/drivers/loomy/meta
 */

/** Provider route this driver owns. */
export const LOOMY_PROVIDER = 'loomy'

/** Human-facing provider name in the DSH model pickers. */
export const LOOMY_DISPLAY_NAME = 'Loomy'

/** Provider idle ceiling while one stream read is outstanding. */
export const LOOMY_STREAM_IDLE_TIMEOUT_MS = 300_000

/** The imodel provider's real OpenAI-compatible base URL. */
export const LOOMY_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'

/** Client version sent on the `loomy-version` header. */
export const LOOMY_CLIENT_VERSION = '0.9.37'

/** Basename of the Loomy desktop app's session file. */
export const LOOMY_SESSION_FILENAME = 'auth-session.json'

/** Env variable that overrides the session-file location. */
export const LOOMY_SESSION_FILE_ENV = 'LOOMY_SESSION_FILE'
