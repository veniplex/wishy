import type de from '../de/adminUsers'

const en: Record<keyof typeof de, string> = {
  'twoFactorOn': '2FA',
  'reset2fa': 'Reset 2FA for {name}',
  'reset2faTitle': 'Reset 2FA for {name}?',
  'reset2faText': 'The authenticator app, passkeys and recovery codes are deleted and all of this person’s sessions are ended. Next time they sign in, the password is enough (or they must set up a new second factor if it is required).',
  'reset2faConfirm': 'Reset 2FA',
  'reset2faDone': '2FA reset',
  'features': 'Features',
  'featuresHint': 'Default follows the global setting (Admin › AI or API).',
  'ai': 'AI',
  'api': 'API',
  'default': 'Default',
  'on': 'On',
  'off': 'Off',
  'aiOff': 'AI off',
  'apiOff': 'API off',
}
export default en
