import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/bricolage-grotesque'
import App from './App'
import { captureInstallPrompt } from './offline/install'
import { startSync } from './offline/sync'
import { registerServiceWorker } from './offline/sw-register'
import './index.css'

captureInstallPrompt()
registerServiceWorker()
startSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
