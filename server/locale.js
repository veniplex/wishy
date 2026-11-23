// Language for server-created default texts (default names, demo data). Error messages are English (the client translates by `code`).
import { db } from './db.js'
import { LOCALES, defaultLocale } from './config.js'

/** The user's language (`users.locale`), otherwise the admin default, otherwise English. */
export function userLocale(userId) {
  const l = userId == null ? null : db.prepare('SELECT locale FROM users WHERE id=?').get(userId)?.locale
  return LOCALES.includes(l) ? l : defaultLocale()
}

const DEFAULTS = {
  de: { personalSpace: 'Privat', wishlist: 'Meine Wunschliste', birthday: 'Geburtstag' },
  en: { personalSpace: 'Private', wishlist: 'My wishlist', birthday: 'Birthday' },
}
export const defaultName = (locale, key) => (DEFAULTS[locale] ?? DEFAULTS.en)[key]
