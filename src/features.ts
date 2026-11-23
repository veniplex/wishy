import { useAiStatus } from './ai'
import { useAuth } from './auth'

/**
 * Which optional features are available to the current user? The ONLY place that decides
 * whether entry points (menu items, tabs, buttons) appear – if something is off, it is hidden, not disabled.
 *
 *  - google: Sign-in with Google is on (public: providers.google)
 *  - ai:     AI is globally enabled AND allowed for the user (me.user.features.ai)
 *  - aiFeatures: which AI features in detail (link/text/image import, suggestions); all false when ai is off
 *  - api:    API keys are enabled for the user (me.user.features.api must be true)
 *
 * Add new switches here and read them everywhere via `useFeatures()`.
 */
export function useFeatures() {
  const { user, providers } = useAuth()
  const ai = useAiStatus() // already takes me.user.features.ai into account
  return {
    google: !!providers?.google,
    ai: ai.enabled,
    aiFeatures: ai.features,
    api: user?.features.api === true,
  }
}
