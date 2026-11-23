import type de from '../de/nav'

const en: Record<keyof typeof de, string> = {
  'brand.home': '{appName} – Home',
  'main.label': 'Main menu',
  'main.home': 'Home',
  'main.lists': 'Wishlists',
  'main.give': 'Gifting',
  'main.calendar': 'Calendar',
  'main.newShared': 'Newly shared',

  'tabs.lists.mine': 'My lists',
  'tabs.lists.shared': 'Shared with me',
  'tabs.give.who': 'People',
  'tabs.give.ideas': 'Ideas',
  'tabs.give.gifts': 'Gifts',
  'tabs.give.expenses': 'Expenses',

  'top.new': 'New',
  'top.newAria': 'Create new',
  'top.privacy': 'Privacy',
  'top.privacyActive_one': 'Privacy – active for {count} person',
  'top.privacyActive_other': 'Privacy – active for {count} people',
  'top.theme': 'Theme: {mode}',
  'top.themeHint': 'Theme: {mode} (click to change)',
  'top.themeAria': 'Theme: {mode}. Switch between System, Light and Dark',

  'new.wish': 'Add a wish',
  'new.idea': 'Capture an idea',
  'new.gift': 'Plan a gift',
  'new.aiImport': 'Import with AI',

  'avatar.aria': 'Account and settings',
  'avatar.settings': 'Settings',
  'avatar.admin': 'Admin',
  'avatar.logout': 'Sign out',

  'privacy.title': 'Privacy',
  'privacy.intro': 'Pick people – their gifts and ideas are hidden everywhere. Totals leave them out while hidden.',
  'privacy.personsLabel': 'Hidden people',
  'privacy.banner_one': 'Privacy is on for {names} – {count} entry hidden.',
  'privacy.banner_other': 'Privacy is on for {names} – {count} entries hidden.',
  'privacy.lift': 'Turn off',
}
export default en
