# i18n (German + English)

A small home-grown solution without a library: `src/i18n/index.ts`. **German is the source of truth** – a missing English
key is a **compile error** (`npx tsc --noEmit`). The fallback locale for new installs is English.

## Usage

```tsx
import { t, useT, fmtMoney } from '../i18n'

t('nav.top.new')                                  // key = <namespace>.<key>, type-checked
t('admin.users.lastSeen', { when: '…' })          // parameters: {name} in the text
t('common.rel.inDays', { count: 3 })              // plural (see below)
const t = useT()                                  // preferred in components: re-renders on language change
```

A language change rebuilds the page tree below the sign-in (`LocaleBoundary` in `App.tsx`); that is why the module-wide `t()`
also works (e.g. in lists built while rendering). **Do not evaluate `t()` at module import time**
(`const X = t(...)` at file level) – the language from load time would stick; build lists as a function/component instead.

## Files and namespaces

`src/i18n/locales/{de,en}/<namespace>.ts` – one file per namespace and language, a flat object:

```ts
// de/nav.ts  (source)                     // en/nav.ts
export default { 'top.new': 'Neu' } as const   import type de from '../de/nav'
                                               const en: Record<keyof typeof de, string> = { 'top.new': 'New' }
                                               export default en
```

Existing: `common`, `nav`, `settings`, `account`, `admin`, `auth`, `security`, `adminAuth`, `adminGeneral`, `adminUsers`,
`adminSystem`, `errors`, `controls`, `start`, `give`, `calendar`, `gifts`, `finance`, `status`, `spaces`, `ai`, `wishlists`,
`forms`, `audit`, `apiKeys`, `apiDocs`, `aiUsage`, `aiPrompts`, `inbox`, `backup`, `update`, `maintenance`, `offline`.

**Adding a namespace:** create `de/<ns>.ts` and `en/<ns>.ts`, then add one import and one entry each in `de` and `en` in `index.ts`.
With several people/agents: everyone maintains only *their* namespace files.

## Keys

- Dot notation, camelCase per segment, from area to detail: `admin.users.deleteConfirm`, `settings.space.backup.export`.
- Functional group first (`title`, `sub`, field names, `…Hint`, actions); no sentences as keys. Key names are English.
- Reusable texts (Save, Cancel, Loading …) go in `common`, not duplicated per page.
- Do not concatenate sentence fragments – translate whole sentences with parameters (word order differs). Exception: emphasis with
  `<strong>` in the text is split into 2–3 partial keys (see `settings.space.backup.text*`).
- Server errors carry a `code`; `errors.<code>` maps it, with the server text as fallback.

## Plural

Suffix convention (`Intl.PluralRules`): `<key>_one`, `_other` (if needed `_zero`, `_few`, `_many`) and the parameter `count`:

```ts
'rel.inDays_one': 'in {count} Tag',  'rel.inDays_other': 'in {count} Tagen'
t('common.rel.inDays', { count: n })     // only the base key appears in the type
```

`_other` is required, `_zero` is preferred when `count === 0`. Number parameters are formatted with `fmtNumber`.

## Formats (never hard-wire `'de-DE'`)

`fmtDate(iso, withYear?)`, `fmtDateShort(iso)`, `fmtDateTime(serverTimestamp)`, `fmtIntl(date, options)`, `fmtMoney(n, currency)`,
`fmtNumber(n)`, `relative(days)` ("today", "in 5 days"), `monthNames('long'|'short')`, `weekdaysShort()`. Internally: `de → de-DE`, `en → en-GB`.

## Choosing the language

User setting (`me.user.locale`, saved via `PUT /api/account { locale }`) → remembered in the browser (`localStorage.locale`) →
browser language → admin default (`providers.default_locale`) → `en`. `setLocale()` (own choice), `setUserLocale()` and
`setServerLocale()` (from `auth.tsx`) feed the resolution; `<html lang>` follows automatically. Switchers: `LanguageSegmented`
(Settings › Appearance) and `LanguageMenu` (sign-in, public pages) in `switch.tsx`.

## English text

Natural product English (not word for word), sentence case, "you"; menu/button texts short ("Sign out", not "Log out of your account").
