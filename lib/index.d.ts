import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/drivers/workbuddy/plugin.d.ts
/**
 * Settings namespace owning the configuration card.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace
 * is now a nominal string, validated by the type system where it is used
 * rather than at runtime by a function call. The brand is compile-time only,
 * so this stays the plain string it always was — every comparison,
 * descriptor lookup, and `dsh` config file still sees `'workbuddy'`.
 */
declare const WORKBUDDY_SETTINGS_NS: SettingsNamespace;
/** WorkBuddy driver configuration. */
interface Config$2 {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string;
}
declare const Config$2: z<Config$2>;
/**
 * Start the loopback endpoint, register the `workbuddy` provider, and
 * refresh the model catalog from the upstream once credentials allow it.
 * The static fallback catalog serves from the first moment, so an offline
 * upstream never leaves the provider empty.
 */
declare function applyWorkBuddyPlugin(ctx: Context, config: Config$2): void;
//#endregion
//#region src/drivers/loomy/plugin.d.ts
/** Settings namespace owning the Loomy configuration card. */
declare const LOOMY_SETTINGS_NS: SettingsNamespace;
/** Loomy driver configuration. */
interface Config$1 {
  /** Explicit Loomy session-file path, overriding env and platform defaults. */
  sessionFile?: string;
}
declare const Config$1: z<Config$1>;
/**
 * Start the loopback endpoint, register the `loomy` provider, and refresh
 * the model catalog from imodel once a session is available. The static
 * fallback catalog serves from the first moment, so an offline upstream
 * never leaves the provider empty.
 */
declare function applyLoomyPlugin(ctx: Context, config: Config$1): void;
//#endregion
//#region src/core/catalog.d.ts
/**
 * Generic mutable model catalog: seeded by the driver with its static
 * fallback list, replaced wholesale once the platform's dynamic answer
 * loads. The core never interprets an entry — only drivers know a model
 * record's shape; the shim and adapter constrain it to `{ id }`.
 *
 * @module dsh-llm-bridge/core/catalog
 */
/** A read-only list of model entries that can be replaced atomically. */
declare class Catalog<M> {
  private models;
  constructor(initial: readonly M[]);
  /** Current entries; the fallback list until an upstream answer lands. */
  current(): readonly M[];
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly M[]): void;
}
//#endregion
//#region src/core/types.d.ts
/**
 * Minimal seams shared by the bridge core and every platform driver.
 *
 * These are the only types a driver has to satisfy to plug a closed agent's
 * native protocol into the loopback shim. They are deliberately tiny: the
 * core owns the mechanisms (credential lifecycle, catalog, loopback, SSE
 * pipe, DSH adapter, heartbeat, status route); every platform fact lives in
 * the driver.
 *
 * @module dsh-llm-bridge/core/types
 */
/**
 * Upstream failure classes the shim maps onto distinct HTTP answers.
 *
 * The class set is core because the shim needs one stable
 * kind-to-HTTP-status mapping; deciding *which* class a platform response
 * belongs to is the driver's job (each platform speaks its own error
 * dialect).
 */
type BridgeErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/**
 * One chat round either carries the platform's raw successful response
 * stream (the shim pipes it verbatim — a driver whose platform already
 * speaks OpenAI SSE needs no translation) or a classified failure.
 *
 * Only the response body is read by the core, so any fetch-shaped
 * `Response` satisfies the success variant structurally.
 */
type BridgeChatResult = {
  ok: true;
  response: {
    body: ReadableStream<Uint8Array> | null;
  };
} | {
  ok: false;
  status: number;
  kind: BridgeErrorKind;
  message: string;
};
//#endregion
//#region src/core/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface BridgeShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself through the driver.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
//#endregion
//#region src/core/adapter.d.ts
/** What {@link createBridgeAdapter} hands back. */
interface BridgeAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
//#endregion
//#region src/drivers/workbuddy/upstream.d.ts
/** WorkBuddy region selected by the credential's login domain. */
type WorkBuddyRegion = 'cn' | 'global';
/**
 * Upstream failure classes the shim maps onto distinct HTTP answers. This
 * is the core error taxonomy; WorkBuddy just classifies its responses into
 * it.
 */
