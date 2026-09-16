/**
 * Qoder driver descriptor for the shared status/diagnostics CLI.
 *
 * There is no plugin-owned credential file for this driver — the Qoder app's
 * own auth directory is authoritative — so `ownPath()` reports undefined and
 * `logout` has nothing of ours to remove.
 *
 * @module dsh-llm-bridge/drivers/qoder/cli
 */

import { QoderCredentialStore } from './auth.ts'
import { FALLBACK_QODER_MODELS } from './catalog.ts'
import { qoderHostHeartbeatPath, readHostHeartbeat } from './heartbeat.ts'
import { QoderUpstreamClient } from './upstream.ts'
import type { DriverCli } from '../workbuddy/cli.ts'

/** The Qoder CLI descriptor. */
export const qoderCli: DriverCli = {
  id: 'qoder',
  displayName: 'Qoder',
  fallbackModelCount: FALLBACK_QODER_MODELS.length,
  credentialFileLabel: 'Desktop credential file',
  signedOutHint: 'Sign in once in the Qoder app, then run status again.',
  heartbeat: {
    path: qoderHostHeartbeatPath,
    read: async () => await readHostHeartbeat(),
  },
  makeStore() {
    const client = new QoderUpstreamClient()
    const store = new QoderCredentialStore({ refresh: credential => client.refreshToken(credential) })
    return {
      view: {
        status: () => store.status(),
        filePresent: () => store.authDirPresent(),
        filePath: () => store.credentialPath(),
        ownPath: () => undefined,
        logout: () => store.logout(),
      },
    }
  },
}
