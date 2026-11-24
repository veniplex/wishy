/** Extended user fields from the server (profile picture, two-factor, identities). They live next to `User` in api.ts until that type carries them itself. */
import type { Identity, TwoFactorSummary, User } from './api'
import { useAuth } from './auth'

export type { Identity, TwoFactorSummary }
export type UserX = User
/** Signed-in user with the extended fields */
export const useUserX = () => useAuth().user as UserX | null

export interface PasskeyInfo { id: string; name: string; created_at: string; last_used_at: string | null; device_type: string | null; backed_up: boolean; passwordless: boolean | null }
export interface TwoFactorStatus extends TwoFactorSummary {
  passkey_list: PasskeyInfo[]
  policy: 'optional' | 'required'
  must_setup: boolean
  recovery_codes?: string[]
}
