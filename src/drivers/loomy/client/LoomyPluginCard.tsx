/** Loomy status card contributed to Harness Plugin configuration. */

import { DriverStatusCard } from '../../../core/client/status-card.tsx'
import type { CardT } from '../../../core/client/status-card.tsx'
import { LOOMY_STATUS_PATH } from '../status-paths.ts'
import type { LoomySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface LoomyPluginCardInjected {
  t: (key: LoomySettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the Plugin configuration item slot. */
export type LoomyPluginCardProps = LoomyPluginCardInjected

/** Render the Loomy card as a thin wrapper over the generic driver card. */
export function LoomyPluginCard({ t }: LoomyPluginCardProps): React.ReactNode {
  return (
    <DriverStatusCard
      t={t as CardT}
      statusPath={LOOMY_STATUS_PATH}
    />
  )
}
