import { t, useT } from '../../i18n'
import { Section } from '../../ui'
import { TwoFactorPanel } from '../security/two-factor-panel'

/** Account › Two-factor authentication (TOTP, passkeys, recovery codes); the logic lives in ../security/ */
export function TwoFactorSection() {
  useT()
  return (
    <Section title={t('account.twoFactor.title')}>
      <TwoFactorPanel />
    </Section>
  )
}
