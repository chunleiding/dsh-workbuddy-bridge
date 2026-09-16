import { n as QODER_AUTH_WASM_BASE64, t as QODER_AUTH_GLUE_BASE64 } from "./qoder-wasm-assets-BwsejmIX.js";
import { copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
//#region src/drivers/loomy/meta.ts
/**
* Loomy provider metadata shared across the driver's adapter, shim,
* upstream, and DSH plugin registration.
*
* @module dsh-llm-bridge/drivers/loomy/meta
*/
/** Provider route this driver owns. */
const LOOMY_PROVIDER = "loomy";
/** Human-facing provider name in the DSH model pickers. */
const LOOMY_DISPLAY_NAME = "Loomy";
/** Provider idle ceiling while one stream read is outstanding. */
const LOOMY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** The imodel provider's real OpenAI-compatible base URL. */
const LOOMY_BASE_URL = "https://loomyad.xunfei.cn/api/v1";
/** Client version sent on the `loomy-version` header. */
const LOOMY_CLIENT_VERSION = "0.9.37";
/** Basename of the Loomy desktop app's session file. */
const LOOMY_SESSION_FILENAME = "auth-session.json";
/** Env variable that overrides the session-file location. */
const LOOMY_SESSION_FILE_ENV = "LOOMY_SESSION_FILE";
//#endregion
//#region src/drivers/loomy/auth.ts
/**
* Loomy session discovery. The Loomy desktop app stores a plaintext session
* string (32-hex) in `auth-session.json`; there is no refresh protocol and
* no owned copy — the file is re-read on every request so an account
* re-login in the desktop app is followed automatically.
*
* PII guard: the session file also carries `phone`, which this module never
* parses, keeps in memory, logs, or surfaces to the status card.
*
* @module dsh-llm-bridge/drivers/loomy/auth
*/
const SESSION_RELATIVE_PATH = ["loomy", LOOMY_SESSION_FILENAME];
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl$1() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl$1(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
/** Windows session-file candidates visible from a WSL process. */
function wslSessionCandidates(home) {
	const profile = windowsPathForWsl$1(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl$1(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl$1(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...SESSION_RELATIVE_PATH), join(roamingAppData, ...SESSION_RELATIVE_PATH)];
}
/**
* Platform-default candidates for the Loomy desktop app's session file, in
* probe order. Windows probes Local then Roaming AppData; WSL probes the
* mounted Windows profile first.
*/
function defaultSessionCandidates() {
	const home = homedir();
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...SESSION_RELATIVE_PATH)];
	if (process.platform === "win32") return [join(home, "AppData", "Local", ...SESSION_RELATIVE_PATH), join(home, "AppData", "Roaming", ...SESSION_RELATIVE_PATH)];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...SESSION_RELATIVE_PATH);
		return isWsl$1() ? [...wslSessionCandidates(home), linux] : [linux];
	}
	return [];
}
/** First platform-default candidate; see {@link defaultSessionCandidates}. */
function defaultSessionPath() {
	return defaultSessionCandidates()[0];
}
/** Normalize an epoch time that may arrive in seconds or milliseconds. */
function epochToMs(value) {
	if (typeof value !== "number" || value <= 0) return void 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
/**
* Parse a Loomy session document. Only `session` and `updatedAt` are read;
* `phone` and any other PII are deliberately ignored.
*/
function parseLoomySession(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	const session = typeof document["session"] === "string" ? document["session"].trim() : "";
	if (session === "") return void 0;
	const updatedAtMs = epochToMs(document["updatedAt"]);
	return {
		session,
		...updatedAtMs === void 0 ? {} : { updatedAtMs }
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT$2(error) {
	return error?.code === "ENOENT";
}
/**
* Read-only Loomy session store. The session is long-lived and refreshed by
* the desktop app itself, so this store only resolves the configured file —
* no refresh lifecycle, no plugin-owned copy, no writes.
*/
var LoomySessionStore = class {
	pathOverride;
	constructor(options) {
		this.pathOverride = options?.sessionFile;
	}
	/**
	* Configuration precedence for the session file: the plugin's configured
	* path, then the environment variable, then platform defaults.
	*/
	resolveCandidates() {
		const fromEnv = process.env[LOOMY_SESSION_FILE_ENV];
		const explicit = this.pathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return defaultSessionCandidates();
	}
	resolvePath() {
		return this.resolveCandidates()[0];
	}
	/** Repoint the session file; a settings change applies on the next read. */
	setSessionPath(path) {
		this.pathOverride = path;
	}
	/** The resolved session-file path, for diagnostics. */
	sessionFilePath() {
		return this.resolvePath();
	}
	/** Read and parse the first session-file candidate that exists. */
	async readSessionFile() {
		for (const sessionPath of this.resolveCandidates()) try {
			const parsed = parseLoomySession(await readFile(sessionPath, "utf8"));
			if (parsed !== void 0) return parsed;
		} catch (error) {
			if (!isENOENT$2(error)) throw error;
		}
	}
	/** The credential to put on the wire; re-reads the file on every call. */
	async resolve() {
		const session = await this.readSessionFile();
		if (session === void 0) {
			const candidates = this.resolveCandidates();
			const expected = candidates.length > 0 ? candidates.join(" or ") : "(no platform default on this platform)";
			throw new Error(`loomy: no signed-in Loomy session found; sign in once in the Loomy desktop app (expected ${expected} or ${LOOMY_SESSION_FILE_ENV})`);
		}
		return session;
	}
	/** Read-only sign-in summary; never throws. */
	async status() {
		try {
			const session = await this.readSessionFile();
			if (session === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				...session.updatedAtMs === void 0 ? {} : { updatedAtMs: session.updatedAtMs }
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	/** Loomy owns no plugin-side credential file, so logout is a no-op. */
	async logout() {}
	/** Whether any session-file candidate exists as a regular file; diagnostics only. */
	async sessionFilePresent() {
		for (const sessionPath of this.resolveCandidates()) try {
			if ((await stat(sessionPath)).isFile()) return true;
		} catch {}
		return false;
	}
};
//#endregion
//#region src/core/catalog.ts
/**
* Generic mutable model catalog: seeded by the driver with its static
* fallback list, replaced wholesale once the platform's dynamic answer
* loads. The core never interprets an entry — only drivers know a model
* record's shape; the shim and adapter constrain it to `{ id }`.
*
* @module dsh-llm-bridge/core/catalog
*/
/** A read-only list of model entries that can be replaced atomically. */
var Catalog = class {
	models;
	constructor(initial) {
		this.models = initial;
	}
	/** Current entries; the fallback list until an upstream answer lands. */
	current() {
		return this.models;
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = [...models];
	}
};
//#endregion
//#region src/drivers/loomy/catalog.ts
/**
* Loomy model catalog: a static fallback list captured from the live imodel
* endpoint, replaced by the dynamic answer once it loads.
*
* @module dsh-llm-bridge/drivers/loomy/catalog
*/
/**
* Static chat models observed on the imodel endpoint on 2026-09-16. The
* upstream refresh replaces this list at startup; it exists so the provider
* registers with a usable catalog even while the first fetch is in flight or
* offline.
*
* The two image-generation models (`doubao-seedream-5-lite`,
* `qwen-image-3.0-pro`, `type: "image"`) are intentionally absent — the
* chat-completions shim cannot serve them. Names are the platform's own
* display names (they already carry the rate/promo suffix, e.g.
* `Spark X2.5（限时免费）`), so no driver-side name decoration is applied.
*/
const FALLBACK_LOOMY_MODELS = [
	{
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731（x3.0）",
		contextWindow: 1048576,
		maxTokens: 384e3,
		supportsImages: false,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "MiniMax-M3",
		name: "MiniMax M3 （x4.0）",
		contextWindow: 1048576,
		maxTokens: 512e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "Kimi-k2.6",
		name: "Kimi k2.6 （x6.5）",
		contextWindow: 262144,
		maxTokens: 65536,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "qwen-3.8-max",
		name: "Qwen 3.8 Max (x12.0)",
		contextWindow: 1e6,
		maxTokens: 65536,
		supportsImages: false,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "GLM-5.3-Flash",
		name: "GLM 5.3 Flash(x0.8)",
		contextWindow: 1048576,
		maxTokens: 131072,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "qwen3.8-flash",
		name: "qwen 3.8 flash（x0.8）",
		contextWindow: 1e6,
		maxTokens: 131072,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "spark-x",
		name: "Spark X2.5（限时免费）",
		contextWindow: 1048576,
		maxTokens: 65536,
		supportsImages: false,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "doubao-seed-2.0-mini",
		name: "Doubao Seed 2.0 mini（x0.8）",
		contextWindow: 262144,
		maxTokens: 131072,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "mimo-v2.5",
		name: "MiMo V2.5（x3.3）",
		contextWindow: 1048576,
		maxTokens: 131072,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	},
	{
		id: "qwen3.5-flash",
		name: "Qwen3.5 Flash（x1.0）",
		contextWindow: 1e6,
		maxTokens: 65536,
		supportsImages: true,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"none",
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "low"
		}
	}
];
/** Mutable Loomy catalog seeded with the fallback roster. */
var LoomyCatalog = class extends Catalog {
	constructor() {
		super(FALLBACK_LOOMY_MODELS);
	}
};
//#endregion
//#region src/core/loopback.ts
/**
* Shared loopback gates for the bridge's local HTTP surfaces: the loopback
* shim and the same-origin status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* Platform-agnostic mechanism: no driver knowledge of any kind.
*
* @module dsh-llm-bridge/core/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/core/status-route.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback);
* the card's same-origin fetches carry no Origin and pass on Host alone.
*/
function trustedLoopback(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/**
* Build a standalone request handler for one status document. Extracted as
* a factory (rather than mounting directly) so tests can mount it on a bare
* HTTP server.
*/
function createStatusHandler(build) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!trustedLoopback(req)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json(res, 200, await build());
		} catch (error) {
			json(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerStatusRoute(ctx, path, build) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: createStatusHandler(build)
		});
		return () => {
			dispose();
		};
	}, "dsh-llm-bridge: Web status route");
}
//#endregion
//#region src/core/heartbeat.ts
/**
* Generic host-heartbeat mechanism: a small JSON file written under
* `$DSH_HOME` once a driver has registered its provider, so a boot-free
* status CLI can report whether the host bundle is alive independently of
* any browser card.
*
* The mechanism (write/read/clear, PID liveness, recycled-PID detection via
* process start time, format validation) is platform-agnostic; the driver
* supplies the identity — its own file name and package marker — so several
* drivers never collide on one file.
*
* The browser (client) bundle cannot write files; its health is reported
* only through `console.error` on failure. This asymmetry is intentional:
* the host is the load-bearing half, and a missing heartbeat unambiguously
* means the host never started.
*
* @module dsh-llm-bridge/core/heartbeat
*/
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Bind the heartbeat mechanism to one driver identity. */
function createHostHeartbeat(identity, pluginVersion) {
	const path = () => join(resolveDshHome(), identity.fileName);
	const document = () => ({
		version: HEARTBEAT_FORMAT_VERSION,
		package: identity.packageName,
		pluginVersion,
		registeredAt: Date.now(),
		pid: process.pid
	});
	const write = async () => {
		try {
			await writeFile(path(), JSON.stringify(document()), "utf8");
		} catch {}
	};
	const clear = async () => {
		try {
			await rm(path(), { force: true });
		} catch {}
	};
	const read = async () => {
		let raw;
		try {
			raw = await readFile(path(), "utf8");
		} catch {
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === identity.packageName && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
				version: HEARTBEAT_FORMAT_VERSION,
				package: identity.packageName,
				pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
				registeredAt: parsed.registeredAt,
				pid: parsed.pid
			};
		} catch {}
	};
	return {
		path,
		write,
		clear,
		read
	};
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process
* that registered it. A stale heartbeat (host crashed without clearing the
* file) is distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A
*    host that registered the heartbeat must have been started before
*    writing it, so `start <= registeredAt`; a recycled PID belongs to an
*    unrelated process started after the host died, so `start >
*    registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same
* PID to an unrelated process, and the un-cleared stale heartbeat would
* otherwise produce a false "Host running". When the process start time
* cannot be read (e.g. unsupported platform) the check degrades to plain
* PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
//#region src/core/version.ts
const BRIDGE_VERSION = "0.4.0";
//#endregion
//#region src/drivers/loomy/heartbeat.ts
/**
* Loomy driver heartbeat: binds the core heartbeat mechanism to the
* driver's file name so it never collides with another driver's file.
*
* @module dsh-llm-bridge/drivers/loomy/heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const LOOMY_HOST_HEARTBEAT_FILENAME = ".loomy-host-heartbeat.json";
const heartbeat$2 = createHostHeartbeat({
	fileName: LOOMY_HOST_HEARTBEAT_FILENAME,
	packageName: "dsh-llm-bridge"
}, BRIDGE_VERSION);
/** Absolute path of the host heartbeat file. */
const loomyHostHeartbeatPath = heartbeat$2.path;
/** Write (or overwrite) the heartbeat after the host registered the provider. */
const writeHostHeartbeat$2 = heartbeat$2.write;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
const clearHostHeartbeat$2 = heartbeat$2.clear;
/** Read and validate the heartbeat; `undefined` when absent or malformed. */
const readHostHeartbeat$2 = heartbeat$2.read;
//#endregion
//#region src/core/credential.ts
/**
* Demand-driven, single-flight credential refresh over an arbitrary storage
* backend. One instance per credential source.
*/
var CredentialRefresher = class {
	refresh;
	refreshMarginMs;
	inflight;
	constructor(options) {
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
	}
	/** Whether the credential is inside the refresh margin (or already expired). */
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	/**
	* Return the credential to put on the wire: the given one unchanged while
	* it is fresh, otherwise a refreshed one. Single-flight, so parallel
	* callers share one in-flight refresh; the driver owns the signed-out
	* case (it decides how a missing credential is discovered and reported).
	*/
	async refreshIfNeeded(credential) {
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/**
	* A failed refresh still returns a credential valid for at least another
	* 30 seconds, so an unreachable refresh endpoint does not take down a
	* working session. Once the credential is effectively expired the
	* driver's own error is rethrown verbatim — diagnostics wording belongs to
	* the platform, never to the core.
	*/
	async refreshNow(credential) {
		try {
			return await this.refresh(credential);
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw error;
		}
	}
};
//#endregion
//#region src/drivers/qoder/credential.ts
/**
* Qoder's credential shape, its on-disk document, and the pure derivations
* between them.
*
* The interesting facts, all established by reversing the app (see
* `docs/qoder-driver-research.md`):
*
* - The credential document is **sealed** with a 16-character key that is
*   *not* stored anywhere: `key = machine_id.trim().slice(0, 16)`. The machine
*   id sits next to the credential and is itself a plain-text UUID, so the key
*   is ASCII, not binary — the detail that kept an earlier attempt stuck.
* - `encrypt_user_info` and `key` look like credential fields but are **empty
*   on disk**. They are regenerated at every launch by the wasm from the
*   account identity (`uid` + organization + data-policy) and must be present
*   on every authenticated request; omitting them is a `403 Signature invalid`
*   with no other symptom.
* - `expire_time` is epoch **milliseconds**, not seconds.
* - The refresh token **rotates** on every refresh, so a refreshed credential
*   has to be written back or the user's app is left holding a dead token.
*
* Nothing here performs I/O: the file layout lives in `auth.ts`, the wasm
* calls in `wasm.ts`. Keeping the derivations pure is what lets them be tested
* without a Qoder install.
*
* @module dsh-llm-bridge/drivers/qoder/credential
*/
/** Length of the credential key; AES-128, so 16 bytes' worth of ASCII. */
const QODER_CREDENTIAL_KEY_LENGTH = 16;
/**
* Derive the credential sealing key from the machine id.
*
* `machine_id` is a 36-character UUID; the key is its first 16 characters,
* verbatim. The SDK also computes `sha256(machine_id)` at one point, which is
* a *liveness fingerprint* for a different guard — it is not part of the key
* derivation, and treating it as one is what made this look unreachable.
*/
function qoderCredentialKey(machineId) {
	return machineId.trim().slice(0, 16);
}
/** Whether a machine id can produce a usable key. */
function isUsableMachineId(machineId) {
	return machineId.trim().length >= 16;
}
/** Coerce the app's `organization_tags` into the array the wasm demands. */
function normalizeOrganizationTags(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((tag) => typeof tag === "string");
}
/**
* Resolve an epoch-millisecond timestamp from either spelling the app uses:
* a number (seconds or milliseconds) or an ISO-8601 string.
*/
function epochMsOf(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 0xe8d4a51000 ? value : value * 1e3;
	if (typeof value === "string" && value !== "") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
}
function optionalString$1(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** Project the app's document plus the machine id into a credential. */
function credentialFromUserInfo(userInfo, machineId) {
	const organizationId = optionalString$1(userInfo["organization_id"]) ?? "";
	const refreshExpiresAtMs = epochMsOf(userInfo["refresh_token_expire_time"]);
	const displayName = optionalString$1(userInfo["name"]);
	const userType = optionalString$1(userInfo["user_type"]);
	const userTag = optionalString$1(userInfo["user_tag"]);
	return {
		accessToken: optionalString$1(userInfo["access_token"]) ?? "",
		refreshToken: optionalString$1(userInfo["refresh_token"]) ?? "",
		expiresAtMs: epochMsOf(userInfo["expire_time"]) ?? 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		machineId,
		uid: optionalString$1(userInfo["uid"]) ?? "",
		...displayName === void 0 ? {} : { displayName },
		...userType === void 0 ? {} : { userType },
		...userTag === void 0 ? {} : { userTag },
		organizationId,
		organizationTags: normalizeOrganizationTags(userInfo["organization_tags"]),
		dataPolicyAgreed: userInfo["data_policy_agreed"] === true,
		rawUserInfo: userInfo
	};
}
/**
* Normalize a `POST /api/v1/deviceToken/refresh` answer.
*
* The endpoint's field names have moved around between builds, so both the
* `refresh_token_expires_at` and `refresh_token_expire_at` spellings are
* accepted. A missing new refresh token is not an error worth inventing a
* value for: the driver keeps the old one only when the server omits the
* field, because a silently blanked token would sign the user out.
*/
function parseQoderRefreshResponse(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("qoder: token refresh returned an unexpected document");
	const document = payload;
	const deviceToken = optionalString$1(document["device_token"]);
	if (deviceToken === void 0) throw new Error("qoder: token refresh returned no device_token; sign in again in the Qoder app");
	const refreshToken = optionalString$1(document["refresh_token"]);
	if (refreshToken === void 0) throw new Error("qoder: token refresh returned no refresh_token; sign in again in the Qoder app");
	const expiresAtMs = epochMsOf(document["expires_at"]);
	if (expiresAtMs === void 0) throw new Error("qoder: token refresh returned no usable expires_at");
	const refreshExpiresAtMs = epochMsOf(document["refresh_token_expires_at"] ?? document["refresh_token_expire_at"] ?? document["refresh_token_expire_time"]);
	return {
		deviceToken,
		refreshToken,
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs }
	};
}
/**
* Fold a refresh answer into the app's document.
*
* Every other field — including ones this driver does not understand — is
* preserved, because the result is re-sealed and written back to the file the
* app reads. `access_token` and `security_oauth_token` are two views of the
* same device token and must move together; leaving one behind produced a 403
* in testing.
*/
function mergeRefreshOutcome(userInfo, outcome) {
	return {
		...userInfo,
		access_token: outcome.deviceToken,
		security_oauth_token: outcome.deviceToken,
		refresh_token: outcome.refreshToken,
		expire_time: outcome.expiresAtMs,
		...outcome.refreshExpiresAtMs === void 0 ? {} : { refresh_token_expire_time: outcome.refreshExpiresAtMs }
	};
}
/**
* The input `generate_runtime_auth_fields` is seeded with: account identity
* plus data-policy consent, and nothing else.
*/
function runtimeAuthFieldsInput(credential) {
	return JSON.stringify({
		uid: credential.uid,
		organization_id: credential.organizationId,
		organization_tags: [...credential.organizationTags],
		data_policy_agreed: credential.dataPolicyAgreed
	});
}
/**
* The `userInfo` JSON the signing context is constructed with.
*
* The two derived fields are the load-bearing part: `encrypt_user_info` and
* `key` are empty in the stored document, so the caller must pass what
* `generate_runtime_auth_fields` produced. This is exactly the SDK's
* `regenerateRuntimeFields()` + `getUserInfoForAuth()` pair.
*/
function signingUserInfo(credential, generated) {
	return JSON.stringify({
		uid: credential.uid,
		encrypt_user_info: generated.encrypt_user_info,
		key: generated.key,
		organization_id: credential.organizationId,
		organization_tags: [...credential.organizationTags],
		data_policy_agreed: credential.dataPolicyAgreed
	});
}
//#endregion
//#region src/drivers/qoder/meta.ts
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
const QODER_PROVIDER = "qoder";
/** Human-facing provider name in the DSH model pickers. */
const QODER_DISPLAY_NAME = "Qoder";
/** Provider idle ceiling while one stream read is outstanding. */
const QODER_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* The COSY protocol version the wasm signs with. It is a field of the signed
* payload, so it tracks the app release rather than this package: re-vendor
* the wasm (`scripts/vendor-qoder-wasm.mjs`) and bump this together.
*/
const QODER_COSY_VERSION = "1.1.26";
/** Host serving token refresh (`/api/v1/deviceToken/refresh`). */
const QODER_OPENAPI_BASE = "https://openapi.qoder.com.cn";
/**
* Default host for node discovery and inference. The app resolves this
* dynamically through `/algo/api/v4/service/region/endpoints`; the driver
* tries that first and falls back to this constant, which is what the
* endpoint currently answers with.
*/
const QODER_GATEWAY_BASE = "https://gateway.qoder.com.cn";
/** Scene the driver declares, and the catalogs it reads (`models[scene]`). */
const QODER_SCENE = "assistant";
/**
* Client metadata the wasm signing context is seeded with.
*
* `client_type: 5` is the CLI surface. The scene has to match the catalog
* scene the model keys were read from, and `agent_common` in the inference
* path is the agent those keys are valid for.
*/
const QODER_CLIENT_METADATA = {
	client_type: 5,
	business_product: "cli",
	business_type: "agent",
	scene: QODER_SCENE
};
/** Agent id the inference endpoint is scoped to. */
const QODER_AGENT_ID = "agent_common";
/** Model key standing in for "let Qoder pick", valid for every scene. */
const QODER_AUTO_MODEL = "auto";
/** Directory under the user's home holding Qoder's client state. */
const QODER_HOME_DIRNAME = ".qoderworkcn";
/**
* Subdirectories that may hold the signed-in account, in probe order.
*
* The shipped CN build signs in under `.auth-cn` while the SDK's own path
* constants say `.auth` — on a real install both exist, with *different*
* machine ids, and only the `.auth-cn` pair decrypts the credential. A
* candidate is therefore accepted only when it holds both files, so the
* machine id and the credential are always taken from the same directory.
*/
const QODER_AUTH_SUBDIRECTORIES = [".auth-cn", ".auth"];
/** Env variable overriding the auth directory (used by tests and diagnostics). */
const QODER_AUTH_DIR_ENV = "QODER_AUTH_DIR";
/**
* Filenames the machine id is stored under, in probe order. The SDK's own
* path constant says `machine_id`, but the shipped CN build writes `id`; both
* are probed so a layout change does not silently break credential decryption.
*/
const QODER_MACHINE_ID_FILENAMES = ["id", "machine_id"];
/** Filename of the sealed credential document. */
const QODER_CREDENTIAL_FILENAME = "user";
//#endregion
//#region src/drivers/qoder/wasm.ts
/**
* Qoder's own WebAssembly module, driven from plain Node.
*
* Qoder signs its requests with a wasm export rather than a documented
* algorithm: `QoderContext.prepareInferRequest` builds the signed URL, the
* full COSY header set, and a *sealed* request body, and
* `decrypt_server_response` opens the payloads it gets back. None of that is
* reimplemented here — the module is embedded verbatim (see
* `vendor/artifacts.ts`, regenerated by `scripts/vendor-qoder-wasm.mjs`) and
* invoked through the same wrappers the app itself uses.
*
* Two pieces come together to make the module callable:
*
* 1. **The wasm-bindgen glue**, taken verbatim from the app. The app ships an
*    *unobfuscated* copy of it inside its own `out/main/main.js` bundle, so it
*    needs no reverse engineering. It provides the linear-memory helpers, the
*    JS import table, and `initSync`.
* 2. **The wrappers** for the exports the glue's copy does not include —
*    `QoderContext`, `RequestResult`, the credential helpers and
*    `generate_runtime_auth_fields`. These are lifted from the app's
*    *obfuscated* worker bundle and are kept byte-for-byte in spirit: the
*    short identifier names, the stack-pointer dance and the
*    `takeObject`/`getStringFromWasm0` protocol are exactly the SDK's, so a
*    future Qoder release can be diffed against them.
*
* Glue and wrappers are concatenated into one function scope because the glue
* keeps the instantiated exports in a module-local `wasm` binding that the
* wrappers close over. `initSync` populates it, which is why the assembly is
* built once and cached.
*
* @module dsh-llm-bridge/drivers/qoder/wasm
*/
/**
* Wrappers for the exports missing from the app's readable glue copy.
*
* Provenance: `@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`
* (the app's own worker bundle). Names, integer offsets and the
* `WASM_VECTOR_LEN` protocol are preserved deliberately — this block is a
* transcript of the SDK, not an independent implementation, so that a future
* wasm upgrade can be diffed against it.
*/
const WRAPPERS = `
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
  _s(fn){let a=0,b=0;try{const r=wasm.__wbindgen_add_to_stack_pointer(-16);fn(r,this.__wbg_ptr);
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
}`;
const NOOP_LOGGER = {
	info() {},
	warn() {},
	error() {},
	debug() {},
	trace() {}
};
/** Assembly cache: the module is instantiated once per process. */
let cached;
/**
* Instantiate the embedded module and return the callable surface.
*
* The instantiation is single-shot per process: the glue keeps its exports in
* one local binding and `initSync` short-circuits on a second call, so caching
* the assembled API also keeps the wrapper closures pointed at the live
* instance.
*
* @param logger - receives the glue's own `WASM` category output. Defaults to
*   a no-op sink; pass the plugin logger to surface load failures and traps.
*/
function loadQoderWasm(logger = NOOP_LOGGER) {
	if (cached !== void 0) return cached;
	const glue = Buffer.from(QODER_AUTH_GLUE_BASE64, "base64").toString("utf8");
	const bytes = Buffer.from(QODER_AUTH_WASM_BASE64, "base64");
	const assemble = new Function("createCategoryLogger", `${glue}${WRAPPERS}
return { initSync, credential_storage_decrypt, credential_storage_encrypt,
  decrypt_server_response, generate_runtime_auth_fields, QoderContext };`);
	const makeLogger = (category) => ({
		info: (...args) => logger.info(`[qoder-wasm:${category}]`, ...args),
		warn: (...args) => logger.warn(`[qoder-wasm:${category}]`, ...args),
		error: (...args) => logger.error(`[qoder-wasm:${category}]`, ...args),
		debug: (...args) => logger.debug(`[qoder-wasm:${category}]`, ...args),
		trace: (...args) => logger.trace(`[qoder-wasm:${category}]`, ...args)
	});
	const scope = assemble(makeLogger);
	cached = {
		exports: scope.initSync({ module: bytes }),
		credential_storage_decrypt: (blob, key) => scope.credential_storage_decrypt(blob, key),
		credential_storage_encrypt: (plaintext, key) => scope.credential_storage_encrypt(plaintext, key),
		decrypt_server_response: (payload) => scope.decrypt_server_response(payload),
		generate_runtime_auth_fields: (input) => scope.generate_runtime_auth_fields(input),
		createContext: (machineId, cosyVersion, userInfoJson, clientMetadataJson) => new scope.QoderContext(machineId, cosyVersion, userInfoJson, clientMetadataJson)
	};
	return cached;
}
/**
* Open a server payload, falling back to the raw text.
*
* Qoder seals *most* responses but not all: the inference SSE frames arrive as
* plain JSON while `region/endpoints` and `model/list` are sealed. The app's
* own SDK wraps every read in exactly this try/catch, and a driver that skips
* the fallback turns a readable stream into silence.
*/
function openServerPayload(api, payload) {
	try {
		return api.decrypt_server_response(payload);
	} catch {
		return payload;
	}
}
//#endregion
//#region src/drivers/qoder/auth.ts
/**
* Qoder credential discovery, rotation, and write-back.
*
* Unlike the WorkBuddy and Loomy drivers, this one owns **no** credential copy
* of its own. Qoder's refresh token rotates on every use, which means the
* app's own file is not a read-only source of truth that can be left alone:
* after a refresh, only the rotated token works, and a bridge that kept the
* new one to itself would leave the user's Qoder app holding a dead token the
* next time it starts. So the file the app reads *is* the store, and a
* rotation is re-sealed and written back to it.
*
* That write is deliberately conservative:
*
* 1. the freshly sealed document is decrypted again and compared before
*    anything touches the disk, so an encryption mistake can never destroy a
*    working credential;
* 2. the current file is copied to a timestamped `.bak-…` sibling first;
* 3. the write itself is a `write temp + rename`, so a crash mid-write cannot
*    leave a half-written credential;
* 4. if the file changed since this rotation started (the app refreshed
*    concurrently), the write is abandoned and the file's newer credential
*    wins, rather than clobbering a fresher token with an older one.
*
* The refresh lifecycle (expiry margin, single-flight, keep-serving-on-failure)
* is the core's {@link CredentialRefresher}; what is Qoder-specific is where
* the credential lives, how it is sealed, and the rotation merge.
*
* @module dsh-llm-bridge/drivers/qoder/auth
*/
/** Whether a filesystem error reports an absent path. */
function isENOENT$1(error) {
	return error?.code === "ENOENT";
}
/**
* Platform-default auth directories, in probe order, as
* `<home>/.qoderworkcn/<sub>` for each candidate subdirectory.
*/
function defaultAuthDirectoryCandidates() {
	const home = homedir();
	return QODER_AUTH_SUBDIRECTORIES.map((subdirectory) => join(home, QODER_HOME_DIRNAME, subdirectory));
}
/**
* Read-only credential store with demand-driven refresh and rotation
* write-back.
*
* The credential itself is never cached: each read decrypts the current file,
* so a rotation performed by the Qoder app itself is picked up immediately.
*/
var QoderCredentialStore = class {
	refresh;
	refresher;
	writeBack;
	injectedApi;
	authDirOverride;
	/** Last directory that yielded a credential; the write-back target. */
	lastLocation;
	/** Raw credential file text at the moment it was decrypted, for the
	*  optimistic concurrency check before a write-back. */
	lastBlob;
	constructor(options) {
		this.refresh = options.refresh;
		this.writeBack = options.writeBack ?? true;
		this.injectedApi = options.api;
		this.authDirOverride = options.authDir;
		this.refresher = new CredentialRefresher({
			refresh: (credential) => this.refreshCredential(credential),
			...options.refreshMarginMs === void 0 ? {} : { refreshMarginMs: options.refreshMarginMs }
		});
	}
	/** The wasm module, loaded on first use. */
	api() {
		return this.injectedApi ?? loadQoderWasm();
	}
	/**
	* Auth directories to probe. Precedence: an explicit directory (plugin
	* configuration), then the environment variable, then the platform defaults.
	* An explicit value is used verbatim; the defaults are a probe order.
	*/
	candidates() {
		const fromEnv = process.env[QODER_AUTH_DIR_ENV];
		const explicit = this.authDirOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		const directories = explicit !== void 0 ? [explicit] : defaultAuthDirectoryCandidates();
		const locations = [];
		for (const directory of directories) for (const machineIdName of QODER_MACHINE_ID_FILENAMES) locations.push({
			directory,
			machineIdPath: join(directory, machineIdName),
			credentialPath: join(directory, QODER_CREDENTIAL_FILENAME)
		});
		return locations;
	}
	/** Repoint the auth directory; a settings change applies on the next read. */
	setAuthDir(directory) {
		this.authDirOverride = directory;
	}
	/** The directory probed first, for diagnostics. */
	authDirPath() {
		return this.candidates()[0]?.directory;
	}
	/** The credential file probed first, for diagnostics. */
	credentialPath() {
		return this.candidates()[0]?.credentialPath;
	}
	/** Whether any candidate holds both halves of the credential. */
	async authDirPresent() {
		for (const location of this.candidates()) try {
			await Promise.all([stat(location.credentialPath), stat(location.machineIdPath)]);
			return true;
		} catch {}
		return false;
	}
	/**
	* Read the stored credential without refreshing anything.
	*
	* A candidate must hold both the machine id and the credential; a half
	* present directory is skipped rather than paired with a machine id from a
	* different directory, which would silently fail to decrypt.
	*/
	async current() {
		for (const location of this.candidates()) {
			let machineId;
			let blob;
			try {
				machineId = (await readFile(location.machineIdPath, "utf8")).trim();
				blob = (await readFile(location.credentialPath, "utf8")).trim();
			} catch (error) {
				if (isENOENT$1(error)) continue;
				throw error;
			}
			if (!isUsableMachineId(machineId) || blob === "") continue;
			const plaintext = this.api().credential_storage_decrypt(blob, qoderCredentialKey(machineId));
			const userInfo = JSON.parse(plaintext);
			this.lastLocation = location;
			this.lastBlob = blob;
			return credentialFromUserInfo(userInfo, machineId);
		}
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const candidates = this.candidates().map((location) => location.credentialPath).join(" or ");
			throw new Error(`qoder: no signed-in Qoder account found; sign in once in the Qoder app (expected ${candidates} with a machine id beside it, or ${QODER_AUTH_DIR_ENV}), or refresh an existing session`);
		}
		return this.refresher.refreshIfNeeded(credential);
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.displayName === void 0 ? {} : { nickname: credential.displayName },
				...credential.userTag === void 0 ? {} : { userTag: credential.userTag }
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	/**
	* No-op: this driver owns no credential copy.
	*
	* The credential lives in the Qoder app's own file, and the driver must keep
	* writing rotations back to it, so there is nothing separable to remove. A
	* user who wants the bridge to stop using their account signs out in Qoder.
	*/
	async logout() {}
	/**
	* Perform the Qoder refresh, then re-seal the result into the app's file.
	*
	* The no-refresh-token short-circuit and the error wording are what the
	* pre-refactor shape produced; the core refresher wraps this with the
	* still-valid fallback.
	*/
	async refreshCredential(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("qoder: the device token expired and no refresh token is stored; sign in again in the Qoder app");
		}
		try {
			const outcome = await this.refresh(credential);
			const nextUserInfo = mergeRefreshOutcome(credential.rawUserInfo, outcome);
			const refreshed = credentialFromUserInfo(nextUserInfo, credential.machineId);
			if ((await this.writeBackCredential(nextUserInfo, credential)).kind === "superseded") return await this.current() ?? refreshed;
			return refreshed;
		} catch (error) {
			throw new Error(`qoder: token refresh failed and the device token is expired (${String(error)}); open the Qoder app once to sign in again`);
		}
	}
	/**
	* Re-seal `userInfo` and replace the app's credential file with it.
	*
	* Verification happens *before* the backup and the write: the sealed text is
	* decrypted and checked, so a sealing mistake aborts with the original file
	* still intact.
	*/
	async writeBackCredential(userInfo, credential) {
		const location = this.lastLocation;
		const baseline = this.lastBlob;
		if (!this.writeBack || location === void 0 || baseline === void 0) return { kind: "skipped-disabled" };
		const api = this.api();
		const key = qoderCredentialKey(credential.machineId);
		const sealed = api.credential_storage_encrypt(JSON.stringify(userInfo), key);
		if ((await readFile(location.credentialPath, "utf8")).trim() !== baseline) return { kind: "superseded" };
		if (JSON.parse(api.credential_storage_decrypt(sealed, key))["refresh_token"] !== userInfo["refresh_token"]) throw new Error("qoder: refusing to write back a credential that does not round-trip");
		const backupPath = `${location.credentialPath}.bak-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/gu, "-")}`;
		await copyFile(location.credentialPath, backupPath);
		const temporaryPath = `${location.credentialPath}.tmp-${process.pid}`;
		const mode = await stat(location.credentialPath).then((info) => info.mode & 511).catch(() => 384);
		try {
			await writeFile(temporaryPath, sealed, { mode });
			await rename(temporaryPath, location.credentialPath);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
		this.lastBlob = sealed;
		return {
			kind: "written",
			path: location.credentialPath,
			backupPath
		};
	}
};
//#endregion
//#region src/drivers/qoder/catalog.ts
/**
* Qoder model catalog: a static fallback roster captured from the live
* endpoint, replaced by the upstream's dynamic answer once it loads.
*
* The roster and every field on it are Qoder-private facts; only the mutable
* container comes from the core.
*
* @module dsh-llm-bridge/drivers/qoder/catalog
*/
/**
* The `chat` roster as observed on 2026-09-16 (14 models, all
* `format: openai`, `source: system`). The upstream refresh replaces this list
* at startup; it exists so the provider registers with a usable catalog even
* while the first fetch is in flight or offline.
*
* Every field is transcribed from the live catalog rather than guessed:
* `contextWindow` is the default tier of `context_config`,
* `supportedEfforts`/`defaultEffort`/`canDisableThinking` come from
* `thinking_config`, and `credits` is `price_factor` in display form.
*
* `maxTokens` is the one field the catalog does not declare, so it carries the
* driver's shared default (@see DEFAULT_MAX_OUTPUT_TOKENS). Models whose rows
* declare no effort ladder (`supportedEfforts` absent) are reasoning models
* whose selectable set is client-side knowledge the catalog does not carry;
* they get no thinking control, matching the WorkBuddy driver's handling of the
* same situation.
*/
const FALLBACK_QODER_MODELS = [
	{
		id: "auto",
		name: "Auto",
		contextWindow: 18e4,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: false
		},
		billing: {
			credits: "x0.5",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "qmodel_38max",
		name: "Qwen3.8-Max",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: [
				"low",
				"medium",
				"xhigh"
			],
			defaultEffort: "medium"
		},
		billing: {
			credits: "x0.5",
			badges: ["错峰 4 折"],
			free: true
		},
		source: "system",
		enabled: true,
		isDefault: true
	},
	{
		id: "qfmodel",
		name: "Qwen3.8-Flash",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: [
				"low",
				"medium",
				"xhigh"
			],
			defaultEffort: "xhigh"
		},
		billing: {
			credits: "x0.1",
			badges: ["错峰 4 折"],
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "qmodel_latest",
		name: "Qwen3.7-Max",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: true
		},
		billing: {
			credits: "x0.5",
			badges: ["错峰2折"],
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "qmodel",
		name: "Qwen3.7-Plus",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: true
		},
		billing: {
			credits: "x0.1",
			badges: ["错峰4折"],
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "q37fmodel",
		name: "Qwen3.7-Flash",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: false
		},
		billing: {
			credits: "x0.1",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "dmodel",
		name: "DeepSeek-V4-Pro",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: ["high", "max"],
			defaultEffort: "max"
		},
		billing: {
			credits: "x0.8",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "dfmodel",
		name: "DeepSeek-Flash",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			canDisableThinking: false
		},
		billing: {
			credits: "x0.2",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "gmodel",
		name: "GLM-5.3",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: false,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "max"
		},
		billing: {
			credits: "x0.6",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "gfmodel",
		name: "GLM-5.3-Flash",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: false,
			supportedEfforts: ["high", "max"],
			defaultEffort: "max"
		},
		billing: {
			credits: "x0.1",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "gm51model",
		name: "GLM-5.2",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: true,
			supportedEfforts: ["high", "max"],
			defaultEffort: "max"
		},
		billing: {
			credits: "x0.6",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "kmodel_latest",
		name: "Kimi-K3",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			canDisableThinking: false
		},
		billing: {
			credits: "x0.8",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "kmodel",
		name: "Kimi-K2.8-Preview",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			canDisableThinking: false,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "max"
		},
		billing: {
			credits: "x0.3",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	},
	{
		id: "mmodel",
		name: "MiniMax-M2.7",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: false,
		reasoning: {
			supports: false,
			canDisableThinking: false
		},
		billing: {
			credits: "x0.2",
			free: false
		},
		source: "system",
		enabled: false,
		isDefault: false
	}
];
/**
* Mutable Qoder catalog seeded with the fallback roster; shared by the shim's
* `/v1/models` and the adapter.
*/
var QoderCatalog = class extends Catalog {
	constructor() {
		super(FALLBACK_QODER_MODELS);
	}
};
//#endregion
//#region src/drivers/qoder/upstream.ts
/**
* Qoder upstream client: node discovery, signed inference, stream translation,
* token refresh, and the model catalog.
*
* Everything in this file is Qoder-private: the two hosts, the COSY header
* dialect, the sealed request body, the SSE envelope, the model row shape, and
* the Chinese/English error markers.
*
* The shape of the traffic, all verified against the live endpoint:
*
* - **Request**: the wasm's `prepareInferRequest` returns an absolute URL (it
*   appends `Encode=1` itself), the full COSY header set, and a *sealed* body.
*   The model rides the `X-Model-Key` header; a `model` field in the body is
*   echoed back decoratively and selects nothing.
* - **Response**: `text/event-stream`, but not ordinary SSE. Each event's data
*   is an *envelope* — `{headers, body: "<json string>", statusCodeValue,
*   statusCode}` — and the OpenAI chunk lives inside the `body` string. The
*   stream ends with an envelope whose `body` is the literal `"[DONE]"`,
*   followed by an `event: finish` event carrying timings.
* - Frames are **plain JSON**, not sealed, while `region/endpoints` and
*   `model/list` *are* sealed. Every read therefore goes through
*   {@link openServerPayload}'s try-then-fall-back, exactly as the app does.
*
* The wire is OpenAI-shaped, so the core's one-way forwarding contract holds:
* the only work this driver does is unwrapping the envelope back into ordinary
* `data: <chunk>` frames, which is what the shim pipes.
*
* @module dsh-llm-bridge/drivers/qoder/upstream
*/
/** Effort spellings the catalog can declare, in ascending order. */
const EFFORT_VALUES$1 = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Default output ceiling; the catalog does not declare one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32e3;
/** Fallback context window when a row declares neither a tier nor a limit. */
const DEFAULT_CONTEXT_WINDOW = 128e3;
const JSON_TIMEOUT_MS$1 = 3e4;
const ERROR_BODY_LIMIT$1 = 4096;
const DISCOVERY_TTL_MS = 6e5;
/** Region/node discovery path (plain HTTP, no wasm signing involved). */
const ENDPOINTS_PATH = "/algo/api/v4/service/region/endpoints";
/** Model catalog path; `Encode=1` marks the response as sealed. */
const MODEL_LIST_PATH = "/api/v2/model/list?Encode=1";
/** Device-token refresh path on the openapi host. */
const REFRESH_PATH = "/api/v1/deviceToken/refresh";
/** Insufficient-quota markers, ASCII first and then the original Chinese. */
const HARD_CREDIT_MARKERS$1 = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"not enough credit",
	"free quota",
	"credit not enough",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分",
	"额度已用完",
	"免费额度已用完",
	"超出额度"
];
/** Sign-in/credential rejection markers. */
const SESSION_DEAD_MARKERS$1 = [
	"signature invalid",
	"unauthenticated",
	"unauthorized",
	"invalid token",
	"token expired",
	"refresh token expired",
	"not logged in",
	"未登录",
	"登录已过期",
	"请重新登录",
	"令牌已过期",
	"凭证已失效"
];
/**
* Marker for a signature reused within the server's dedup window. This is a
* bridge-side artifact (a context reused across calls), not a credential
* problem, so it must not be reported as "sign in again".
*/
const DUPLICATE_MARKERS = ["duplicate request"];
/**
* Classify an upstream failure from its HTTP status and body excerpt.
*
* `403` is overloaded here: the endpoint answers `Signature invalid` (the
* credential or the auth fields are stale — re-signing in is the remedy) and
* `Duplicate request` (the driver reused a signature) with the same status.
* They are told apart by body before the status is considered.
*/
function classifyQoderError(status, body) {
	const lower = body.toLowerCase();
	const mentions = (markers) => markers.some((marker) => lower.includes(marker.toLowerCase()) || body.includes(marker));
	if (status === 402) return "hard_credit";
	if (mentions(HARD_CREDIT_MARKERS$1)) return "hard_credit";
	if (mentions(DUPLICATE_MARKERS)) return "client";
	if (mentions(SESSION_DEAD_MARKERS$1)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 401 || status === 403) return "session_dead";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/** Parse a catalog `context_config` into the default tier's token count. */
function contextWindowOf(row) {
	const config = row["context_config"];
	if (typeof config === "object" && config !== null && !Array.isArray(config)) {
		const tiers = config;
		let max = 0;
		for (const tier of Object.values(tiers)) {
			if (typeof tier !== "object" || tier === null) continue;
			const count = tier["token_count"];
			if (typeof count === "number" && count > max) max = count;
		}
		if (max > 0) return max;
	}
	const declared = row["max_input_tokens"];
	if (typeof declared === "number" && declared > 0) return declared;
	return DEFAULT_CONTEXT_WINDOW;
}
/** Parse `thinking_config` into the declared effort ladder. */
function reasoningOf(row) {
	if (row["is_reasoning"] !== true) return void 0;
	const config = row["thinking_config"];
	const reasoning = {
		supports: true,
		canDisableThinking: typeof config === "object" && config !== null && "disabled" in config
	};
	if (typeof config !== "object" || config === null) return reasoning;
	const enabled = config["enabled"];
	if (typeof enabled !== "object" || enabled === null) return reasoning;
	const efforts = enabled["efforts"];
	if (typeof efforts !== "object" || efforts === null) return reasoning;
	const declared = [];
	let defaultEffort;
	for (const [name, value] of Object.entries(efforts)) {
		if (!EFFORT_VALUES$1.includes(name)) continue;
		declared.push(name);
		if (typeof value === "object" && value !== null && value["is_default"] === true) defaultEffort = name;
	}
	if (declared.length > 0) {
		const ordered = EFFORT_VALUES$1.filter((effort) => declared.includes(effort));
		return {
			...reasoning,
			supportedEfforts: ordered,
			...defaultEffort === void 0 ? {} : { defaultEffort }
		};
	}
	return reasoning;
}
/** Parse `price_factor` / `is_free` / `promotion` into offer facts. */
function billingOf(row) {
	const factor = row["price_factor"];
	const credits = typeof factor === "number" && Number.isFinite(factor) ? `x${factor}` : void 0;
	const badges = [];
	const promotion = row["promotion"];
	if (typeof promotion === "object" && promotion !== null) {
		const badge = promotion["badge"];
		if (typeof badge === "object" && badge !== null) {
			const wrapped = badge;
			const label = wrapped["zh"] ?? wrapped["en"];
			if (typeof label === "string" && label !== "") badges.push(label);
		}
	}
	const free = row["is_free"] === true;
	if (credits === void 0 && badges.length === 0 && !free) return void 0;
	return {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free
	};
}
/** Project one catalog row into a model record, or undefined when unusable. */
function mapQoderModel(row) {
	if (typeof row !== "object" || row === null || Array.isArray(row)) return void 0;
	const wrapped = row;
	const id = typeof wrapped["key"] === "string" ? wrapped["key"] : "";
	if (id === "") return void 0;
	const source = typeof wrapped["source"] === "string" ? wrapped["source"] : "";
	const displayName = typeof wrapped["display_name"] === "string" && wrapped["display_name"] !== "" ? wrapped["display_name"] : id;
	const reasoning = reasoningOf(wrapped);
	const billing = billingOf(wrapped);
	return {
		id,
		name: displayName,
		contextWindow: contextWindowOf(wrapped),
		maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		supportsImages: wrapped["is_vl"] === true,
		...reasoning === void 0 ? {} : { reasoning },
		...billing === void 0 ? {} : { billing },
		source: source === "" ? "system" : source,
		enabled: wrapped["enable"] !== false,
		isDefault: wrapped["is_default"] === true
	};
}
/**
* Normalize an OpenAI chat body for Qoder.
*
* Verified against the live endpoint: the deserializer is permissive — unknown
* fields, `tool_choice`, `tools`, `max_completion_tokens` and a `developer`
* role are all accepted with HTTP 200 — so the body is passed through almost
* untouched rather than reduced to a whitelist, which would silently drop
* capabilities the platform does support.
*
* Three changes are made:
*
* 1. `stream` is forced true; the endpoint only answers in SSE.
* 2. `request_id` and `task_id` are stamped fresh. The wasm already gives every
*    signature its own nonce (which is what the server's duplicate detection
*    keys on), but carrying a caller-supplied constant here reuses a request
*    identity across calls and buys nothing. `session_id` is preserved when
*    present, because grouping is a real semantic, and generated otherwise.
* 3. `role: "developer"` is rewritten to `"system"`. The endpoint accepts
*    `developer` without complaining, which is exactly why this matters: an
*    unrecognized role could be dropped silently, and the dropped message would
*    be the system prompt. `system` is the spelling that is certainly honored.
*/
function prepareQoderChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const document = body;
	document["stream"] = true;
	document["request_id"] = randomUUID();
	document["task_id"] = randomUUID();
	if (typeof document["session_id"] !== "string" || document["session_id"] === "") document["session_id"] = randomUUID();
	const messages = document["messages"];
	if (Array.isArray(messages)) for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
	return JSON.stringify(document);
}
/** The catalog key a chat body selects. */
function modelKeyOf(bodyJson) {
	try {
		const parsed = JSON.parse(bodyJson);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const model = parsed["model"];
			if (typeof model === "string" && model !== "") return model;
		}
	} catch {}
	return QODER_AUTO_MODEL;
}
/** One `data:` payload extracted from an SSE event block. */
function dataPayloadsOf(event) {
	const payloads = [];
	for (const line of event.split("\n")) {
		if (!line.startsWith("data:")) continue;
		payloads.push(line.slice(5).replace(/^ /u, ""));
	}
	return payloads;
}
/** Render one OpenAI SSE frame. */
function sseFrame(payload) {
	return `data: ${payload}\n\n`;
}
/**
* Translate Qoder's enveloped SSE into ordinary OpenAI SSE.
*
* The core pipes a driver's response body verbatim, so the unwrapping has to
* happen here: the DSH client parses `data: <chunk>` frames, and Qoder's
* frames carry the chunk one level down inside an envelope's `body` string.
*
* Frames that are not chat chunks are dropped rather than forwarded — the
* trailing `event: finish` carries timings, and forwarding a shapeless object
* to the client would end the turn with a parse error.
*
* A server-side error arriving mid-stream is surfaced as an OpenAI-style
* `{"error": …}` frame followed by `[DONE]`, because by then the HTTP status
* is long since committed and silence would look like a successful empty
* answer.
*/
function translateQoderStream(api, body, logger) {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	let finished = false;
	/** Translate one SSE event block into the bytes to forward, or undefined. */
	const renderEvent = (event) => {
		const payloads = dataPayloadsOf(event);
		if (payloads.length === 0) return void 0;
		const plain = openServerPayload(api, payloads.join("\n")).trim();
		if (plain === "") return void 0;
		if (plain === "[DONE]" || plain === "\"[DONE]\"") {
			finished = true;
			return sseFrame("[DONE]");
		}
		let parsed;
		try {
			parsed = JSON.parse(plain);
		} catch (error) {
			logger?.warn("dsh-llm-bridge: qoder sent an unparsable SSE frame", safeMessage(error));
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
		const document = parsed;
		if (typeof document["body"] === "string") {
			const status = document["statusCodeValue"];
			if (typeof status === "number" && status !== 200) {
				finished = true;
				const message = document["statusCode"];
				return sseFrame(JSON.stringify({ error: {
					message: `qoder upstream: frame status ${status} ${String(message ?? "")}`.trim(),
					type: "server"
				} })) + sseFrame("[DONE]");
			}
			const inner = document["body"].trim();
			if (inner === "[DONE]") {
				finished = true;
				return sseFrame("[DONE]");
			}
			let chunk;
			try {
				chunk = JSON.parse(inner);
			} catch {
				logger?.warn("dsh-llm-bridge: qoder envelope body was not JSON; dropping the frame");
				return;
			}
			if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) return void 0;
			const wrapped = chunk;
			if (!Array.isArray(wrapped["choices"]) && wrapped["error"] === void 0 && !("code" in wrapped)) return void 0;
			return renderChunk(wrapped);
		}
		if (!Array.isArray(document["choices"]) && document["error"] === void 0 && !("code" in document)) return;
		return renderChunk(document);
	};
	/** Forward a chunk, converting a server error into an error frame. */
	const renderChunk = (chunk) => {
		const code = chunk["code"];
		const message = chunk["message"];
		if (chunk["choices"] === void 0 && (typeof code !== "undefined" || typeof message === "string")) {
			finished = true;
			return sseFrame(JSON.stringify({ error: {
				message: `qoder upstream: ${String(code ?? "")} ${String(message ?? "")}`.trim(),
				type: "server"
			} })) + sseFrame("[DONE]");
		}
		return sseFrame(JSON.stringify(chunk));
	};
	return new ReadableStream({ async start(controller) {
		if (body === null) {
			finished = true;
			controller.enqueue(encoder.encode(sseFrame("[DONE]")));
			controller.close();
			return;
		}
		const reader = body.getReader();
		try {
			while (!finished) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, "\n");
				for (;;) {
					const index = buffer.indexOf("\n\n");
					if (index < 0) break;
					const event = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					const rendered = renderEvent(event);
					if (rendered !== void 0) controller.enqueue(encoder.encode(rendered));
					if (finished) break;
				}
			}
			if (!finished) {
				const rendered = renderEvent(buffer);
				if (rendered !== void 0) controller.enqueue(encoder.encode(rendered));
			}
		} catch (error) {
			logger?.warn("dsh-llm-bridge: qoder stream failed mid-flight", safeMessage(error));
		} finally {
			try {
				await reader.cancel();
			} catch {}
		}
		if (!finished) controller.enqueue(encoder.encode(sseFrame("[DONE]")));
		controller.close();
	} });
}
/**
* Upstream client. One instance serves the whole plugin; requests take the
* credential explicitly so a rotation applies on the next call.
*/
var QoderUpstreamClient = class {
	injectedApi;
	logger;
	gatewayOverride;
	endpointsCache;
	constructor(options = {}) {
		this.injectedApi = options.api;
		this.logger = options.logger;
		this.gatewayOverride = options.gatewayBase;
	}
	api() {
		return this.injectedApi ?? loadQoderWasm();
	}
	/**
	* Build a signing context.
	*
	* A fresh context per request is mandatory, not tidiness: the wasm stamps
	* each one with its own request nonce, and reusing a context reuses the
	* nonce, which the server rejects with `Duplicate request`. The auth fields
	* are derived here because the stored credential leaves them empty.
	*/
	buildContext(credential) {
		const api = this.api();
		const userInfo = signingUserInfo(credential, JSON.parse(api.generate_runtime_auth_fields(runtimeAuthFieldsInput(credential))));
		const context = api.createContext(credential.machineId, QODER_COSY_VERSION, userInfo, JSON.stringify(QODER_CLIENT_METADATA));
		context.refreshAuthFields(userInfo);
		return context;
	}
	/** Build a signed inference request and copy it out of wasm memory. */
	signInferRequest(credential, bodyJson) {
		const context = this.buildContext(credential);
		let prepared;
		try {
			prepared = context.prepareInferRequest(this.inferBase(), bodyJson, modelKeyOf(bodyJson), "system");
			return {
				url: prepared.url,
				headers: Object.fromEntries(prepared.headers),
				body: prepared.body
			};
		} finally {
			prepared?.free();
			context.free();
		}
	}
	/**
	* The inference host, from the cached discovery answer.
	*
	* Discovery is a plain HTTP call whose response is sealed; it is not needed
	* for signing, so {@link signInferRequest} cannot await it. The cache is
	* primed by {@link discoverEndpoints} (called at plugin start and before the
	* catalog fetch) and otherwise falls back to the constant the endpoint
	* currently answers with.
	*/
	inferBase() {
		return this.endpointsCache?.inferBase ?? this.gatewayOverride ?? "https://gateway.qoder.com.cn";
	}
	/**
	* Resolve the region's node list and cache the inference host.
	*
	* Verified to need no wasm signing at all: a bearer device token plus the
	* machine id headers is enough, and the answer comes back sealed.
	*/
	async discoverEndpoints(credential) {
		const cached = this.endpointsCache;
		if (cached !== void 0 && Date.now() - cached.at < DISCOVERY_TTL_MS) return void 0;
		const base = this.gatewayOverride ?? "https://gateway.qoder.com.cn";
		try {
			const response = await fetch(`${base}${ENDPOINTS_PATH}`, {
				headers: {
					"Authorization": `Bearer ${credential.accessToken}`,
					"Cosy-MachineId": credential.machineId,
					"Cosy-MachineToken": credential.machineId,
					"Accept": "application/json"
				},
				signal: AbortSignal.timeout(JSON_TIMEOUT_MS$1)
			});
			const text = await response.text();
			if (!response.ok) throw new Error(`http ${response.status}: ${safeMessage(text.slice(0, 200))}`);
			const opened = openServerPayload(this.api(), text);
			const parsed = JSON.parse(opened);
			if (typeof parsed !== "object" || parsed === null) throw new Error("unexpected document");
			const document = parsed;
			const read = (key) => Array.isArray(document[key]) ? document[key].filter((value) => typeof value === "string") : [];
			const endpoints = {
				centerNodes: read("centerNodes"),
				inferNodes: read("inferNodes"),
				openapiNodes: read("openapiNodes")
			};
			const inferBase = endpoints.inferNodes[0];
			this.endpointsCache = {
				at: Date.now(),
				inferBase: inferBase ?? this.gatewayOverride ?? "https://gateway.qoder.com.cn"
			};
			return endpoints;
		} catch (error) {
			this.logger?.warn("dsh-llm-bridge: qoder node discovery failed; using the default gateway", safeMessage(error));
			this.endpointsCache = {
				at: Date.now(),
				inferBase: this.gatewayOverride ?? "https://gateway.qoder.com.cn"
			};
			return;
		}
	}
	/**
	* POST the inference endpoint; a successful answer is an SSE stream already
	* translated into ordinary OpenAI frames.
	*/
	async chatStream(credential, bodyJson, signal) {
		let signed;
		try {
			signed = this.signInferRequest(credential, bodyJson);
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `qoder signing failed: ${safeMessage(error)}`
			};
		}
		let response;
		try {
			response = await fetch(signed.url, {
				method: "POST",
				headers: {
					...signed.headers,
					"Accept": "text/event-stream"
				},
				body: signed.body,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${safeMessage(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response: { body: translateQoderStream(this.api(), response.body, this.logger) }
		};
		const text = safeMessage((await response.text()).slice(0, ERROR_BODY_LIMIT$1));
		return {
			ok: false,
			status: response.status,
			kind: classifyQoderError(response.status, text),
			message: text
		};
	}
	/**
	* POST the device-token refresh.
	*
	* The answer's refresh token is a *rotation*: the one sent here stops
	* working, so the caller must persist the result (the store writes it back).
	*/
	async refreshToken(credential) {
		const response = await fetch(`${QODER_OPENAPI_BASE}${REFRESH_PATH}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": "Bearer"
			},
			body: JSON.stringify({ refresh_token: credential.refreshToken }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS$1)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`qoder: token refresh rejected (http ${response.status}): ${safeMessage(text.slice(0, ERROR_BODY_LIMIT$1))} [machine ${qoderCredentialKey(credential.machineId).length}-char key]`);
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("qoder: token refresh returned a non-JSON document");
		}
		return parseQoderRefreshResponse(parsed);
	}
	/**
	* GET the model catalog and keep the rows this driver can serve.
	*
	* Only `source: system` rows are kept — a BYOK row would need the user's own
	* key — only `format: openai` rows are meaningful through a chat-completions
	* shim, and only `enable: true` rows are exposed. `enable` is an
	* account-level entitlement flag, not a UI default: a model with
	* `enable: false` is not drivable on this account, and requesting it makes
	* the gateway silently fall back to its hard default model (observed answering
	* as "Qwen3.5") instead of erroring. Dropping those rows keeps the host's
	* model picker honest, so a user can only select a model the account can use.
	*/
	async fetchModels(credential) {
		const context = this.buildContext(credential);
		let signed;
		try {
			const prepared = context.prepareRequest(this.inferBase(), MODEL_LIST_PATH, "GET", "auth");
			signed = {
				url: prepared.url,
				headers: Object.fromEntries(prepared.headers),
				body: prepared.body
			};
			prepared.free();
		} finally {
			context.free();
		}
		const response = await fetch(signed.url, {
			method: "GET",
			headers: signed.headers,
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS$1)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`qoder: model catalog request failed (http ${response.status}): ${safeMessage(text.slice(0, ERROR_BODY_LIMIT$1))}`);
		const opened = openServerPayload(this.api(), text);
		let parsed;
		try {
			parsed = JSON.parse(opened);
		} catch {
			throw new Error("qoder: model catalog was not JSON");
		}
		if (typeof parsed !== "object" || parsed === null) throw new Error("qoder: model catalog had an unexpected shape");
		const document = parsed;
		const rows = document["assistant"] ?? document["chat"];
		if (!Array.isArray(rows)) throw new Error("qoder: model catalog carried no model list");
		const models = [];
		for (const row of rows) {
			const mapped = mapQoderModel(row);
			if (mapped === void 0) continue;
			if (mapped.source !== "system") continue;
			const format = typeof row === "object" && row !== null ? row["format"] : void 0;
			if (format !== void 0 && format !== "openai") continue;
			if (!mapped.enabled) continue;
			models.push(mapped);
		}
		if (models.length === 0) throw new Error("qoder: model catalog resolved to an empty list");
		return models;
	}
};
//#endregion
//#region src/drivers/qoder/heartbeat.ts
/**
* Qoder driver heartbeat: binds the core heartbeat mechanism to the driver's
* file name so it never collides with another driver's file.
*
* @module dsh-llm-bridge/drivers/qoder/heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const QODER_HOST_HEARTBEAT_FILENAME = ".qoder-host-heartbeat.json";
const heartbeat$1 = createHostHeartbeat({
	fileName: QODER_HOST_HEARTBEAT_FILENAME,
	packageName: "dsh-llm-bridge"
}, BRIDGE_VERSION);
/** Absolute path of the host heartbeat file. */
const qoderHostHeartbeatPath = heartbeat$1.path;
/** Write (or overwrite) the heartbeat after the host registered the provider. */
const writeHostHeartbeat$1 = heartbeat$1.write;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
const clearHostHeartbeat$1 = heartbeat$1.clear;
/** Read and validate the heartbeat; `undefined` when absent or malformed. */
const readHostHeartbeat$1 = heartbeat$1.read;
//#endregion
//#region src/drivers/workbuddy/auth.ts
/**
* WorkBuddy credential discovery and storage. The primary source is the
* WorkBuddy desktop app's own auth file, read-only; a driver-owned copy
* under `$DSH_HOME` holds token refreshes so the desktop file is never
* written. The effective credential is whichever of the two expires later,
* so a refresh by either side wins.
*
* This is WorkBuddy-private knowledge: the desktop file's platform path,
* its on-disk JSON shapes, the env override, and the owned-copy format. The
* generic refresh lifecycle (expiry margin, single-flight, failed-refresh
* fallback) lives in the core's {@link CredentialRefresher}; storage stays
* entirely here — the core never assumes credentials come from files.
*
* @module dsh-llm-bridge/drivers/workbuddy/auth
*/
/** Basename of the driver-owned credential copy inside the Harness home. */
const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Current on-disk format of the driver-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Driver-owned copy path inside the Harness home. */
function workbuddyOwnAuthPath() {
	return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME);
}
const DESKTOP_AUTH_RELATIVE_PATH = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth",
	"workbuddy-desktop.info"
];
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home) {
	const profile = windowsPathForWsl(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH), join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH)];
}
/**
* Platform-default candidates for the WorkBuddy desktop app's auth file, in
* probe order. Windows probes both AppData roots: current builds write under
* `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
* those same Windows locations through its mounted Windows profile before the
* native Linux location.
*/
function defaultDesktopAuthCandidates() {
	const home = homedir();
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "win32") return [join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"), join(home, "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...DESKTOP_AUTH_RELATIVE_PATH);
		return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux];
	}
	return [];
}
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
function defaultDesktopAuthPath() {
	return defaultDesktopAuthCandidates()[0];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
* nested form `{"auth":{...},"account":{...}}` and the flat panel form.
* Returns undefined when the document carries no access token.
*/
function parseWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop"
	};
}
/** Serialize the driver-owned copy. */
function ownDocument(credential) {
	return {
		version: OWN_FORMAT_VERSION,
		credential
	};
}
/** Parse the driver-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const stored = document["credential"];
	const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
	const enterpriseId = optionalString(stored["enterpriseId"]);
	const nickname = optionalString(stored["nickname"]);
	return {
		accessToken,
		refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
		expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(stored["domain"]) ?? "",
		uid: optionalString(stored["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* Read-only credential store with demand-driven refresh.
*
* Refresh policy: refresh only when the access token is inside the margin
* (or already expired), keep the refreshed credential in the driver-owned
* copy, and never write the desktop app's file. A failed refresh still
* returns a not-yet-expired token so an unreachable refresh endpoint does
* not take down a working session.
*
* The refresh lifecycle itself is delegated to the core
* {@link CredentialRefresher}; this class adds WorkBuddy's two storage
* sources, their merge rule, and the WorkBuddy-specific error wording.
*/
var WorkBuddyCredentialStore = class {
	refresh;
	refresher;
	ownPath;
	desktopPathOverride;
	constructor(options) {
		this.refresh = options.refresh;
		this.refresher = new CredentialRefresher({
			refresh: (credential) => this.refreshCredential(credential),
			...options.refreshMarginMs === void 0 ? {} : { refreshMarginMs: options.refreshMarginMs }
		});
		this.ownPath = options.ownPath ?? workbuddyOwnAuthPath();
		this.desktopPathOverride = options.desktopPath;
	}
	/**
	* Configuration precedence for the desktop file: the plugin's configured
	* path, then the environment variable, then the platform defaults. An
	* explicit path is used verbatim; the defaults are a probe order.
	*/
	resolveDesktopCandidates() {
		const fromEnv = process.env[WORKBUDDY_AUTH_FILE_ENV];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return defaultDesktopAuthCandidates();
	}
	resolveDesktopPath() {
		return this.resolveDesktopCandidates()[0];
	}
	/**
	* Repoint the desktop file; a settings change applies on the next read.
	*/
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	/** The resolved desktop auth-file path, for diagnostics. */
	desktopAuthPath() {
		return this.resolveDesktopPath();
	}
	/** The driver-owned copy path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/** Read the freshest stored credential without refreshing anything. */
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const candidates = this.resolveDesktopCandidates();
			const desktop = candidates.length > 0 ? candidates.join(" or ") : "(no desktop path on this platform)";
			throw new Error(`workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app (expected ${desktop} or WORKBUDDY_AUTH_FILE), or refresh an existing session`);
		}
		return this.refresher.refreshIfNeeded(credential);
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				source: credential.source
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	/** Remove the driver-owned copy; the desktop file is untouched. */
	async logout() {
		await rm(this.ownPath, { force: true });
		await rm(`${this.ownPath}.lock`, { force: true });
	}
	/**
	* Perform the WorkBuddy refresh for one credential and persist the
	* outcome in the owned copy. The no-refresh-token short-circuit and the
	* error wording (including the wrapped upstream cause) are exactly what
	* the pre-refactor store produced; the core refresher adds the
	* still-valid fallback around this call.
	*/
	async refreshCredential(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			throw new Error(`workbuddy: token refresh failed and the access token is expired (${String(error)}); open the WorkBuddy desktop app once to sign in again`);
		}
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	/**
	* Read the first desktop candidate that exists. Only an absent file
	* (ENOENT) falls through to the next candidate; a file that is present
	* but unparsable is authoritative for its slot, so a stale older-version
	* file never silently wins over a broken newer one.
	*/
	async readDesktop() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			return parseWorkBuddyAuth(await readFile(desktopPath, "utf8"));
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
	/** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			if ((await stat(desktopPath)).isFile()) return true;
		} catch {}
		return false;
	}
};
//#endregion
//#region src/drivers/workbuddy/catalog.ts
/**
* WorkBuddy model catalog: a static fallback list captured from the live
* endpoint, replaced by the upstream's dynamic answer once it loads.
*
* The roster and every field on it are WorkBuddy-private facts; only the
* mutable container comes from the core.
*
* @module dsh-llm-bridge/drivers/workbuddy/catalog
*/
/**
* Static CLI models observed on the CN endpoint (re-verified against the live
* catalog 2026-09-01, including the thinking-effort and billing metadata). The
* upstream refresh replaces this list at startup; it exists so the provider
* registers with a usable catalog even while the first fetch is in flight or
* offline.
*
* The list tracks the `cli` agent's model roster exactly: the 15 models the
* desktop CLI offers. Reasoning metadata is taken verbatim from the live
* endpoint — each model's supported effort set and whether thinking can be
* disabled — and the `free` flag follows the upstream `x0.00` credits marker.
*/
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "auto",
		name: "Auto",
		contextWindow: 168e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: { free: false }
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			badges: ["限时免费"],
			free: true
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			badges: ["夜间折扣"],
			free: false
		}
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: false,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.71 credits",
			free: false
		}
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.57 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52 credits",
			free: false
		}
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.25 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4-flash",
		name: "Deepseek-V4-Flash",
		contextWindow: 1e6,
		maxTokens: 5e4,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.17 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxTokens: 5e4,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.51 credits",
			free: false
		}
	},
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			badges: ["限时免费"],
			free: true
		}
	},
	{
		id: "hy3-x",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.05",
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"xhigh"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.06",
			free: false
		}
	}
];
/**
* Mutable WorkBuddy catalog seeded with the fallback roster; shared by the
* shim's `/v1/models` and the adapter.
*/
var WorkBuddyCatalog = class extends Catalog {
	constructor() {
		super(FALLBACK_WORKBUDDY_MODELS);
	}
};
//#endregion
//#region src/drivers/workbuddy/upstream.ts
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
/**
* Reduce an upstream credits string to its language-neutral display form.
*
* The host LLM seam carries this text to the browser, and the host has no
* locale service — whatever string is produced here is shown verbatim in every
* UI language. The upstream is inconsistent in a way that matters: some catalog
* rows report a bare multiplier (`x0.79`) and others append a unit word
* (`x0.79 credits`), and the unit word would pin the display to English.
* Dropping a trailing `credits` (case-insensitive, singular or plural) yields
* the one spelling that reads identically in every language.
*
* @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
* @returns the bare multiplier, or undefined when nothing displayable remains.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = wrapped["tags"];
	if (Array.isArray(rawTags)) for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "") badges.push(label);
	}
	const free = credits !== void 0 && /^x?0\.0+$/u.test(credits);
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free
	} };
}
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	return "cn";
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
* force `stream: true` (the upstream rejects non-streaming), flatten
* `tool_choice` (the upstream's field is a string; object forms return 400),
* and rewrite `developer` messages as `system`.
*
* The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
* `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
* upstream rejects that role with HTTP 400 code 11128 ("Illegal API
* invocation from an unapproved channel"). Rewriting to `system` is the
* compatible spelling the upstream accepts.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so token refreshes apply on the next call.
*/
var WorkBuddyUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/** GET the personal model catalog and keep the `cli` agent's models only. */
	async fetchModels(credential) {
		const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Accept": "application/json",
				"Origin": originReferer(credential),
				"Referer": `${originReferer(credential)}/`,
				"User-Agent": CLIENT_UA
			},
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
		const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
		let cliIds;
		for (const agent of agents) if (typeof agent === "object" && agent !== null) {
			const wrapped = agent;
			if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
				cliIds = wrapped["models"].filter((id) => typeof id === "string");
				break;
			}
		}
		if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddy model catalog lists no cli agent models");
		const byId = /* @__PURE__ */ new Map();
		for (const model of rawModels) {
			if (typeof model !== "object" || model === null) continue;
			const wrapped = model;
			const id = typeof wrapped["id"] === "string" ? wrapped["id"] : "";
			if (id === "" || wrapped["disabled"] === true) continue;
			const input = typeof wrapped["maxInputTokens"] === "number" ? wrapped["maxInputTokens"] : 0;
			const output = typeof wrapped["maxOutputTokens"] === "number" ? wrapped["maxOutputTokens"] : 0;
			if (input <= 0 || output <= 0) continue;
			byId.set(id, {
				id,
				name: typeof wrapped["name"] === "string" && wrapped["name"] !== "" ? wrapped["name"] : id,
				contextWindow: input,
				maxTokens: output,
				supportsImages: wrapped["supportsImages"] === true && wrapped["disabledMultimodal"] !== true,
				...resolveUpstreamReasoning(wrapped),
				...resolveUpstreamBilling(wrapped)
			});
		}
		const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
		return models;
	}
	/** POST the billing endpoint for the aggregated remaining credit. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const size = numberField("CycleCapacitySize");
			const cycleRemain = numberField("CycleCapacityRemain");
			const cycleUsed = numberField("CycleCapacityUsed");
			const capacityRemain = numberField("CapacityRemain");
			let remain;
			if (size > 0) remain = cycleRemain;
			else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
			else remain = capacityRemain;
			if (remain < 0) remain = 0;
			total += remain;
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize")
			});
		}
		return {
			total,
			accounts
		};
	}
};
//#endregion
//#region src/drivers/workbuddy/heartbeat.ts
/**
* WorkBuddy driver heartbeat: binds the core heartbeat mechanism to this
* driver's file name and the package marker. The file name stays
* WorkBuddy-scoped (`.workbuddy-host-heartbeat.json`) so a future second
* driver never collides on the same file; the package marker follows the
* renamed package.
*
* @module dsh-llm-bridge/drivers/workbuddy/heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
const heartbeat = createHostHeartbeat({
	fileName: WORKBUDDY_HOST_HEARTBEAT_FILENAME,
	packageName: "dsh-llm-bridge"
}, BRIDGE_VERSION);
/** Absolute path of the host heartbeat file. */
const workbuddyHostHeartbeatPath = heartbeat.path;
/** Write (or overwrite) the heartbeat after the host registered the provider. */
const writeHostHeartbeat = heartbeat.write;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
const clearHostHeartbeat = heartbeat.clear;
/** Read and validate the heartbeat; `undefined` when absent or malformed. */
const readHostHeartbeat = heartbeat.read;
//#endregion
export { normalizeOrganizationTags as $, translateQoderStream as A, QODER_CLIENT_METADATA as B, readHostHeartbeat$1 as C, LOOMY_BASE_URL as Ct, mapQoderModel as D, LOOMY_SESSION_FILENAME as Dt, classifyQoderError as E, LOOMY_PROVIDER as Et, loadQoderWasm as F, QODER_PROVIDER as G, QODER_DISPLAY_NAME as H, openServerPayload as I, QODER_CREDENTIAL_KEY_LENGTH as J, QODER_SCENE as K, QODER_AGENT_ID as L, QoderCatalog as M, QoderCredentialStore as N, modelKeyOf as O, LOOMY_SESSION_FILE_ENV as Ot, defaultAuthDirectoryCandidates as P, mergeRefreshOutcome as Q, QODER_AUTH_DIR_ENV as R, qoderHostHeartbeatPath as S, parseLoomySession as St, QoderUpstreamClient as T, LOOMY_DISPLAY_NAME as Tt, QODER_GATEWAY_BASE as U, QODER_COSY_VERSION as V, QODER_OPENAPI_BASE as W, epochMsOf as X, credentialFromUserInfo as Y, isUsableMachineId as Z, defaultDesktopAuthPath as _, FALLBACK_LOOMY_MODELS as _t, writeHostHeartbeat as a, clearHostHeartbeat$2 as at, QODER_HOST_HEARTBEAT_FILENAME as b, defaultSessionCandidates as bt, normalizeCredits as c, writeHostHeartbeat$2 as ct, FALLBACK_WORKBUDDY_MODELS as d, processStartTimeMs as dt, parseQoderRefreshResponse as et, WorkBuddyCatalog as f, createStatusHandler as ft, defaultDesktopAuthCandidates as g, originIsLoopback as gt, WorkBuddyCredentialStore as h, hostIsLoopback as ht, workbuddyHostHeartbeatPath as i, LOOMY_HOST_HEARTBEAT_FILENAME as it, FALLBACK_QODER_MODELS as j, prepareQoderChatBody as k, LOOMY_STREAM_IDLE_TIMEOUT_MS as kt, prepareChatBody as l, BRIDGE_VERSION as lt, WORKBUDDY_AUTH_FILE_ENV as m, safeMessage as mt, clearHostHeartbeat as n, runtimeAuthFieldsInput as nt, WorkBuddyUpstreamClient as o, loomyHostHeartbeatPath as ot, WORKBUDDY_AUTH_FILENAME as p, registerStatusRoute as pt, QODER_STREAM_IDLE_TIMEOUT_MS as q, readHostHeartbeat as r, signingUserInfo as rt, classifyUpstreamError as s, readHostHeartbeat$2 as st, WORKBUDDY_HOST_HEARTBEAT_FILENAME as t, qoderCredentialKey as tt, regionOf as u, isHeartbeatProcessAlive as ut, parseWorkBuddyAuth as v, LoomyCatalog as vt, writeHostHeartbeat$1 as w, LOOMY_CLIENT_VERSION as wt, clearHostHeartbeat$1 as x, defaultSessionPath as xt, workbuddyOwnAuthPath as y, LoomySessionStore as yt, QODER_AUTO_MODEL as z };
