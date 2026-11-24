import type { ReactNode } from 'react'
import { Hourglass, Lock } from 'lucide-react'
import { useAuth } from '../auth'
import { t, type TKey } from '../i18n'
import { Button, EmptyState, Page } from '../ui'

/** Administrators only */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Page><EmptyState icon={Lock} action={<Button size="sm" to="/">{t('common.toOverview')}</Button>}>{t('admin.onlyAdmins')}</EmptyState></Page>
  return <>{children}</>
}

/** Header of an admin section: title, subtitle, primary action on the right */
export function SectionHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="h2 text-2xl md:text-3xl text-balance">{title}</h2>
        {sub && <p className="text-muted text-sm md:text-[15px] mt-1">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** "Coming soon" placeholder for sections that are yet to be filled. `what` describes in one sentence what will appear here. */
export function ComingSoon({ title, sub, what }: { title: TKey; sub?: TKey; what: TKey }) {
  return (
    <div className="flex flex-col gap-8">
      <SectionHead title={t(title)} sub={sub ? t(sub) : undefined} />
      <EmptyState icon={Hourglass}><strong className="text-ink font-medium">{t('admin.soon.title')}</strong><br />{t(what)}</EmptyState>
    </div>
  )
}

