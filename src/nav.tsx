import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { CalendarDays, EyeOff, Sparkles, Gift, Heart, House, Lightbulb, LogOut, Monitor, Moon, Plus, Settings as SettingsIcon, ShieldCheck, Sun, type LucideIcon } from 'lucide-react'
import { useStore } from './store'
import { rememberNext, useAuth } from './auth'
import { SpaceButton } from './spaces'
import { UserPictureOverlay } from './user-avatar'
import { Badge, Brand, Button, IconButton, Menu, MenuItem, Modal, type TabItem } from './ui'
import { themeModes, useTheme } from './theme'
import { useFeatures } from './features'
import { PersonPicker } from './pickers'
import { t, useT, type TKey } from './i18n'
import { useUpdateAvailability } from './update-banner'

/** Tabs under "Wishlists"; "Shared with me" shows newly shared lists as a badge */
export const listTabs = (unseen: number): TabItem[] => [
  { to: '/wishlists', label: t('nav.tabs.lists.mine'), end: true },
  { to: '/wishlists/shared', label: <span className="inline-flex items-center gap-2">{t('nav.tabs.lists.shared')}{unseen > 0 && <Badge tone="accent">{unseen}</Badge>}</span> },
]
/** Tabs under "Gifting" (the expenses tab needs the `view_expenses` permission) */
export const giveTabs = (expenses = true): TabItem[] => [
  { to: '/gifting', label: t('nav.tabs.give.who'), end: true },
  { to: '/gifting/ideas', label: t('nav.tabs.give.ideas') },
  { to: '/gifting/gifts', label: t('nav.tabs.give.gifts') },
  ...(expenses ? [{ to: '/gifting/expenses', label: t('nav.tabs.give.expenses') }] : []),
]

const NAV: { to: string; label: TKey; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'nav.main.home', icon: House, end: true },
  { to: '/wishlists', label: 'nav.main.lists', icon: Heart },
  { to: '/gifting', label: 'nav.main.give', icon: Gift },
  { to: '/calendar', label: 'nav.main.calendar', icon: CalendarDays },
]

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon }

/** Privacy: choose people whose gifts and ideas are hidden everywhere */
function ProtectionDialog({ onClose }: { onClose: () => void }) {
  const { hidden, setHidden, activePersons } = useStore()
  return (
    <Modal compact title={t('nav.privacy.title')} onClose={onClose} footer={<><span className="flex-1" /><Button variant="primary" onClick={onClose}>{t('common.done')}</Button></>}>
      <p className="text-sm text-muted">{t('nav.privacy.intro')}</p>
      <PersonPicker label={t('nav.privacy.personsLabel')} create={false} persons={activePersons.filter((p) => !p.is_me)} value={hidden} onChange={setHidden} />
    </Modal>
  )
}

/** Icon buttons of the header (tooltip + aria-label via IconButton); slightly smaller on smartphones */
const BAR_BTN = 'icon-btn-surface max-sm:!size-10'

function PrivacyButton({ onClick }: { onClick: () => void }) {
  const { hidden } = useStore()
  const on = hidden.length > 0
  return (
    <IconButton
      icon={EyeOff}
      label={on ? t('nav.top.privacyActive', { count: hidden.length }) : t('nav.top.privacy')}
      aria-pressed={on}
      className={`${BAR_BTN} ${on ? '!bg-accent !text-accent-ink' : ''}`}
      onClick={onClick}
    />
  )
}

function ThemeButton() {
  const [mode, , next] = useTheme()
  const label = themeModes().find((m) => m.value === mode)!.label
  return <IconButton icon={THEME_ICON[mode]} label={t('nav.top.themeHint', { mode: label })} aria-label={t('nav.top.themeAria', { mode: label })} className={BAR_BTN} onClick={next} />
}

function NewMenu() {
  const { s, open } = useStore()
  const f = useFeatures()
  const aiImport = f.ai && (f.aiFeatures.text_import || f.aiFeatures.image_import)
  return (
    <Menu
      trigger={(p) => <IconButton icon={Plus} label={t('nav.top.new')} aria-label={t('nav.top.newAria')} className="!bg-accent !text-accent-ink hover:brightness-110 shadow-accent max-sm:!size-10" {...p} />}
    >
      {(close) => (
        <>
          <MenuItem icon={Heart} tint={5} label={t('nav.new.wish')} onClick={() => { close(); open({ type: 'wish' }) }} />
          {s.permissions.manage_gifts && <MenuItem icon={Lightbulb} tint={2} label={t('nav.new.idea')} onClick={() => { close(); open({ type: 'item' }) }} />}
          {s.permissions.manage_gifts && <MenuItem icon={Gift} tint={1} label={t('nav.new.gift')} onClick={() => { close(); open({ type: 'gift' }) }} />}
          {aiImport && <MenuItem icon={Sparkles} tint={3} label={t('nav.new.aiImport')} onClick={() => { close(); open({ type: 'ai-import' }) }} />}
        </>
      )}
    </Menu>
  )
}

