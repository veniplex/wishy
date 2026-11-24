/** Pure helpers of the detail views of ideas, gifts and wishes (no DOM, no React) */

/** A link that is safe to render as an anchor: only http(s); `host` is the domain without "www." */
export function linkInfo(raw: string | null | undefined): { href: string; host: string } | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { href: u.href, host: u.hostname.replace(/^www\./, '') }
  } catch {
    return null
  }
}

/** An idea is not decided yet (table `items`), a gift is planned or decided (table `gifts`) */
export type EntryKind = 'idea' | 'gift'
