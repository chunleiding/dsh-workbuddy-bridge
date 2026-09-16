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

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Catalog } from './catalog.ts'
import type { BridgeShim } from './shim.ts'
import type { IdentifiedModel } from './types.ts'

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
 * them required in 0.1.1-rc.2. They bound requests to models whose pi-ai
 * descriptor declares image input; text-only models never receive images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. A bridge route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-llm-bridge: this bridge route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Constructor dependencies. */
export interface BridgeAdapterOptions<M extends IdentifiedModel> {
  /** Provider route id this bundle owns. */
  providerId: string
  /** Human-facing provider name. */
  displayName: string
  /** pi-ai apiKey credential name (diagnostics only). */
  credentialName: string
  /** Source label pi-ai attaches to the resolved loopback credential. */
  credentialSource: string
  shim: Pick<BridgeShim, 'baseUrl' | 'token'>
  catalog: Catalog<M>
  /** Build one pi-ai model descriptor for a catalog entry. */
  toModel: (info: M, baseUrl: string) => Model<Api>
  /** Rewrite a model's picker display name using its catalog entry. */
  decorateModelName?: (name: string, info: M) => string
  /** Provider idle ceiling while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createBridgeAdapter} hands back. */
export interface BridgeAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createBridgeAdapter<M extends IdentifiedModel>(options: BridgeAdapterOptions<M>): BridgeAdapter {
  const {
    providerId,
    displayName,
    credentialName,
    credentialSource,
    shim,
    catalog,
    toModel,
    decorateModelName,
    streamIdleTimeoutMs,
    resolveAttachments,
  } = options

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toModel(info, baseUrl))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: credentialName,
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: credentialSource }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const buildProfile = (): ResolvedPiAiProviderProfile => ({
    provider: providerId,
    displayName,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-llm-bridge retryPolicy'),
    configuredMaxTokens: new Map(),
    // `dsh-llm-pi-ai` reads this field unconditionally in `modelOf()`, and its
    // type marks it required. A bridge route resolves its own catalog and
    // never pre-registers a failed model, so an empty map is the correct
    // value: omitting it makes every `resolveModel()` call throw
    // "Cannot read properties of undefined (reading 'get')" on DSH >= 0.1.5.
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  })

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, buildProfile()]])

  const adapter = new CatalogPiAiAdapter(catalog, decorateModelName, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real platform
    // credential itself via the driver resolver, so the secret never reaches
    // upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, buildProfile()]])
    },
  }
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
class CatalogPiAiAdapter<M extends IdentifiedModel> extends PiAiAdapter {
  constructor(
    private readonly catalog: Catalog<M>,
    private readonly decorateModelName: ((name: string, info: M) => string) | undefined,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): M | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    if (this.decorateModelName === undefined) return models
    const decorate = this.decorateModelName
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: decorate(model.name, info) }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    if (this.decorateModelName === undefined) return resolved
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: this.decorateModelName(resolved.name, info) }
  }
}
