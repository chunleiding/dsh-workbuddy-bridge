import { $ as normalizeOrganizationTags, A as translateQoderStream, B as QODER_CLIENT_METADATA, Ct as LOOMY_BASE_URL, D as mapQoderModel, Dt as LOOMY_SESSION_FILENAME, E as classifyQoderError, Et as LOOMY_PROVIDER, F as loadQoderWasm, G as QODER_PROVIDER, H as QODER_DISPLAY_NAME, I as openServerPayload, J as QODER_CREDENTIAL_KEY_LENGTH, K as QODER_SCENE, L as QODER_AGENT_ID, M as QoderCatalog, N as QoderCredentialStore, O as modelKeyOf, Ot as LOOMY_SESSION_FILE_ENV, P as defaultAuthDirectoryCandidates, Q as mergeRefreshOutcome, R as QODER_AUTH_DIR_ENV, S as qoderHostHeartbeatPath, St as parseLoomySession, T as QoderUpstreamClient, Tt as LOOMY_DISPLAY_NAME, U as QODER_GATEWAY_BASE, V as QODER_COSY_VERSION, W as QODER_OPENAPI_BASE, X as epochMsOf, Y as credentialFromUserInfo, Z as isUsableMachineId, _ as defaultDesktopAuthPath, _t as FALLBACK_LOOMY_MODELS, a as writeHostHeartbeat$2, at as clearHostHeartbeat$1, b as QODER_HOST_HEARTBEAT_FILENAME, bt as defaultSessionCandidates, c as normalizeCredits, ct as writeHostHeartbeat, d as FALLBACK_WORKBUDDY_MODELS, dt as processStartTimeMs, et as parseQoderRefreshResponse, f as WorkBuddyCatalog, ft as createStatusHandler, g as defaultDesktopAuthCandidates, gt as originIsLoopback, h as WorkBuddyCredentialStore, ht as hostIsLoopback, i as workbuddyHostHeartbeatPath, it as LOOMY_HOST_HEARTBEAT_FILENAME, j as FALLBACK_QODER_MODELS, k as prepareQoderChatBody, kt as LOOMY_STREAM_IDLE_TIMEOUT_MS, l as prepareChatBody, m as WORKBUDDY_AUTH_FILE_ENV, mt as safeMessage, n as clearHostHeartbeat, nt as runtimeAuthFieldsInput, o as WorkBuddyUpstreamClient, ot as loomyHostHeartbeatPath, p as WORKBUDDY_AUTH_FILENAME, pt as registerStatusRoute, q as QODER_STREAM_IDLE_TIMEOUT_MS, r as readHostHeartbeat, rt as signingUserInfo, s as classifyUpstreamError, t as WORKBUDDY_HOST_HEARTBEAT_FILENAME, tt as qoderCredentialKey, u as regionOf, ut as isHeartbeatProcessAlive, v as parseWorkBuddyAuth, vt as LoomyCatalog, w as writeHostHeartbeat$1, wt as LOOMY_CLIENT_VERSION, x as clearHostHeartbeat$2, xt as defaultSessionPath, y as workbuddyOwnAuthPath, yt as LoomySessionStore, z as QODER_AUTO_MODEL } from "./heartbeat-DfWP6M9M.js";
import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
//#region src/drivers/loomy/adapter.ts
/**
* Map a Loomy model's reasoning declaration into pi-ai's
* `thinkingLevelMap`. Every Loomy chat model declares its selectable effort
* set explicitly, including `none`, so thinking can always be switched off.
*/
function reasoningFields$2(info) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || !reasoning.supports) return { reasoning: false };
	const efforts = reasoning.supportedEfforts;
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: efforts.includes("none") ? "none" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel$2(info, baseUrl) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: LOOMY_PROVIDER,
		baseUrl,
		input: info.supportsImages ? ["text", "image"] : ["text"],
		...reasoningFields$2(info),
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
/** Assemble the Loomy adapter through the core seam. */
function createLoomyAdapter(options) {
	return createBridgeAdapter({
		providerId: LOOMY_PROVIDER,
		displayName: LOOMY_DISPLAY_NAME,
		credentialName: "Loomy session token",
		credentialSource: "Loomy",
		shim: options.shim,
		catalog: options.catalog,
		toModel: (info, baseUrl) => toPiModel$2(info, baseUrl),
		streamIdleTimeoutMs: LOOMY_STREAM_IDLE_TIMEOUT_MS,
		...options.resolveAttachments === void 0 ? {} : { resolveAttachments: options.resolveAttachments }
	});
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
//#region src/drivers/loomy/upstream.ts
/**
* Loomy imodel upstream client. The imodel backend is itself OpenAI
* compatible (`/models`, `/chat/completions`, standard SSE chunks with
* `delta.reasoning_content`), so the wire protocol needs no translation —
* only three Loomy-private facts:
*
* 1. Every request authenticates with BOTH `Authorization: Bearer <session>`
*    and `token: <session>` (one alone is rejected).
* 2. Every chat request must carry a freshly generated W3C `traceparent`
*    header; without it the endpoint hangs until timeout instead of
*    answering with an HTTP error.
* 3. `tool_choice` must be the OpenAI *string* form; the object form
*    (`{type:"auto"}`, which pi-ai emits) returns HTTP 400.
*
* @module dsh-llm-bridge/drivers/loomy/upstream
*/
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Quota/balance failure markers, ASCII lowercase plus the Chinese forms. */
const HARD_QUOTA_MARKERS = [
	"insufficient",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"out of points",
	"no points",
	"points not enough",
	"not enough points",
	"积分不足",
	"额度不足",
	"余额不足",
	"点数不足",
	"积分用完",
	"额度用尽"
];
const EFFORT_VALUES = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh"
];
/** Generate a W3C traceparent: `00-<32hex trace-id>-<16hex span-id>-01`. */
function traceparent() {
	return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
/**
* Headers shared by every request. `ChatId`/`MsgId`/`TurnId` are optional on
* the wire but always sent by the official client, so they are regenerated
* per request here as well.
*/
function commonHeaders(session) {
	return {
		"Accept": "application/json",
		"Content-Type": "application/json",
		"loomy-version": LOOMY_CLIENT_VERSION,
		"traceparent": traceparent(),
		"ChatId": randomUUID(),
		"MsgId": randomUUID(),
		"TurnId": randomUUID(),
		"token": session.session
	};
}
/** Chat headers add the Bearer half of imodel's dual session auth. */
function chatHeaders(session) {
	return {
		...commonHeaders(session),
		"Authorization": `Bearer ${session.session}`
	};
}
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyLoomyError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_QUOTA_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	if (status === 401) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/**
* Normalize an OpenAI chat-completions body for the Loomy upstream: flatten
* `tool_choice` to its string form (the object form returns 400). The
* endpoint natively accepts `role: "developer"`, non-streaming requests, and
* unknown fields, so nothing else is rewritten — the body otherwise passes
* through unchanged.
*/
function prepareLoomyChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/** Rewrite OpenAI `tool_choice` spellings into Loomy's string form. */
function normalizeToolChoice(obj) {
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") return;
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none" || type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			obj["tool_choice"] = name.trim() !== "" ? name.trim() : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
/** Map one raw catalog row; returns undefined for non-chat/unusable rows. */
function mapModel(raw) {
	const id = typeof raw.id === "string" ? raw.id : "";
	if (id === "") return void 0;
	if (raw.type !== void 0 && raw.type !== "chat") return void 0;
	const contextWindow = typeof raw.context_length === "number" ? raw.context_length : 0;
	const maxTokens = typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : 0;
	if (contextWindow <= 0 || maxTokens <= 0) return void 0;
	const caps = typeof raw.capabilities === "object" && raw.capabilities !== null ? raw.capabilities : {};
	const inputModalities = Array.isArray(caps["input_modalities"]) ? caps["input_modalities"] : [];
	const supportsImages = caps["vision"] === true || inputModalities.some((value) => value === "image");
	const reasoningSupported = caps["reasoning"] === true;
	let reasoning;
	if (reasoningSupported) {
		const efforts = Array.isArray(raw.reasoning_efforts) ? raw.reasoning_efforts.filter((value) => typeof value === "string" && EFFORT_VALUES.includes(value)) : [];
		const defaultEffort = typeof raw.default_reasoning_effort === "string" && EFFORT_VALUES.includes(raw.default_reasoning_effort) ? raw.default_reasoning_effort : void 0;
		reasoning = {
			supports: true,
			supportedEfforts: efforts,
			...defaultEffort === void 0 ? {} : { defaultEffort }
		};
	}
	return {
		id,
		name: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
		contextWindow,
		maxTokens,
		supportsImages,
		...reasoning === void 0 ? {} : { reasoning }
	};
}
/**
* Upstream HTTP client for the Loomy imodel backend. One instance serves the
* whole driver; requests take the session explicitly so a desktop-app
* re-login applies on the next call.
*/
var LoomyUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw (SSE) response. */
	async chatStream(session, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${LOOMY_BASE_URL}/chat/completions`, {
				method: "POST",
				headers: chatHeaders(session),
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
			kind: classifyLoomyError(response.status, text),
			message: text
		};
	}
	/** GET the model catalog; chat models only, normalized for the adapter. */
	async fetchModels(session) {
		const response = await fetch(`${LOOMY_BASE_URL}/models`, {
			headers: commonHeaders(session),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`loomy models ${classifyLoomyError(response.status, text)} (http ${response.status}): ${text.slice(0, 160)}`);
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`loomy models returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
		}
		if (typeof parsed !== "object" || parsed === null) throw new Error(`loomy models returned an unexpected document (http ${response.status})`);
		const rawModels = parsed["data"];
		if (!Array.isArray(rawModels)) throw new Error("loomy model catalog carries no data[] list");
		const models = rawModels.map((raw) => typeof raw === "object" && raw !== null ? mapModel(raw) : void 0).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("loomy model catalog resolved to an empty list");
		return models;
	}
};
//#endregion
//#region src/drivers/loomy/shim.ts
/**
* Loomy driver binding onto the core loopback shim.
*
* The inbound side (hardening, shared secret, SSE pipe) is entirely core.
* The only Loomy-private outbound conversion is flattening the OpenAI
* `tool_choice` object to its string form; dual session headers and the
* per-request `traceparent` are added further down in the Loomy upstream
* client. No stream translation exists — imodel already speaks OpenAI SSE.
*
* @module dsh-llm-bridge/drivers/loomy/shim
*/
/** Start the Loomy loopback endpoint. */
function createLoomyShim(options) {
	const { store, client, catalog, logger } = options;
	return createShim({
		resolveCredential: () => store.resolve(),
		upstream: { chat: (session, bodyJson, signal) => client.chatStream(session, prepareLoomyChatBody(bodyJson), signal) },
		catalog,
		ownedBy: LOOMY_PROVIDER,
		upstreamLabel: "loomy upstream",
		...logger === void 0 ? {} : { logger }
	});
}
//#endregion
//#region src/drivers/loomy/status-paths.ts
/** Plugin-owned status endpoint consumed by the Loomy browser card. */
const LOOMY_STATUS_PATH = "/plugins/dsh-llm-bridge/loomy/status";
//#endregion
//#region src/drivers/loomy/web-status.ts
/** Assemble the card's status document. */
async function loomyWebStatus(deps) {
	const status = await deps.store.status();
	if (status.state !== "signed-in") return { status: "signed-out" };
	return {
		status: "signed-in",
		...status.updatedAtMs === void 0 ? {} : { updatedAt: status.updatedAtMs }
	};
}
/** The status route's request handler, extracted so tests can mount it bare. */
function loomyStatusHandler(deps) {
	return createStatusHandler(() => loomyWebStatus(deps));
}
/** Mount the GET status route on an optional webServer context. */
function registerLoomyStatusRoute(ctx, deps) {
	registerStatusRoute(ctx, LOOMY_STATUS_PATH, () => loomyWebStatus(deps));
}
//#endregion
//#region src/drivers/loomy/plugin.ts
/** Settings namespace owning the Loomy configuration card. */
const LOOMY_SETTINGS_NS = "loomy";
const Config$1 = z.object({ sessionFile: z.string().description("Loomy desktop auth-session.json file (defaults to the app's own location)") });
/**
* Start the loopback endpoint, register the `loomy` provider, and refresh
* the model catalog from imodel once a session is available. The static
* fallback catalog serves from the first moment, so an offline upstream
* never leaves the provider empty.
*/
function applyLoomyPlugin(ctx, config) {
	const client = new LoomyUpstreamClient();
	const store = new LoomySessionStore({ ...config.sessionFile === void 0 ? {} : { sessionFile: config.sessionFile } });
	const catalog = new LoomyCatalog();
	const shim = createLoomyShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	ctx.inject(["webServer"], (webCtx) => registerLoomyStatusRoute(webCtx, { store }));
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, LOOMY_SETTINGS_NS, Config$1, config, {
			setSource(source) {
				current = source;
			},
			onChange() {
				store.setSessionPath(current().sessionFile);
			}
		});
	});
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		shim.close();
		clearHostHeartbeat$1();
	});
	shim.ready.then(() => {
		if (stopped) return;
		let invalidate;
		try {
			const loomy = createLoomyAdapter({
				shim,
				store,
				catalog,
				resolveAttachments: () => ctx.get("attachments")
			});
			invalidate = loomy.invalidate;
			let releaseAdapter;
			let releaseDirectory;
			try {
				releaseAdapter = ctx.llm.registerAdapter([LOOMY_PROVIDER], loomy.adapter);
				releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: LOOMY_PROVIDER,
					displayName: LOOMY_DISPLAY_NAME,
					settingsNs: LOOMY_SETTINGS_NS,
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
			ctx.logger.error("dsh-llm-bridge: loomy provider registration failed", error);
			return;
		}
		(async () => {
			try {
				const session = await store.resolve().catch(() => void 0);
				if (session === void 0 || stopped) return;
				const models = await client.fetchModels(session);
				if (stopped) return;
				catalog.set([...models]);
				invalidate?.();
			} catch (error) {
				ctx.logger.warn("dsh-llm-bridge: loomy dynamic model catalog unavailable; serving the static fallback list", error);
			}
		})();
	}).catch((error) => {
		ctx.logger.error("dsh-llm-bridge: loomy loopback endpoint failed to start; provider not registered", error);
	});
}
//#endregion
//#region src/drivers/qoder/adapter.ts
/** Separator between a model's name and its offer suffix in the picker. */
const SUFFIX_SEPARATOR = " · ";
/**
* The picker suffix: the price multiplier followed by the catalog's promo
* badges, or undefined when the row carries neither.
*
* The badges are the catalog's own Chinese spellings, as with the WorkBuddy
* driver — the host seam has no locale service, so whatever string is produced
* here is rendered verbatim in every UI language.
*/
function displaySuffix$1(info) {
	const parts = [info.billing?.credits, ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(SUFFIX_SEPARATOR);
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay$1(name, info) {
	const suffix = displaySuffix$1(info);
	return suffix === void 0 ? name : `${name}${SUFFIX_SEPARATOR}${suffix}`;
}
/**
* Map a Qoder model's declared thinking ladder into pi-ai's
* `thinkingLevelMap`.
*
* `thinkingLevelMap` values are what pi-ai puts on the wire as
* `reasoning_effort`, so only spellings the catalog actually declares are
* mapped: a declared level is offered, an undeclared one is `null`, and the
* selector shows exactly the ladder the Qoder app itself offers for that model.
*
* `off` is deliberately always `null`, even for rows whose `thinking_config`
* declares a `disabled` state. The endpoint accepts **any** string for
* `reasoning_effort` (verified: meaningless values return HTTP 200 too), so
* there is no spelling whose "thinking off" meaning could be confirmed — and a
* switch that appears to work while the server silently keeps thinking is worse
* than no switch. `off: null` means pi-ai sends no `reasoning_effort` at all
* unless the user picks a level, which leaves the server on its own default.
*
* Rows with no declared ladder (`supportedEfforts` absent) describe reasoning
* models whose selectable set is client-side knowledge the catalog does not
* carry; they get no control at all rather than a guessed one.
*/
function reasoningFields$1(info) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const efforts = reasoning.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return { reasoning: false };
	const has = (effort) => efforts.includes(effort);
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: has("low") ? "low" : null,
			medium: has("medium") ? "medium" : null,
			high: has("high") ? "high" : null,
			xhigh: has("xhigh") ? "xhigh" : null,
			max: has("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel$1(info, baseUrl) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: QODER_PROVIDER,
		baseUrl,
		input: info.supportsImages ? ["text", "image"] : ["text"],
		...reasoningFields$1(info),
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
* Assemble the Qoder adapter through the core seam. The provider's
* `getModels` reads the live catalog, and every model's `baseUrl` is
* re-resolved per read so the shim's ephemeral port applies from the first
* snapshot after startup.
*/
function createQoderAdapter(options) {
	return createBridgeAdapter({
		providerId: QODER_PROVIDER,
		displayName: QODER_DISPLAY_NAME,
		credentialName: "Qoder device token",
		credentialSource: "Qoder",
		shim: options.shim,
		catalog: options.catalog,
		toModel: (info, baseUrl) => toPiModel$1(info, baseUrl),
		decorateModelName: (name, info) => withCatalogDisplay$1(name, info),
		streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
		...options.resolveAttachments === void 0 ? {} : { resolveAttachments: options.resolveAttachments }
	});
}
//#endregion
//#region src/drivers/qoder/shim.ts
/**
* Qoder driver binding onto the core loopback shim.
*
* The inbound side (hardening, shared secret, SSE pipe) is entirely core. Two
* Qoder-private facts are injected here:
*
* - the outbound request normalization ({@link prepareQoderChatBody}), and
* - the upstream call, whose response is Qoder's enveloped SSE already
*   translated into ordinary OpenAI frames by the upstream client.
*
* From the shim's point of view the platform therefore looks like any other
* OpenAI SSE upstream: it pipes the body verbatim and never learns that the
* frames were unwrapped.
*
* @module dsh-llm-bridge/drivers/qoder/shim
*/
/**
* Start the Qoder loopback endpoint. Requests carry the shim shared secret;
* the Qoder device token is resolved from the store inside the core shim and
* never reaches pi-ai.
*/
function createQoderShim(options) {
	const { store, client, catalog, logger } = options;
	return createShim({
		resolveCredential: () => store.resolve(),
		upstream: { chat: (credential, bodyJson, signal) => {
			const selection = resolveQoderModelSelection(bodyJson, catalog);
			if (!selection.ok) return Promise.resolve(selection.result);
			return client.chatStream(credential, prepareQoderChatBody(selection.bodyJson), signal);
		} },
		catalog,
		ownedBy: QODER_PROVIDER,
		upstreamLabel: "qoder upstream",
		...logger === void 0 ? {} : { logger }
	});
}
/**
* Resolve the model a chat body actually targets against the account's live
* catalog, and reject selections the account cannot drive.
*
* The Qoder gateway silently downgrades a request for a disabled model to its
* hard default (observed answering as "Qwen3.5") rather than erroring — which
* is exactly the mis-routing a user reports. We intercept it here:
*
* - an `auto`/missing selection resolves to the catalog's default *enabled*
*   model, so the host's "Auto" choice lands on a real model instead of the
*   silent downgrade; and
* - a selection that is absent from the post-refresh catalog but was a known
*   catalog id is reported as unavailable, instead of being let through to a
*   misleading answer from the wrong model.
*
* The membership test doubles as the refresh detector: before the live catalog
* loads, `catalog.current()` is the static fallback (which lists every known
* id), so every known selection passes; after the live refresh drops
* `enable: false` rows, a disabled selection is no longer present and is
* rejected.
*/
function resolveQoderModelSelection(bodyJson, catalog) {
	let body;
	try {
		body = JSON.parse(bodyJson);
	} catch {
		return {
			ok: true,
			bodyJson
		};
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return {
		ok: true,
		bodyJson
	};
	const document = body;
	let key = modelKeyOf(bodyJson);
	let rewrote = false;
	if (key === "auto" || key === "") {
		const def = catalog.current().find((m) => m.isDefault);
		if (def !== void 0) {
			document["model"] = def.id;
			key = def.id;
			rewrote = true;
		}
	}
	const live = catalog.current();
	if (!live.some((m) => m.id === key)) {
		const known = FALLBACK_QODER_MODELS.some((m) => m.id === key);
		const available = live.map((m) => m.id).join(", ");
		return {
			ok: false,
			result: {
				ok: false,
				status: 400,
				kind: "client",
				message: known ? `qoder: model "${key}" is not available on your Qoder account (it is disabled or requires a subscription). Available models: ${available || "(none)"}` : `qoder: unknown model "${key}"`
			}
		};
	}
	return {
		ok: true,
		bodyJson: rewrote ? JSON.stringify(document) : bodyJson
	};
}
//#endregion
//#region src/drivers/qoder/status-paths.ts
/** Plugin-owned status endpoint consumed by the Qoder browser card. */
const QODER_STATUS_PATH = "/plugins/dsh-llm-bridge/qoder/status";
//#endregion
//#region src/drivers/qoder/web-status.ts
/** Assemble the card's status document. */
async function qoderWebStatus(deps) {
	const status = await deps.store.status();
	if (status.state !== "signed-in") return { status: "signed-out" };
	const models = deps.models().map((model) => ({
		id: model.id,
		name: model.name,
		...model.billing === void 0 ? {} : { free: model.billing.free },
		...model.billing?.badges === void 0 ? {} : { badges: model.billing.badges },
		...model.billing?.credits === void 0 ? {} : { credits: model.billing.credits }
	}));
	return {
		status: "signed-in",
		...status.nickname === void 0 ? {} : { nickname: status.nickname },
		...status.expiresAtMs === void 0 ? {} : { expiresAt: status.expiresAtMs },
		...models.length === 0 ? {} : { models }
	};
}
/** The status route's request handler, extracted so tests can mount it bare. */
function qoderStatusHandler(deps) {
	return createStatusHandler(() => qoderWebStatus(deps));
}
/** Mount the GET status route on an optional webServer context. */
function registerQoderStatusRoute(ctx, deps) {
	registerStatusRoute(ctx, QODER_STATUS_PATH, () => qoderWebStatus(deps));
}
//#endregion
//#region src/drivers/qoder/plugin.ts
/** Settings namespace owning the Qoder configuration card. */
const QODER_SETTINGS_NS = "qoder";
const Config$2 = z.object({
	authDir: z.string().description("Qoder auth directory (defaults to the app's own location)"),
	writeBack: z.boolean().description("Write a rotated refresh token back into the Qoder app's credential file")
});
/**
* Start the loopback endpoint, register the `qoder` provider, and refresh the
* model catalog from the upstream once a credential is available. The static
* fallback catalog serves from the first moment, so an offline upstream never
* leaves the provider empty.
*/
function applyQoderPlugin(ctx, config) {
	const client = new QoderUpstreamClient({ logger: ctx.logger });
	const store = new QoderCredentialStore({
		...config.authDir === void 0 ? {} : { authDir: config.authDir },
		...config.writeBack === void 0 ? {} : { writeBack: config.writeBack },
		refresh: (credential) => client.refreshToken(credential)
	});
	const catalog = new QoderCatalog();
	const shim = createQoderShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	ctx.inject(["webServer"], (webCtx) => registerQoderStatusRoute(webCtx, {
		store,
		models: () => catalog.current()
	}));
	let current = () => config;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, QODER_SETTINGS_NS, Config$2, config, {
			setSource(source) {
				current = source;
			},
			onChange() {
				store.setAuthDir(current().authDir);
			}
		});
	});
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		shim.close();
		clearHostHeartbeat$2();
	});
	shim.ready.then(() => {
		if (stopped) return;
		let invalidate;
		try {
			const qoder = createQoderAdapter({
				shim,
				store,
				catalog,
				resolveAttachments: () => ctx.get("attachments")
			});
			invalidate = qoder.invalidate;
			let releaseAdapter;
			let releaseDirectory;
			try {
				releaseAdapter = ctx.llm.registerAdapter([QODER_PROVIDER], qoder.adapter);
				releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: QODER_PROVIDER,
					displayName: QODER_DISPLAY_NAME,
					settingsNs: QODER_SETTINGS_NS,
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
			writeHostHeartbeat$1();
		} catch (error) {
			ctx.logger.error("dsh-llm-bridge: qoder provider registration failed", error);
			return;
		}
		(async () => {
			try {
				const credential = await store.current();
				if (credential === void 0 || stopped) return;
				await client.discoverEndpoints(credential);
				if (stopped) return;
				const models = await client.fetchModels(credential);
				if (stopped) return;
				catalog.set([...models]);
				invalidate?.();
			} catch (error) {
				ctx.logger.warn("dsh-llm-bridge: qoder dynamic model catalog unavailable; serving the static fallback list", error);
			}
		})();
	}).catch((error) => {
		ctx.logger.error("dsh-llm-bridge: qoder loopback endpoint failed to start; provider not registered", error);
	});
}
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
//#region src/drivers/workbuddy/status-paths.ts
/** Plugin-owned status endpoint consumed by the WorkBuddy browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-llm-bridge/workbuddy/status";
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
const Config$3 = z.object({ authFile: z.string().description("WorkBuddy desktop auth file (defaults to the app's own location)") });
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
		settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config$3, config, {
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
			writeHostHeartbeat$2();
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
const Config = z.object({
	workbuddy: Config$3,
	loomy: Config$1,
	qoder: Config$2
});
/** Stable Cordis plugin name. */
const name = "llm-bridge";
/** The model registry required before any provider can register. */
const inject = ["llm"];
/**
* Compose the core mechanisms with every shipped driver and register their
* providers (`workbuddy`, `loomy`, `qoder`). Streaming, tool calls,
* compaction, and permissions stay Harness-owned.
*/
function apply(ctx, config) {
	applyWorkBuddyPlugin(ctx, config.workbuddy ?? {});
	applyLoomyPlugin(ctx, config.loomy ?? {});
	applyQoderPlugin(ctx, config.qoder ?? {});
}
//#endregion
export { Config, FALLBACK_LOOMY_MODELS, FALLBACK_QODER_MODELS, FALLBACK_WORKBUDDY_MODELS, LOOMY_DISPLAY_NAME, LOOMY_HOST_HEARTBEAT_FILENAME, LOOMY_PROVIDER, LOOMY_SESSION_FILENAME, LOOMY_SESSION_FILE_ENV, LOOMY_SETTINGS_NS, LOOMY_STATUS_PATH, LOOMY_STREAM_IDLE_TIMEOUT_MS, LoomyCatalog, Config$1 as LoomyDriverConfig, LoomySessionStore, LoomyUpstreamClient, QODER_AGENT_ID, QODER_AUTH_DIR_ENV, QODER_AUTO_MODEL, QODER_CLIENT_METADATA, QODER_COSY_VERSION, QODER_CREDENTIAL_KEY_LENGTH, QODER_DISPLAY_NAME, QODER_GATEWAY_BASE, QODER_HOST_HEARTBEAT_FILENAME, QODER_OPENAPI_BASE, QODER_PROVIDER, QODER_SCENE, QODER_SETTINGS_NS, QODER_STATUS_PATH, QODER_STREAM_IDLE_TIMEOUT_MS, QoderCatalog, QoderCredentialStore, Config$2 as QoderDriverConfig, QoderUpstreamClient, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_DISPLAY_NAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STATUS_PATH, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WorkBuddyCatalog, WorkBuddyCredentialStore, WorkBuddyUpstreamClient, apply, applyLoomyPlugin, applyQoderPlugin, applyWorkBuddyPlugin, classifyLoomyError, classifyQoderError, classifyUpstreamError, clearHostHeartbeat, createLoomyAdapter, createLoomyShim, createQoderAdapter, createQoderShim, createWorkBuddyAdapter, createWorkBuddyShim, credentialFromUserInfo, defaultAuthDirectoryCandidates, defaultDesktopAuthCandidates, defaultDesktopAuthPath, defaultSessionCandidates, defaultSessionPath, epochMsOf, inject, isHeartbeatProcessAlive, isUsableMachineId, loadQoderWasm, loomyHostHeartbeatPath, loomyStatusHandler, loomyWebStatus, mapQoderModel, mergeRefreshOutcome, modelKeyOf, name, normalizeCredits, normalizeOrganizationTags, openServerPayload, parseLoomySession, parseQoderRefreshResponse, parseWorkBuddyAuth, prepareChatBody, prepareLoomyChatBody, prepareQoderChatBody, processStartTimeMs, qoderCredentialKey, qoderHostHeartbeatPath, qoderStatusHandler, qoderWebStatus, readHostHeartbeat, regionOf, registerLoomyStatusRoute, registerQoderStatusRoute, registerWorkBuddyStatusRoute, runtimeAuthFieldsInput, signingUserInfo, translateQoderStream, workBuddyStatusHandler, workBuddyWebStatus, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath };
