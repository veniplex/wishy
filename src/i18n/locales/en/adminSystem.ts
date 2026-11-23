import type de from '../de/adminSystem'

const en: Record<keyof typeof de, string> = {
  'refresh': 'Refresh',
  'version': 'Version',
  'versionHint': 'of this running installation',
  'health.title': 'Health',
  'health.ok': 'Healthy',
  'health.fail': 'Failing',
  'health.hint': '/healthz checks that the process responds, /readyz also checks the database. Both are reachable without signing in (for proxies and Docker).',
  'health.checked': 'Checked at {time}.',
}

export default en
