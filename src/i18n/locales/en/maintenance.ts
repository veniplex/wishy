import type de from '../de/maintenance'

const en: Record<keyof typeof de, string> = {
  'title.maintenance': 'Maintenance in progress',
  'title.updating': 'Wishy is updating',
  'title.restoring': 'Restoring a backup',
  'title.starting': 'Wishy is starting',
  'title.restart_required': 'Restart required',
  'title.failed': 'Wishy is currently unavailable',
  'sub': 'This will only take a moment. The page reloads automatically.',
  'subFailed': 'This page keeps retrying. Check the installation log if it takes longer.',
  'waiting': 'Waiting for Wishy …',
  'reconnecting': 'Connection lost – trying again …',
  'target': 'Version {version}',
  'restart.title': 'Wishy needs a restart',
  'restart.admin': 'The backup "{source}" is prepared and will be applied the next time Wishy starts. Restart Wishy now (stop the process and start it again, for example npm start). This page reloads by itself afterwards.',
  'restart.others': 'An administrator is restoring a backup. Wishy will be back shortly – this page reloads automatically.',
  'restart.cancel': 'Cancel restore',
  'updatedNotice': 'Wishy was updated. Please sign in again.',
  'restoredNotice': 'Wishy was serviced. Please sign in again.',
  'swap': 'The container is being swapped – the connection drops briefly. This is normal and usually takes less than a minute.',
  'longer': 'This takes longer than usual. Wishy keeps trying. If it does not help, check the container log (docker compose logs wishy) or open /__launcher/recovery.',
}
export default en
