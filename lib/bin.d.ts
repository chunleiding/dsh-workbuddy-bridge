//#region src/bin.d.ts
/**
 * Standalone status/diagnostics CLI for dsh-llm-bridge.
 *
 * Usage:
 *   dsh-llm-bridge [workbuddy|loomy|qoder] <doctor|status|logout> [--json]
 *
 * With no driver argument, doctor/status report across every shipped driver;
 * logout is destructive-adjacent and always requires an explicit driver.
 */
/** Execute one boot-free command for one driver (or all when `driver` is undefined). */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };