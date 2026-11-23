// User payload for /api/auth/me (and everywhere spaces.js meOf() is used).
import { avatarUrl, idpPictureAvailable } from './avatars.js'
import { twoFactorStatus, mustSetup2fa } from './twofactor.js'
import { effectiveFeatures } from './features.js'

export function userPublicFull(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    has_password: !!u.password_hash,
    google_linked: !!u.google_sub,
    identities: [{ provider: 'google', linked: !!u.google_sub, email: u.google_email || null, picture_available: idpPictureAvailable(u) }],
    avatar_url: avatarUrl(u),
    locale: u.locale || null,
    two_factor: twoFactorStatus(u.id),
    features: effectiveFeatures(u),
    must_setup_2fa: mustSetup2fa(u.id),
  }
}
