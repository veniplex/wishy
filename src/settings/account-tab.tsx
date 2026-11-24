import { useSearchParams } from 'react-router-dom'
import { CircleAlert } from 'lucide-react'
import { loginError } from '../api'
import { Banner } from '../ui'
import { ProfileSection } from './account/profile'
import { EmailSection } from './account/email'
import { PasswordSection } from './account/password'
import { TwoFactorSection } from './account/two-factor'
import { LoginMethodsSection } from './account/login-methods'
import { SessionsSection } from './account/sessions'
import { OfflineSection } from './account/offline'

/**
 * Settings › Account. Only the order of the sections - each section is its own file in ./account/
 * (profile, email, password, two-factor [slot], login methods, sessions [slot], offline & app); new features belong there, not here.
 */
export function AccountTab() {
  const [sp] = useSearchParams()
  const err = loginError(sp.get('error'))
  return (
    <>
      {err && <Banner tone="bad" icon={CircleAlert}>{err}</Banner>}
      <ProfileSection />
      <OfflineSection />
      <EmailSection />
      <PasswordSection />
      <TwoFactorSection />
      <LoginMethodsSection />
      <SessionsSection />
    </>
  )
}