type UpstreamErrorKind = BridgeErrorKind;
/** One CLI-usable model as the upstream catalog describes it. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean;
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire
   * effort values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto
   * pi-ai's thinking levels, and the supported set decides which levels the
   * DSH model selector offers.
   */
  reasoning?: WorkBuddyModelReasoning;
  /**
   * Billing convenience metadata: the credits multiplier string the upstream
   * reports (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000` or `badge:夜间折扣:#1E90FF`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a
   * language-neutral display form (`x0.79`) that reads the same in every UI
   * language. The raw upstream string (which may spell `x0.79 credits`) stays
   * on {@link WorkBuddyModelBilling.credits} for diagnostics.
   */
  billing?: WorkBuddyModelBilling;
}
/** Reasoning metadata the upstream catalog declares for one model. */
interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean;
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort;
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean;
}
/** The concrete effort spellings WorkBuddy exposes on the wire. */
type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Billing convenience metadata reported for one model. */
interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
}
/** One billing package and its remaining credit. */
interface WorkBuddyCreditAccount {
  packageName: string;
  remain: number;
  size: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  accounts: readonly WorkBuddyCreditAccount[];
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyChatResult = BridgeChatResult;
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
declare function normalizeCredits(credits: string | undefined): string | undefined;
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
declare function regionOf(domain: string): WorkBuddyRegion;
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
declare function prepareChatBody(source: string): string;
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
declare class WorkBuddyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  /** GET the personal model catalog and keep the `cli` agent's models only. */
  fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]>;
  /** POST the billing endpoint for the aggregated remaining credit. */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
}
//#endregion
//#region src/drivers/workbuddy/auth.d.ts
/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh';
}
/** Read-only sign-in summary for status and doctor output. */
interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
}
/** Constructor options; only {@link refresh} is required. */
interface WorkBuddyStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /** Explicit driver-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
}
/** Basename of the driver-owned credential copy inside the Harness home. */
declare const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Driver-owned copy path inside the Harness home. */
declare function workbuddyOwnAuthPath(): string;
/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
 * those same Windows locations through its mounted Windows profile before the
 * native Linux location.
 */
declare function defaultDesktopAuthCandidates(): string[];
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
declare function defaultDesktopAuthPath(): string | undefined;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
declare function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined;
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
declare class WorkBuddyCredentialStore {
  private readonly refresh;
  private readonly refresher;
  private readonly ownPath;
  private desktopPathOverride;
  constructor(options: WorkBuddyStoreOptions);
  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates;
  private resolveDesktopPath;
  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /** The driver-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<WorkBuddyCredential | undefined>;
  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  resolve(): Promise<WorkBuddyCredential>;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<WorkBuddyAuthStatus>;
  /** Remove the driver-owned copy; the desktop file is untouched. */
  logout(): Promise<void>;
  /**
   * Perform the WorkBuddy refresh for one credential and persist the
   * outcome in the owned copy. The no-refresh-token short-circuit and the
   * error wording (including the wrapped upstream cause) are exactly what
   * the pre-refactor store produced; the core refresher adds the
   * still-valid fallback around this call.
   */
  private refreshCredential;
  private saveOwn;
  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   */
  private readDesktop;
  private readOwn;
  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  desktopFilePresent(): Promise<boolean>;
}
//#endregion
//#region src/drivers/workbuddy/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyModelInfo = WorkBuddyUpstreamModel;
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
declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/**
 * Mutable WorkBuddy catalog seeded with the fallback roster; shared by the
 * shim's `/v1/models` and the adapter.
 */
