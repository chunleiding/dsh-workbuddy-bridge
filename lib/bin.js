#!/usr/bin/env node
import { C as readHostHeartbeat$2, N as QoderCredentialStore, S as qoderHostHeartbeatPath, T as QoderUpstreamClient, _t as FALLBACK_LOOMY_MODELS, d as FALLBACK_WORKBUDDY_MODELS, h as WorkBuddyCredentialStore, i as workbuddyHostHeartbeatPath, j as FALLBACK_QODER_MODELS, lt as BRIDGE_VERSION, o as WorkBuddyUpstreamClient, ot as loomyHostHeartbeatPath, r as readHostHeartbeat, st as readHostHeartbeat$1, ut as isHeartbeatProcessAlive, yt as LoomySessionStore } from "./heartbeat-41__0YCQ.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/drivers/workbuddy/cli.ts
/**
* WorkBuddy driver descriptor for the shared status/diagnostics CLI.
*
* @module dsh-llm-bridge/drivers/workbuddy/cli
*/
function storeView(store) {
	return {
		status: () => store.status(),
		filePresent: () => store.desktopFilePresent(),
		filePath: () => store.desktopAuthPath(),
		ownPath: () => store.ownAuthPath(),
		logout: () => store.logout()
	};
}
/** The WorkBuddy CLI descriptor. */
const workbuddyCli = {
	id: "workbuddy",
	displayName: "WorkBuddy",
	fallbackModelCount: FALLBACK_WORKBUDDY_MODELS.length,
	credentialFileLabel: "Desktop auth file",
	signedOutHint: "Sign in once in the WorkBuddy desktop app, then run status again.",
	heartbeat: {
		path: workbuddyHostHeartbeatPath,
		read: async () => await readHostHeartbeat()
	},
	makeStore() {
		const client = new WorkBuddyUpstreamClient();
		const store = new WorkBuddyCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
		return {
			view: storeView(store),
			fetchCreditsTotal: async () => {
				const credential = await store.current();
				if (credential === void 0) throw new Error("signed out");
				return (await client.fetchCredits(credential)).total;
			}
		};
	}
};
//#endregion
//#region src/drivers/loomy/cli.ts
/**
* Loomy driver descriptor for the shared status/diagnostics CLI.
*
* @module dsh-llm-bridge/drivers/loomy/cli
*/
/** The Loomy CLI descriptor (no balance endpoint, so no quota fetch). */
const loomyCli = {
	id: "loomy",
	displayName: "Loomy",
	fallbackModelCount: FALLBACK_LOOMY_MODELS.length,
	credentialFileLabel: "Desktop session file",
	signedOutHint: "Sign in once in the Loomy desktop app, then run status again.",
	heartbeat: {
		path: loomyHostHeartbeatPath,
		read: async () => await readHostHeartbeat$1()
	},
	makeStore() {
		const store = new LoomySessionStore();
		return { view: {
			status: () => store.status(),
			filePresent: () => store.sessionFilePresent(),
			filePath: () => store.sessionFilePath(),
			ownPath: () => void 0,
			logout: () => store.logout()
		} };
	}
};
//#endregion
//#region src/drivers/qoder/cli.ts
/**
* Qoder driver descriptor for the shared status/diagnostics CLI.
*
* There is no plugin-owned credential file for this driver — the Qoder app's
* own auth directory is authoritative — so `ownPath()` reports undefined and
* `logout` has nothing of ours to remove.
*
* @module dsh-llm-bridge/drivers/qoder/cli
*/
/** The Qoder CLI descriptor. */
const qoderCli = {
	id: "qoder",
	displayName: "Qoder",
	fallbackModelCount: FALLBACK_QODER_MODELS.length,
	credentialFileLabel: "Desktop credential file",
	signedOutHint: "Sign in once in the Qoder app, then run status again.",
	heartbeat: {
		path: qoderHostHeartbeatPath,
		read: async () => await readHostHeartbeat$2()
	},
	makeStore() {
		const client = new QoderUpstreamClient();
		const store = new QoderCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
		return { view: {
			status: () => store.status(),
			filePresent: () => store.authDirPresent(),
			filePath: () => store.credentialPath(),
			ownPath: () => void 0,
			logout: () => store.logout()
		} };
	}
};
//#endregion
//#region src/bin.ts
/**
* Standalone status/diagnostics CLI for dsh-llm-bridge.
*
* Usage:
*   dsh-llm-bridge [workbuddy|loomy|qoder] <doctor|status|logout> [--json]
*
* With no driver argument, doctor/status report across every shipped driver;
* logout is destructive-adjacent and always requires an explicit driver.
*/
const JSON_SCHEMA_VERSION = 1;
const DRIVERS = [
	workbuddyCli,
	loomyCli,
	qoderCli
];
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\b[0-9a-f]{32}\b/gu, "[redacted session]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-llm-bridge [workbuddy|loomy|qoder] <doctor|status|logout> [--json]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  status   sign-in state, remaining quota, and host-bundle health",
		"  logout   remove plugin-owned credentials (desktop app sign-in is untouched)",
		"  --json   emit one secret-free JSON document (doctor/status only)",
		"",
		`Drivers: ${DRIVERS.map((driver) => driver.id).join(", ")}`,
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function doctorOne(driver) {
	const { view } = driver.makeStore();
	const status = await view.status();
	const filePresent = await view.filePresent();
	const heartbeat = await driver.heartbeat.read();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	return {
		report: {
			provider: driver.id,
			version: BRIDGE_VERSION,
			node: process.version,
			credentialFile: {
				path: view.filePath() ?? "(no platform default for this driver)",
				present: filePresent
			},
			...view.ownPath() === void 0 ? {} : { ownCredentialFile: view.ownPath() },
			hostHeartbeat: {
				path: driver.heartbeat.path(),
				present: heartbeat !== void 0,
				...heartbeat === void 0 ? {} : {
					registeredAt: heartbeat.registeredAt,
					pid: heartbeat.pid
				},
				processAlive: hostAlive
			},
			signIn: status.state,
			fallbackModels: driver.fallbackModelCount,
			hints: [
				...status.state === "signed-in" ? [] : [driver.signedOutHint],
				...filePresent ? [] : [`No ${driver.displayName} credential file at the expected path.`],
				...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited)."]
			]
		},
		exit: status.state === "signed-in" && filePresent ? 0 : 1
	};
}
async function statusOne(driver) {
	const made = driver.makeStore();
	const authStatus = await made.view.status();
	const heartbeat = await driver.heartbeat.read();
	const hostState = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat) ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	if (authStatus.state !== "signed-in") return {
		report: {
			provider: driver.id,
			version: BRIDGE_VERSION,
			status: "signed-out",
			hostBundle: hostState
		},
		exit: 1
	};
	const report = {
		provider: driver.id,
		version: BRIDGE_VERSION,
		status: "signed-in",
		...authStatus.expiresAtMs === void 0 ? {} : { accessTokenExpires: new Date(authStatus.expiresAtMs).toISOString() },
		...authStatus.updatedAtMs === void 0 ? {} : { sessionUpdatedAt: new Date(authStatus.updatedAtMs).toISOString() },
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		hostBundle: hostState
	};
	if (made.fetchCreditsTotal !== void 0) try {
		report["credits"] = await made.fetchCreditsTotal();
	} catch (error) {
		report["creditsError"] = safeMessage(error);
	}
	return {
		report,
		exit: 0
	};
}
function printDoctorText(driver, report) {
	const file = report["credentialFile"];
	const hb = report["hostHeartbeat"];
	process.stdout.write([
		`[${driver.id}] DSH LLM Bridge ${BRIDGE_VERSION} on ${process.version}`,
		`${driver.credentialFileLabel}: ${file.present ? "present" : "missing"} (${file.path})`,
		`Host bundle: ${hb.processAlive ? "running" + (hb.pid === void 0 ? "" : ` (pid ${String(hb.pid)})`) : hb.present ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${String(report["signIn"])}`,
		`Static fallback models: ${String(report["fallbackModels"])}`,
		...(report["hints"] ?? []).map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
}
function printStatusText(driver, report) {
	const lines = [`[${driver.id}] ${driver.displayName}: ${String(report["status"])}`];
	if (typeof report["nickname"] === "string") lines[0] += ` as ${report["nickname"]}`;
	if (typeof report["accessTokenExpires"] === "string") lines.push(`Access token expires ${report["accessTokenExpires"]} (refresh is automatic)`);
	if (typeof report["sessionUpdatedAt"] === "string") lines.push(`Session last updated ${report["sessionUpdatedAt"]}`);
	if (typeof report["credits"] === "number") lines.push(`Remaining credit: ${report["credits"]}`);
	if (typeof report["creditsError"] === "string") lines.push(`Remaining credit: unavailable (${report["creditsError"]})`);
	lines.push(`Host bundle: ${String(report["hostBundle"])}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}
/** Execute one boot-free command for one driver (or all when `driver` is undefined). */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	let selected;
	let rest = argv;
	const firstAsDriver = DRIVERS.find((driver) => driver.id === argv[0]);
	if (firstAsDriver !== void 0) {
		selected = firstAsDriver;
		rest = argv.slice(1);
	}
	const [rawAction, ...flags] = rest;
	if (rawAction === void 0 || ![
		"doctor",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-llm-bridge: expected doctor, logout, or status${selected === void 0 ? ` or a driver (${DRIVERS.map((d) => d.id).join("|")})` : ""}; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	if (flags.some((flag) => flag !== "--json") || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-llm-bridge: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	if (action === "logout" && selected === void 0) {
		process.stderr.write("dsh-llm-bridge: specify a driver for logout, e.g. `dsh-llm-bridge workbuddy logout`\n");
		return 1;
	}
	const targets = selected !== void 0 ? [selected] : DRIVERS;
	try {
		if (action === "logout") {
			const { view } = targets[0].makeStore();
			await view.logout();
			const own = view.ownPath();
			process.stdout.write(own === void 0 ? `dsh-llm-bridge (${targets[0].id}): no plugin-owned credential to remove; the desktop app's sign-in is untouched\n` : `dsh-llm-bridge (${targets[0].id}): removed ${own}; the desktop app's sign-in is untouched\n`);
			return 0;
		}
		const runOne = action === "doctor" ? doctorOne : statusOne;
		const results = await Promise.all(targets.map((driver) => runOne(driver)));
		let exit = 0;
		if (jsonOutput) {
			if (selected !== void 0) printJson({
				schemaVersion: JSON_SCHEMA_VERSION,
				package: "dsh-llm-bridge",
				...results[0].report
			});
			else printJson({
				schemaVersion: JSON_SCHEMA_VERSION,
				package: "dsh-llm-bridge",
				version: BRIDGE_VERSION,
				results: results.map((result) => result.report)
			});
		} else targets.forEach((driver, index) => {
			if (action === "doctor") printDoctorText(driver, results[index].report);
			else printStatusText(driver, results[index].report);
		});
		for (const result of results) if (result.exit !== 0) exit = 1;
		return exit;
	} catch (error) {
		process.stderr.write(`dsh-llm-bridge: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
