import { useEffect, useState, type ReactNode } from 'react'
import { EyeOff, Hourglass, Lock, CircleAlert, MoreHorizontal, type LucideIcon } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { t, useT, type TKey } from '../i18n'
import { Banner, Button, EmptyState, IconButton, Menu, MenuItem, Page, useConfirm, useDesktopChrome } from '../ui'

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


/**
 * Warning on pages that show IP addresses: X-Forwarded-For arrives but the proxy is not trusted, so every entry carries the proxy's
 * address. Uses the same detection as the diagnostics (Admin › General) and links to the setting.
 */
export function ProxyIpWarning() {
  useT()
  const [on, setOn] = useState(false)
  useEffect(() => {
    api<{ warnings: { code: string }[] }>('GET', '/api/admin/diagnostics/proxy')
      .then((d) => setOn(d.warnings.some((w) => w.code === 'forwarded_for_untrusted' || w.code === 'forwarded_untrusted_recent')))
      .catch(() => {})
  }, [])
  if (!on) return null
  return <Banner tone="warn" icon={CircleAlert} action={<Button size="sm" to="/admin/general">{t('audit.proxy.link')}</Button>}>{t('audit.proxy.warn')}</Banner>
}

/**
 * Surprise protection (see server/audit.js): entries about claims on the admin's own wishlists are hidden. Shows how many, and lets the
 * admin reveal them deliberately (confirm first; the server logs the reveal). `revealed` = they are currently shown.
 */
export function HiddenOwnBanner({ hidden, revealed, onReveal, onHide }: { hidden: number; revealed: boolean; onReveal: () => void; onHide: () => void }) {
  useT()
  const confirm = useConfirm()
  if (revealed) return <Banner tone="warn" icon={EyeOff} action={<Button size="sm" onClick={onHide}>{t('audit.hidden.hide')}</Button>}>{t('audit.hidden.revealed')}</Banner>
  if (hidden <= 0) return null
  const ask = async () => {
    if (await confirm({ title: t('audit.hidden.confirmTitle'), text: t('audit.hidden.confirmText'), confirmLabel: t('audit.hidden.confirmLabel'), destructive: true })) onReveal()
  }
  return <Banner tone="info" icon={EyeOff} action={<Button size="sm" onClick={ask}>{t('audit.hidden.reveal')}</Button>}>{t('audit.hidden', { count: hidden })}</Banner>
}

/** A clickable IP address (filters the list by it). Compact, monospace. */
export function IpButton({ ip, onPick, className = '' }: { ip: string | null; onPick: (ip: string) => void; className?: string }) {
  if (!ip) return <span className={`meta font-mono text-xs ${className}`}>–</span>
  return (
    <button type="button" onClick={() => onPick(ip)} title={t('audit.ip.filterBy', { ip })} className={`font-mono text-xs text-muted hover:text-ink hover:underline underline-offset-2 rounded px-1 -mx-1 break-all text-left pointer-coarse:min-h-11 pointer-coarse:inline-flex pointer-coarse:items-center ${className}`}>
      {ip}
    </button>
  )
}

export interface RowAction { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }

/**
 * Row actions of the admin lists. Desktop: icon buttons as before (label = tooltip). Phones: one "…" button that opens a sheet with labelled
 * entries, so destructive actions are never an unlabelled icon next to routine ones. `primary` stays visible as an icon on phones as well.
 */
export function RowActions({ actions }: { actions: (RowAction | false | null | undefined)[] }) {
  useT()
  const desktop = useDesktopChrome()
  const list = actions.filter(Boolean) as RowAction[]
  if (desktop) return <>{list.map((a) => <IconButton key={a.label} icon={a.icon} size="sm" variant={a.danger ? 'danger' : 'default'} label={a.label} disabled={a.disabled} onClick={a.onClick} />)}</>
  return (
    <Menu width={320} trigger={(p) => <Button size="sm" icon={MoreHorizontal} {...p}>{t('admin.rowActions')}</Button>}>
      {(close) => list.map((a) => <MenuItem key={a.label} icon={a.icon} label={a.label} danger={a.danger} onClick={() => { close(); if (!a.disabled) a.onClick() }} />)}
    </Menu>
  )
}

/**
 * Save button of the long admin forms. On phones it floats above the tab bar as soon as something changed ("dirty"), so it stays in reach
 * without scrolling to the end of the form; desktop and unchanged forms keep the plain button at the end.
 */
export function SaveBar({ dirty, busy, label }: { dirty: boolean; busy?: boolean; label: string }) {
  useT()
  return (
    <div className={dirty ? 'max-md:sticky max-md:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-md:z-20 max-md:flex max-md:items-center max-md:gap-3 max-md:rounded-2xl max-md:bg-card max-md:p-3 max-md:shadow-pop max-md:border max-md:border-line' : ''}>
      {dirty && <span className="md:hidden flex-1 min-w-0 text-sm text-muted">{t('admin.unsaved')}</span>}
      <Button variant="primary" type="submit" disabled={busy}>{label}</Button>
    </div>
  )
}