declare class WorkBuddyCatalog extends Catalog<WorkBuddyModelInfo> {
  constructor();
}
//#endregion
//#region src/drivers/workbuddy/meta.d.ts
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
declare const WORKBUDDY_PROVIDER = "workbuddy";
/** Human-facing provider name in the DSH model pickers. */
declare const WORKBUDDY_DISPLAY_NAME = "WorkBuddy";
/** Provider idle ceiling while one stream read is outstanding. */
declare const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300000;
//#endregion
//#region src/drivers/workbuddy/adapter.d.ts
/** Constructor dependencies. */
interface WorkBuddyAdapterOptions {
  shim: BridgeShim;
  /**
   * Credential store. The core adapter authenticates via the shim secret,
   * so this is not read on the request path; it remains part of the
   * driver's assembly surface for parity and future use.
   */
  store: WorkBuddyCredentialStore;
  catalog: WorkBuddyCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
}
/** What {@link createWorkBuddyAdapter} hands back. */
type WorkBuddyAdapter = BridgeAdapter;
/**
 * Assemble the WorkBuddy adapter through the core seam. The provider's
 * `getModels` reads the live catalog, and every model's `baseUrl` is
 * re-resolved per read so the shim's ephemeral port applies from the first
 * snapshot after startup.
 */
declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/drivers/workbuddy/shim.d.ts
/** What the plugin needs from a running shim. */
type WorkBuddyShim = BridgeShim;
/** Constructor dependencies (unchanged shape from the pre-refactor driver). */
interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore;
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
}
/**
 * Start the WorkBuddy loopback endpoint. Requests carry the shim shared
 * secret; the WorkBuddy access token is resolved from the store inside the
 * core shim and never reaches pi-ai.
 */
declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/core/heartbeat.d.ts
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
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** On-disk shape of the heartbeat. */
interface HostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  /** Package marker of the bundle that wrote the file, validated on read. */
  package: string;
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
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
declare function processStartTimeMs(pid: number): number | undefined;
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
declare function isHeartbeatProcessAlive(heartbeat: HostHeartbeat): boolean;
//#endregion
//#region src/drivers/workbuddy/heartbeat.d.ts
/** Basename of the host heartbeat file inside the Harness home. */
declare const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
/** On-disk shape of the heartbeat. */
type WorkBuddyHostHeartbeat = HostHeartbeat;
/** Absolute path of the host heartbeat file. */
declare const workbuddyHostHeartbeatPath: () => string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare const clearHostHeartbeat: () => Promise<void>;
/** Read and validate the heartbeat; `undefined` when absent or malformed. */
declare const readHostHeartbeat: () => Promise<HostHeartbeat | undefined>;
//#endregion
//#region src/core/status-types.d.ts
/**
 * Generic, node-free status contract shared by every driver's host status
 * route and its browser card.
 *
 * The shape is deliberately the common subset of "signed in / signed out,
 * optional quota, optional promo-model badges" — drivers omit whatever their
 * platform does not expose (for example a platform with no balance endpoint
 * simply never sets `credits`). A driver with genuinely different
 * information renders it through its own card instead of stretching this
 * type.
 *
 * @module dsh-llm-bridge/core/status-types
 */
