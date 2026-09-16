/** Qoder status card contributed to Harness Plugin configuration. */

import { DriverStatusCard } from '../../../core/client/status-card.tsx'
import type { CardT } from '../../../core/client/status-card.tsx'
import { QODER_STATUS_PATH } from '../status-paths.ts'
import type { QoderSettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface QoderPluginCardInjected {
  t: (key: QoderSettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the Plugin configuration item slot. */
export type QoderPluginCardProps = QoderPluginCardInjected

/** Render the Qoder card as a thin wrapper over the generic driver card. */
export function QoderPluginCard({ t }: QoderPluginCardProps): React.ReactNode {
  return (
    <DriverStatusCard
      t={t as CardT}
      statusPath={QODER_STATUS_PATH}
    />
  )
}
