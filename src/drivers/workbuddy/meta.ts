/**
 * WorkBuddy provider metadata shared across the driver's adapter, shim,
 * and DSH plugin registration.
 *
 * The provider id and settings namespace are durable contract values:
 * model selections, the `dsh` config file, and the TUI authFile setting all
 * key on the literal `workbuddy`, so they never change even though the
 * package itself is now `dsh-llm-bridge`.
 *
 * @module dsh-llm-bridge/drivers/workbuddy/meta
 */

/** Provider route this driver owns. */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/** Human-facing provider name in the DSH model pickers. */
export const WORKBUDDY_DISPLAY_NAME = 'WorkBuddy'

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000