/** One quota package and its remaining amount. */
interface DriverWebCreditAccount {
  packageName: string;
  remain: number;
  size: number;
}
/** Aggregated quota answer rendered by the plugin card. */
interface DriverWebCredits {
  total: number;
  accounts: readonly DriverWebCreditAccount[];
}
/** Billing/offer facts for one model, rendered as card badges. */
interface DriverWebModelBadge {
  id: string;
  name: string;
  /** Whether the model is currently free. */
  free?: boolean;
  /** Promotional badges in the platform's own spelling. */
  badges?: readonly string[];
  /** Rate/multiplier in a language-neutral display form, e.g. `x0.79`. */
  credits?: string;
}
/** The JSON document any driver status card renders. */
type DriverWebStatus = {
  status: 'signed-out';
} | {
  status: 'signed-in';
  /** Optional account label (never carry secrets or raw PII like phone numbers). */
  nickname?: string;
  /** Access-credential expiry, epoch milliseconds. */
  expiresAt?: number;
  /** Session-state refresh time, epoch milliseconds (platforms without expiring tokens). */
  updatedAt?: number;
  credits?: DriverWebCredits;
  creditsError?: string;
  /** Offer facts for the models the driver serves. */
  models?: readonly DriverWebModelBadge[];
} | {
  status: 'error';
  message: string;
};
//#endregion
//#region src/drivers/workbuddy/status-paths.d.ts
/** Plugin-owned status endpoint consumed by the WorkBuddy browser half. */
declare const WORKBUDDY_STATUS_PATH = "/plugins/dsh-llm-bridge/workbuddy/status";
/** One billing package and its remaining credit. */
interface WorkBuddyWebCreditAccount {
  packageName: string;
  remain: number;
  size: number;
}
/** Aggregated credit answer rendered by the plugin card. */
interface WorkBuddyWebCredits {
  total: number;
  accounts: readonly WorkBuddyWebCreditAccount[];
}
/** Billing convenience facts for one model, rendered as card badges. */
interface WorkBuddyWebModelBadge {
  id: string;
  name: string;
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean;
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[];
  /** Credits multiplier in display form, e.g. `x0.79`. */
  credits?: string;
}
/** The JSON document the WorkBuddy plugin card renders. */
type WorkBuddyWebStatus = {
  status: 'signed-out';
} | {
  status: 'signed-in';
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
  expiresAt?: number;
  credits?: WorkBuddyWebCredits;
  creditsError?: string;
  models?: readonly WorkBuddyWebModelBadge[];
} | {
  status: 'error';
  message: string;
};
//#endregion
//#region src/drivers/workbuddy/web-status.d.ts
/** Constructor dependencies. */
interface WorkBuddyStatusRouteOptions {
  store: WorkBuddyCredentialStore;
  client: Pick<WorkBuddyUpstreamClient, 'fetchCredits'>;
  /** Resolve the current model catalog for free/badge display. */
  models: () => readonly WorkBuddyModelInfo[];
}
/**
 * Assemble the card's status document. Sign-in state is read-only; credit is
 * a live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
declare function workBuddyWebStatus(deps: WorkBuddyStatusRouteOptions): Promise<WorkBuddyWebStatus>;
/** The status route's request handler, extracted so tests can mount it on a bare server. */
declare function workBuddyStatusHandler(deps: WorkBuddyStatusRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** Mount the GET status route on an optional webServer context. */
declare function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void;
//#endregion
//#region src/drivers/loomy/meta.d.ts
/**
 * Loomy provider metadata shared across the driver's adapter, shim,
 * upstream, and DSH plugin registration.
 *
 * @module dsh-llm-bridge/drivers/loomy/meta
 */
/** Provider route this driver owns. */
declare const LOOMY_PROVIDER = "loomy";
/** Human-facing provider name in the DSH model pickers. */
declare const LOOMY_DISPLAY_NAME = "Loomy";
/** Provider idle ceiling while one stream read is outstanding. */
declare const LOOMY_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Basename of the Loomy desktop app's session file. */
declare const LOOMY_SESSION_FILENAME = "auth-session.json";
/** Env variable that overrides the session-file location. */
declare const LOOMY_SESSION_FILE_ENV = "LOOMY_SESSION_FILE";
//#endregion
//#region src/drivers/loomy/auth.d.ts
/** Normalized Loomy credential; only the session string and its refresh time. */
interface LoomySession {
  /** The bearer/token session value (32-hex in current builds). */
  session: string;
  /** Epoch milliseconds the desktop app last refreshed the sign-in. */
  updatedAtMs?: number;
}
/** Read-only sign-in summary for status and doctor output. */
interface LoomyAuthStatus {
  state: 'signed-in' | 'signed-out';
  updatedAtMs?: number;
}
/**
 * Platform-default candidates for the Loomy desktop app's session file, in
 * probe order. Windows probes Local then Roaming AppData; WSL probes the
 * mounted Windows profile first.
 */
declare function defaultSessionCandidates(): string[];
/** First platform-default candidate; see {@link defaultSessionCandidates}. */
declare function defaultSessionPath(): string | undefined;
/**
 * Parse a Loomy session document. Only `session` and `updatedAt` are read;
 * `phone` and any other PII are deliberately ignored.
 */
declare function parseLoomySession(text: string): LoomySession | undefined;
/**
 * Read-only Loomy session store. The session is long-lived and refreshed by
 * the desktop app itself, so this store only resolves the configured file —
 * no refresh lifecycle, no plugin-owned copy, no writes.
 */
declare class LoomySessionStore {
  private pathOverride;
  constructor(options?: {
    sessionFile?: string;
  });
  /**
   * Configuration precedence for the session file: the plugin's configured
   * path, then the environment variable, then platform defaults.
   */
  private resolveCandidates;
  private resolvePath;
  /** Repoint the session file; a settings change applies on the next read. */
  setSessionPath(path: string | undefined): void;
  /** The resolved session-file path, for diagnostics. */
  sessionFilePath(): string | undefined;
  /** Read and parse the first session-file candidate that exists. */
  private readSessionFile;
  /** The credential to put on the wire; re-reads the file on every call. */
  resolve(): Promise<LoomySession>;
  /** Read-only sign-in summary; never throws. */
  status(): Promise<LoomyAuthStatus>;
  /** Loomy owns no plugin-side credential file, so logout is a no-op. */
  logout(): Promise<void>;
  /** Whether any session-file candidate exists as a regular file; diagnostics only. */
  sessionFilePresent(): Promise<boolean>;
}
//#endregion
//#region src/drivers/loomy/upstream.d.ts
type LoomyChatResult = BridgeChatResult;
/** Wire effort spellings the Loomy catalog declares. */
type LoomyEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
/** One chat model the Loomy catalog describes, normalized for the adapter. */
interface LoomyModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  reasoning?: LoomyModelReasoning;
}
/** Reasoning metadata declared for one model. */
interface LoomyModelReasoning {
  supports: boolean;
  /** Selectable wire effort values, e.g. `['none','low','medium','high','xhigh']`. */
  supportedEfforts: readonly LoomyEffort[];
  /** Default wire effort the platform applies. */
  defaultEffort?: LoomyEffort;
}
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyLoomyError(status: number, body: string): BridgeErrorKind;
/**
 * Normalize an OpenAI chat-completions body for the Loomy upstream: flatten
 * `tool_choice` to its string form (the object form returns 400). The
 * endpoint natively accepts `role: "developer"`, non-streaming requests, and
 * unknown fields, so nothing else is rewritten — the body otherwise passes
 * through unchanged.
 */