function AvatarMenu() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const { version: updateVersion } = useUpdateAvailability()
  const initials = (user?.name ?? '?').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase()
  return (
    <Menu
      trigger={(p) => (
        <>
          <button type="button" {...p} aria-label={t('nav.avatar.aria')} title={t('nav.avatar.aria')} className="relative overflow-hidden size-11 max-sm:size-10 rounded-full font-bold text-sm text-ink cursor-pointer hover:brightness-95 shrink-0" style={{ background: 'var(--t5)' }}>{initials}{user?.avatar_url ? <UserPictureOverlay userId={user.id} src={user.avatar_url} /> : null}</button>
          {updateVersion && <span aria-hidden className="absolute top-0 right-0 size-3 rounded-full bg-accent ring-2 ring-bg pointer-events-none" />}
        </>
      )}
    >
      {(close) => (
        <>
          <div className="px-3.5 py-2.5">
            <div className="font-semibold truncate">{user?.name}</div>
            <div className="meta truncate">{user?.email}</div>
          </div>
          <MenuItem icon={SettingsIcon} tint={4} label={t('nav.avatar.settings')} to="/settings" onClick={close} />
          {user?.role === 'admin' && <MenuItem icon={ShieldCheck} tint={3} label={t('nav.avatar.admin')} hint={updateVersion ? t('update.menu.hint') : undefined} to="/admin" onClick={close} />}
          <MenuItem icon={LogOut} tint={1} label={t('nav.avatar.logout')} onClick={async () => { close(); await logout(); rememberNext('/') /* RequireAuth remembers the old page on sign-out – reset it after signing out */; nav('/login', { replace: true }) }} />
        </>
      )}
    </Menu>
  )
}

/** Header: logo, space, icon buttons (New, Privacy, Theme), account; below it (tablet and up) the main navigation as pills */
export function TopBar() {
  useT()
  const { appName, sharedUnseen } = useAuth()
  const [prot, setProt] = useState(false)
  return (
    <header className="mx-auto w-full max-w-[1120px] px-4 md:px-10 pt-3 md:pt-6 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Link to="/" aria-label={t('nav.brand.home', { appName })} className="min-w-0"><Brand name={appName} /></Link>
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <SpaceButton />
          <NewMenu />
          <PrivacyButton onClick={() => setProt(true)} />
          <ThemeButton />
          <AvatarMenu />
        </div>
      </div>
      <nav aria-label={t('nav.main.label')} className="hidden md:flex gap-1.5 p-1.5 bg-card rounded-full shadow-sm">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link flex-1 justify-center min-h-12 ${isActive ? 'nav-link-on' : ''}`}>
            <n.icon size={20} strokeWidth={2} /> {t(n.label)}
            {n.to === '/wishlists' && sharedUnseen > 0 && <Badge tone="accent">{sharedUnseen}</Badge>}
          </NavLink>
        ))}
      </nav>
      {prot && <ProtectionDialog onClose={() => setProt(false)} />}
    </header>
  )
}

/** Mobile bottom tab bar (safe-area aware) */
export function BottomTabs() {
  useT()
  const { sharedUnseen } = useAuth()
  return (
    <nav aria-label={t('nav.main.label')} className="md:hidden fixed z-30 bottom-0 inset-x-0 flex gap-1 px-2 pt-2 bg-card rounded-t-[26px] shadow-pop pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `flex-1 min-w-0 flex flex-col items-center gap-0.5 py-1 text-xs font-semibold ${isActive ? 'text-accent' : 'text-muted'}`}>
          {({ isActive }) => (
            <>
              <span className={`relative grid place-items-center h-8 w-14 rounded-full ${isActive ? 'bg-soft' : ''}`}>
                <n.icon size={22} strokeWidth={2} />
                {n.to === '/wishlists' && sharedUnseen > 0 && <span className="absolute top-0.5 right-2 size-2.5 rounded-full bg-accent" aria-label={t('nav.main.newShared')} />}
              </span>
              {t(n.label)}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
