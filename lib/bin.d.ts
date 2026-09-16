//#region src/drivers/workbuddy/bin.d.ts
/** Standalone status/diagnostics CLI for the WorkBuddy driver bundle. */
/** Execute one boot-free command. */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };