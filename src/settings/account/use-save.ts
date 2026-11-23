import { useState, type FormEvent } from 'react'
import { errMsg } from '../../api'
import { t } from '../../i18n'
import { useToast } from '../../ui'
import { isReauthCancelled } from '../security/reauth'

/** Small form with loading state, error and "Saved" feedback (shared by all sections of the Account tab) */
export function useSave(action: () => Promise<void>, doneText: string = t('account.saved')) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await action()
      toast(doneText, 'ok')
    } catch (err) {
      if (!isReauthCancelled(err)) setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}