declare function prepareLoomyChatBody(source: string): string;
/**
 * Upstream HTTP client for the Loomy imodel backend. One instance serves the
 * whole driver; requests take the session explicitly so a desktop-app
 * re-login applies on the next call.
 */
declare class LoomyUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw (SSE) response. */
  chatStream(session: LoomySession, bodyJson: string, signal?: AbortSignal): Promise<LoomyChatResult>;
  /** GET the model catalog; chat models only, normalized for the adapter. */
  fetchModels(session: LoomySession): Promise<readonly LoomyModelInfo[]>;
}
//#endregion
//#region src/drivers/loomy/catalog.d.ts
/** One model entry the adapter exposes. */
type LoomyModelEntry = LoomyModelInfo;
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
declare const FALLBACK_LOOMY_MODELS: readonly LoomyModelEntry[];
/** Mutable Loomy catalog seeded with the fallback roster. */
declare class LoomyCatalog extends Catalog<LoomyModelEntry> {
  constructor();
}
//#endregion
//#region src/drivers/loomy/adapter.d.ts
/** Constructor dependencies. */
interface LoomyAdapterOptions {
  shim: BridgeShim;
  /** Not read on the request path (auth rides the shim secret); kept for assembly parity. */
  store: LoomySessionStore;
  catalog: LoomyCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
}
/** What {@link createLoomyAdapter} hands back. */
type LoomyAdapter = BridgeAdapter;
/** Assemble the Loomy adapter through the core seam. */
declare function createLoomyAdapter(options: LoomyAdapterOptions): LoomyAdapter;
//#endregion
//#region src/drivers/loomy/shim.d.ts
/** What the plugin needs from a running shim. */
type LoomyShim = BridgeShim;
/** Constructor dependencies. */
interface LoomyShimOptions {
  store: LoomySessionStore;
  client: Pick<LoomyUpstreamClient, 'chatStream'>;
  catalog: LoomyCatalog;
  logger?: ShimLogger;
}
/** Start the Loomy loopback endpoint. */
declare function createLoomyShim(options: LoomyShimOptions): LoomyShim;
//#endregion
//#region src/drivers/loomy/heartbeat.d.ts
/** Basename of the host heartbeat file inside the Harness home. */
declare const LOOMY_HOST_HEARTBEAT_FILENAME = ".loomy-host-heartbeat.json";
/** On-disk shape of the heartbeat. */
type LoomyHostHeartbeat = HostHeartbeat;
/** Absolute path of the host heartbeat file. */
declare const loomyHostHeartbeatPath: () => string;
//#endregion
//#region src/drivers/loomy/status-paths.d.ts
/** Plugin-owned status endpoint consumed by the Loomy browser card. */
declare const LOOMY_STATUS_PATH = "/plugins/dsh-llm-bridge/loomy/status";
/** The JSON document the Loomy plugin card renders (the generic shape). */
type LoomyWebStatus = DriverWebStatus;
//#endregion
//#region src/drivers/loomy/web-status.d.ts
/** Constructor dependencies. */
interface LoomyStatusRouteOptions {
  store: LoomySessionStore;
}
/** Assemble the card's status document. */
declare function loomyWebStatus(deps: LoomyStatusRouteOptions): Promise<LoomyWebStatus>;
/** The status route's request handler, extracted so tests can mount it bare. */
declare function loomyStatusHandler(deps: LoomyStatusRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** Mount the GET status route on an optional webServer context. */
declare function registerLoomyStatusRoute(ctx: Context, deps: LoomyStatusRouteOptions): void;
//#endregion
//#region src/index.d.ts
/** Plugin configuration: one optional section per driver. */
interface Config {
  workbuddy?: Config$2;
  loomy?: Config$1;
}
declare const Config: z<Config>;
/** Stable Cordis plugin name. */
declare const name = "llm-bridge";
/** The model registry required before either provider can register. */
declare const inject: string[];
/**
 * Compose the core mechanisms with every shipped driver and register their
 * providers (`workbuddy`, `loomy`). Streaming, tool calls, compaction, and
 * permissions stay Harness-owned.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, FALLBACK_LOOMY_MODELS, FALLBACK_WORKBUDDY_MODELS, LOOMY_DISPLAY_NAME, LOOMY_HOST_HEARTBEAT_FILENAME, LOOMY_PROVIDER, LOOMY_SESSION_FILENAME, LOOMY_SESSION_FILE_ENV, LOOMY_SETTINGS_NS, LOOMY_STATUS_PATH, LOOMY_STREAM_IDLE_TIMEOUT_MS, type LoomyAdapter, type LoomyAdapterOptions, type LoomyAuthStatus, LoomyCatalog, type LoomyChatResult, Config$1 as LoomyDriverConfig, type LoomyEffort, type LoomyHostHeartbeat, type LoomyModelEntry, type LoomyModelInfo, type LoomyModelReasoning, type LoomySession, LoomySessionStore, type LoomyShim, type LoomyShimOptions, type LoomyStatusRouteOptions, LoomyUpstreamClient, type LoomyWebStatus, type UpstreamErrorKind, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_DISPLAY_NAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STATUS_PATH, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, type WorkBuddyAdapter, type WorkBuddyAdapterOptions, type WorkBuddyAuthStatus, WorkBuddyCatalog, type WorkBuddyChatResult, type Config$2 as WorkBuddyConfig, type WorkBuddyCredential, WorkBuddyCredentialStore, type WorkBuddyCredits, type WorkBuddyEffort, type WorkBuddyHostHeartbeat, type WorkBuddyModelBilling, type WorkBuddyModelInfo, type WorkBuddyModelReasoning, type WorkBuddyRefreshOutcome, type WorkBuddyShim, type WorkBuddyShimOptions, type WorkBuddyStatusRouteOptions, type WorkBuddyStoreOptions, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyWebStatus, apply, applyLoomyPlugin, applyWorkBuddyPlugin, classifyLoomyError, classifyUpstreamError, clearHostHeartbeat, createLoomyAdapter, createLoomyShim, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, defaultSessionCandidates, defaultSessionPath, inject, isHeartbeatProcessAlive, loomyHostHeartbeatPath, loomyStatusHandler, loomyWebStatus, name, normalizeCredits, parseLoomySession, parseWorkBuddyAuth, prepareChatBody, prepareLoomyChatBody, processStartTimeMs, readHostHeartbeat, regionOf, registerLoomyStatusRoute, registerWorkBuddyStatusRoute, workBuddyStatusHandler, workBuddyWebStatus, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath };