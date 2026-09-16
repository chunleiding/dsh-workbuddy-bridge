/**
 * Loomy driver descriptor for the shared status/diagnostics CLI.
 *
 * @module dsh-llm-bridge/drivers/loomy/cli
 */

import { LoomySessionStore } from './auth.ts'
import { FALLBACK_LOOMY_MODELS } from './catalog.ts'
import { loomyHostHeartbeatPath, readHostHeartbeat } from './heartbeat.ts'
import type { DriverCli } from '../workbuddy/cli.ts'

/** The Loomy CLI descriptor (no balance endpoint, so no quota fetch). */
export const loomyCli: DriverCli = {
  id: 'loomy',
  displayName: 'Loomy',
  fallbackModelCount: FALLBACK_LOOMY_MODELS.length,
  credentialFileLabel: 'Desktop session file',
  signedOutHint: 'Sign in once in the Loomy desktop app, then run status again.',
  heartbeat: {
    path: loomyHostHeartbeatPath,
    read: async () => await readHostHeartbeat(),
  },
  makeStore() {
    const store = new LoomySessionStore()
    return {
      view: {
        status: () => store.status(),
        filePresent: () => store.sessionFilePresent(),
        filePath: () => store.sessionFilePath(),
        ownPath: () => undefined,
        logout: () => store.logout(),
      },
    }
  },
}
