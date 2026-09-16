/**
 * WorkBuddy driver descriptor for the shared status/diagnostics CLI.
 *
 * @module dsh-llm-bridge/drivers/workbuddy/cli
 */

import { WorkBuddyCredentialStore } from './auth.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { FALLBACK_WORKBUDDY_MODELS } from './catalog.ts'
import type { WorkBuddyCredentialStore as StoreType } from './auth.ts'
import { readHostHeartbeat, workbuddyHostHeartbeatPath } from './heartbeat.ts'
import type { HostHeartbeat } from '../../core/heartbeat.ts'

/** Uniform store view the CLI dispatcher consumes. */
export interface DriverCliStoreView {
  status(): Promise<{ state: 'signed-in' | 'signed-out'; expiresAtMs?: number; updatedAtMs?: number; nickname?: string }>
  filePresent(): Promise<boolean>
  filePath(): string | undefined
  ownPath(): string | undefined
  logout(): Promise<void>
}

/** Everything the shared CLI needs from one driver. */
export interface DriverCli {
  id: string
  displayName: string
  fallbackModelCount: number
  credentialFileLabel: string
  signedOutHint: string
  /** Host-bundle heartbeat reader for health diagnostics. */
  heartbeat: {
    path(): string
    read(): Promise<HostHeartbeat | undefined>
  }
  makeStore(): {
    view: DriverCliStoreView
    /** Live remaining-quota number; platforms without a balance endpoint omit this. */
    fetchCreditsTotal?: () => Promise<number>
  }
}

function storeView(store: StoreType): DriverCliStoreView {
  return {
    status: () => store.status(),
    filePresent: () => store.desktopFilePresent(),
    filePath: () => store.desktopAuthPath(),
    ownPath: () => store.ownAuthPath(),
    logout: () => store.logout(),
  }
}

/** The WorkBuddy CLI descriptor. */
export const workbuddyCli: DriverCli = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  fallbackModelCount: FALLBACK_WORKBUDDY_MODELS.length,
  credentialFileLabel: 'Desktop auth file',
  signedOutHint: 'Sign in once in the WorkBuddy desktop app, then run status again.',
  heartbeat: {
    path: workbuddyHostHeartbeatPath,
    read: async () => await readHostHeartbeat(),
  },
  makeStore() {
    const client = new WorkBuddyUpstreamClient()
    const store = new WorkBuddyCredentialStore({ refresh: credential => client.refreshToken(credential) })
    return {
      view: storeView(store),
      fetchCreditsTotal: async () => {
        const credential = await store.current()
        if (credential === undefined) throw new Error('signed out')
        return (await client.fetchCredits(credential)).total
      },
    }
  },
}
