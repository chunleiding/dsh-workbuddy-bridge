/** WorkBuddy status card contributed to Harness Plugin configuration. */

import { DriverStatusCard } from '../../../core/client/status-card.tsx'
import type { CardT } from '../../../core/client/status-card.tsx'
import { WORKBUDDY_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddySettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyPluginCardProps = WorkBuddyPluginCardInjected

/** Localize the upstream's own promo badge spellings. */
function localizeBadge(badge: string, t: WorkBuddyPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  return badge
}

/** Render the WorkBuddy card over the generic driver card. */
export function WorkBuddyPluginCard({ t }: WorkBuddyPluginCardProps): React.ReactNode {
  return (
    <DriverStatusCard
      t={t as CardT}
      statusPath={WORKBUDDY_STATUS_PATH}
      localizeBadge={badge => localizeBadge(badge, t)}
    />
  )
}
