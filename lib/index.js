import { S as workbuddyOwnAuthPath, _ as WORKBUDDY_AUTH_FILE_ENV, a as writeHostHeartbeat, b as defaultDesktopAuthPath, c as processStartTimeMs, d as normalizeCredits, f as prepareChatBody, g as WORKBUDDY_AUTH_FILENAME, h as WorkBuddyCatalog, i as workbuddyHostHeartbeatPath, l as WorkBuddyUpstreamClient, m as FALLBACK_WORKBUDDY_MODELS, n as clearHostHeartbeat, p as regionOf, r as readHostHeartbeat, s as isHeartbeatProcessAlive, t as WORKBUDDY_HOST_HEARTBEAT_FILENAME, u as classifyUpstreamError, v as WorkBuddyCredentialStore, x as parseWorkBuddyAuth, y as defaultDesktopAuthCandidates } from "./heartbeat-CH8IWOfb.js";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/core/adapter.ts
/**
* Generic pi-ai provider assembly for one loopback-backed bridge route,
* registered into the Harness LLM seam.
*
* The core owns everything that is about the DSH/pi-ai mechanism: the
* inert credential plane (authentication rides the shim shared secret),
* the OpenAI-completions API binding to the loopback origin, the resolved
* provider profile (retry policy, stream idle timeout, image budgets), and
* folding catalog facts into the model pickers' display names.
*
* The driver supplies the platform facts through callbacks:
* - `toModel` maps one catalog entry to its pi-ai descriptor (capabilities,
*   thinking levels, context windows);
* - `decorateModelName` optionally rewrites the picker display name.
*
* @module dsh-llm-bridge/core/adapter
*/
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose pi-ai
* descriptor declares image input; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. A bridge route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-llm-bridge: this bridge route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*/
function createBridgeAdapter(options) {
	const { providerId, displayName, credentialName, credentialSource, shim, catalog, toModel, decorateModelName, streamIdleTimeoutMs, resolveAttachments } = options;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toModel(info, baseUrl));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: credentialName,
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: credentialSource
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const buildProfile = () => ({
		provider: providerId,
		displayName,
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-llm-bridge retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	});
	let profiles = /* @__PURE__ */ new Map([[providerId, buildProfile()]]);
	return {
		adapter: new CatalogPiAiAdapter(catalog, decorateModelName, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, buildProfile()]]);
		}
	};
}
/**
* Adapter that folds live catalog facts into the answers it returns to the
* DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers
* straight from the pi-ai descriptors; the optional driver decorator
* rewrites display fields by looking the model up in the live catalog. Both
* overrides delegate to `super` and then rewrite display fields only, so
* streaming, capability resolution, and effort mapping stay exactly as
* `dsh-llm-pi-ai` implements them.
*
* A model missing from the catalog falls through with its name untouched
* rather than being dropped: catalog membership is advisory, and the seam
* tolerates serving an unlisted id.
*/
var CatalogPiAiAdapter = class extends PiAiAdapter {
	catalog;
	decorateModelName;
	constructor(catalog, decorateModelName, options) {
		super(options);
		this.catalog = catalog;
		this.decorateModelName = decorateModelName;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		if (this.decorateModelName === void 0) return models;
		const decorate = this.decorateModelName;
		return models.map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: decorate(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		if (this.decorateModelName === void 0) return resolved;
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: this.decorateModelName(resolved.name, info)
		};
	}
};
//#endregion
//#region src/drivers/workbuddy/meta.ts
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
const WORKBUDDY_PROVIDER = "workbuddy";
/** Human-facing provider name in the DSH model pickers. */
const WORKBUDDY_DISPLAY_NAME = "WorkBuddy";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
//#endregion
//#region src/drivers/workbuddy/adapter.ts
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
* separator would be ambiguous about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* The catalog display suffix: the billing rate followed by the declared promo
* badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
* The badge labels are the upstream's own spellings and the host seam has no
* locale service, so non-Chinese UIs see them verbatim — accepted until the
* picker grows a localized badge slot.
*/
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a WorkBuddy model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Declared sets only: a thinking control is offered exactly when the upstream
* catalog declares a `supportedEfforts` list, and it offers exactly the
* declared values. Rows without a list (the older `{effort, summary}` shape)
* get no control at all — their selectable set is client-side knowledge the
* catalog does not carry (the desktop app differs per model there: GLM-5.2
* gets a thinking control while MiniMax-M3 and Kimi-K2.6 do not, though their
* catalog rows are identical), and another implementation against the same
* upstream (workbuddy2api) gates on the declared set and downgrades
* out-of-set values rather than passing them through, so sending an
* undeclared value risks a 400. Such models never carry `reasoning_effort`
* on the wire; the upstream applies its own default.
* `off` is offered only when the model explicitly reports thinking can be
* disabled (`canDisableThinking === true`).
*/
function reasoningFields(info) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const efforts = reasoning.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: WORKBUDDY_PROVIDER,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens
	};
}
/**
* Assemble the WorkBuddy adapter through the core seam. The provider's
* `getModels` reads the live catalog, and every model's `baseUrl` is
* re-resolved per read so the shim's ephemeral port applies from the first
* snapshot after startup.
*/
function createWorkBuddyAdapter(options) {
	return createBridgeAdapter({
		providerId: WORKBUDDY_PROVIDER,
		displayName: WORKBUDDY_DISPLAY_NAME,
		credentialName: "WorkBuddy OAuth bearer token",
		credentialSource: "WorkBuddy",
		shim: options.shim,
		catalog: options.catalog,
		toModel: (info, baseUrl) => toPiModel(info, baseUrl),
		decorateModelName: (name, info) => withCatalogDisplay(name, info),
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		...options.resolveAttachments === void 0 ? {} : { resolveAttachments: options.resolveAttachments }
	});
}
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
//#region src/core/shim.ts
/**
* The bridge's loopback OpenAI-compatible endpoint, generic over a
* platform driver. The DSH-side pi-ai provider points here; the shim
* authenticates inbound requests with a per-process shared secret, resolves
* the real platform credential through the driver, forwards the raw OpenAI
* request to the driver's upstream, and pipes the answer back.
*
* Protocol ownership: the shim speaks OpenAI on its DSH-facing side only.
* It never inspects or reshapes the platform's wire dialect — outbound
* conversion lives in the driver's {@link BridgeUpstream.chat}, and the
* response body is piped verbatim. A driver whose platform already speaks
* OpenAI SSE therefore needs no stream translation at all.
*
* It binds 127.0.0.1 only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret.
*
* @module dsh-llm-bridge/core/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. The platform credential comes from the
* driver-supplied resolver alone and never from the inbound request.
*/
function createShim(options) {
	const { resolveCredential, upstream, catalog, ownedBy, upstreamLabel } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("bridge shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: ownedBy
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = await resolveCredential();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await upstream.chat(credential, raw, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `${upstreamLabel} ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-llm-bridge: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/drivers/workbuddy/shim.ts
/**
* WorkBuddy driver binding onto the core loopback shim.
*
* The inbound side (hardening, shared secret, SSE pipe) is entirely core.
* The one WorkBuddy-private fact injected here is the outbound request
* conversion: {@link prepareChatBody} forces streaming, flattens
* `tool_choice`, and rewrites `developer` messages before the bytes reach
* the WorkBuddy upstream. No inbound stream translation is needed — the
* WorkBuddy upstream already answers in OpenAI SSE, so the core pipes its
* body verbatim.
*
* @module dsh-llm-bridge/drivers/workbuddy/shim
*/
/**
* Start the WorkBuddy loopback endpoint. Requests carry the shim shared
* secret; the WorkBuddy access token is resolved from the store inside the
* core shim and never reaches pi-ai.
*/
function createWorkBuddyShim(options) {
	const { store, client, catalog, logger } = options;
	return createShim({
		resolveCredential: () => store.resolve(),
		upstream: { chat: (credential, bodyJson, signal) => client.chatStream(credential, prepareChatBody(bodyJson), signal) },
		catalog,
		ownedBy: WORKBUDDY_PROVIDER,
		upstreamLabel: "workbuddy upstream",
		...logger === void 0 ? {} : { logger }
	});
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
//#region src/drivers/workbuddy/status-paths.ts
/** WorkBuddy card contract: Node-free constants and types shared by the
*  host and browser halves. */
/** Plugin-owned status endpoint consumed by its browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-llm-bridge/status";
//#endregion
//#region src/drivers/workbuddy/web-status.ts
/**
* Assemble the card's status document. Sign-in state is read-only; credit is
* a live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document.
*/
async function workBuddyWebStatus(deps) {
	const authStatus = await deps.store.status();
	if (authStatus.state !== "signed-in") return { status: "signed-out" };
	const status = {
		status: "signed-in",
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...authStatus.source === void 0 ? {} : { source: authStatus.source },
		...authStatus.expiresAtMs === void 0 ? {} : { expiresAt: authStatus.expiresAtMs }
	};
	const modelsField = deps.models().filter((model) => model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0).map((model) => {
		const rate = normalizeCredits(model.billing?.credits);
		return {
			id: model.id,
			name: model.name,
			...model.billing?.free === true ? { free: true } : {},
			...model.billing?.badges !== void 0 && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
			...rate === void 0 ? {} : { credits: rate }
		};
	});
	const statusWithModels = modelsField.length > 0 ? {
		...status,
		models: modelsField
	} : status;
	try {
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...statusWithModels,
				credits
			};
		}
	} catch (error) {
		return {
			...statusWithModels,
			creditsError: safeMessage(error)
		};
	}
	return statusWithModels;
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyStatusHandler(deps) {
	return createStatusHandler(() => workBuddyWebStatus(deps));
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	registerStatusRoute(ctx, WORKBUDDY_STATUS_PATH, () => workBuddyWebStatus(deps));
}
//#endregion
//#region src/drivers/workbuddy/plugin.ts
/**
* Settings namespace owning the configuration card.
*
* DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace
* is now a nominal string, validated by the type system where it is used
* rather than at runtime by a function call. The brand is compile-time only,
* so this stays the plain string it always was — every comparison,
* descriptor lookup, and `dsh` config file still sees `'workbuddy'`.
*/
const WORKBUDDY_SETTINGS_NS = "workbuddy";
const Config = z.object({ authFile: z.string().description("WorkBuddy desktop auth file (defaults to the app's own location)") });
/**
* Start the loopback endpoint, register the `workbuddy` provider, and
* refresh the model catalog from the upstream once credentials allow it.
* The static fallback catalog serves from the first moment, so an offline
* upstream never leaves the provider empty.
*/
function applyWorkBuddyPlugin(ctx, config) {
	const client = new WorkBuddyUpstreamClient();
	const store = new WorkBuddyCredentialStore({
		...config.authFile === void 0 ? {} : { desktopPath: config.authFile },
		refresh: (credential) => client.refreshToken(credential)
	});
	const catalog = new WorkBuddyCatalog();
	const shim = createWorkBuddyShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	ctx.inject(["webServer"], (webCtx) => registerWorkBuddyStatusRoute(webCtx, {
		store,
		client,
		models: () => catalog.current()
	}));
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
			setSource(source) {
				current = source;
			},
			onChange() {
				const next = current().authFile;
				store.setDesktopPath(next);
			}
		});
	});
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		shim.close();
		clearHostHeartbeat();
	});
	shim.ready.then(() => {
		if (stopped) return;
		let invalidate;
		try {
			const workbuddy = createWorkBuddyAdapter({
				shim,
				store,
				catalog,
				resolveAttachments: () => ctx.get("attachments")
			});
			invalidate = workbuddy.invalidate;
			let releaseAdapter;
			let releaseDirectory;
			try {
				releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], workbuddy.adapter);
				releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: WORKBUDDY_PROVIDER,
					displayName: WORKBUDDY_DISPLAY_NAME,
					settingsNs: WORKBUDDY_SETTINGS_NS,
					settingsPath: [],
					declared: false
				}]);
			} finally {
				if (releaseAdapter === void 0 || releaseDirectory === void 0) {
					releaseAdapter?.();
					releaseDirectory?.();
				}
			}
			try {
				ctx.effect(() => () => {
					releaseAdapter?.();
					releaseDirectory?.();
				});
			} catch {
				releaseAdapter?.();
				releaseDirectory?.();
			}
			writeHostHeartbeat();
		} catch (error) {
			ctx.logger.error("dsh-llm-bridge: provider registration failed", error);
			return;
		}
		(async () => {
			try {
				const credential = await store.current();
				if (credential === void 0 || stopped) return;
				const models = await client.fetchModels(credential);
				if (stopped) return;
				catalog.set([...models]);
				invalidate?.();
			} catch (error) {
				ctx.logger.warn("dsh-llm-bridge: dynamic model catalog unavailable; serving the static fallback list", error);
			}
		})();
	}).catch((error) => {
		ctx.logger.error("dsh-llm-bridge: loopback endpoint failed to start; provider not registered", error);
	});
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-bridge";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Compose the core mechanisms with the WorkBuddy driver and register the
* `workbuddy` provider. Streaming, tool calls, compaction, and permissions
* stay Harness-owned.
*/
function apply(ctx, config) {
	applyWorkBuddyPlugin(ctx, config);
}
//#endregion
export { Config, FALLBACK_WORKBUDDY_MODELS, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_DISPLAY_NAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STATUS_PATH, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WorkBuddyCatalog, WorkBuddyCredentialStore, WorkBuddyUpstreamClient, apply, applyWorkBuddyPlugin, classifyUpstreamError, clearHostHeartbeat, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, inject, isHeartbeatProcessAlive, name, normalizeCredits, parseWorkBuddyAuth, prepareChatBody, processStartTimeMs, readHostHeartbeat, regionOf, registerWorkBuddyStatusRoute, workBuddyStatusHandler, workBuddyWebStatus, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath };
