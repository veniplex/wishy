import type de from '../de/inbox'

const en: Record<keyof typeof de, string> = {
  'title': 'Inbox',
  'sub': 'Ideas without a person, e.g. captured via a Shortcut. Assign them to someone – or create a new person right there.',
  'assign': 'Assign …',
  'assignAria': 'Assign “{title}” to a person',
  'openLink': 'Open link',
  'delete.label': 'Delete “{title}”',
  'delete.title': 'Delete idea?',
  'delete.text': '“{title}” is removed from the inbox.',
  'delete.confirm': 'Delete',
  'notice.text_one': 'Inbox: {count} idea to assign',
  'notice.text_other': 'Inbox: {count} ideas to assign',
  'notice.action': 'Open inbox',
  'badge': 'Inbox',
  'later': 'Assign later (inbox)',
  'laterHint': 'Without a person the idea lands in the inbox under Give › Ideas.',
}

export default en
