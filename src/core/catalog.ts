/**
 * Generic mutable model catalog: seeded by the driver with its static
 * fallback list, replaced wholesale once the platform's dynamic answer
 * loads. The core never interprets an entry — only drivers know a model
 * record's shape; the shim and adapter constrain it to `{ id }`.
 *
 * @module dsh-llm-bridge/core/catalog
 */

/** A read-only list of model entries that can be replaced atomically. */
export class Catalog<M> {
  private models: readonly M[]

  constructor(initial: readonly M[]) {
    this.models = initial
  }

  /** Current entries; the fallback list until an upstream answer lands. */
  current(): readonly M[] {
    return this.models
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly M[]): void {
    this.models = [...models]
  }
}
